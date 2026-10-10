import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const plans = new Map([
  [1, 399],
  [3, 1125],
  [6, 2250],
  [12, 4500],
]);

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`На сервере не настроена переменная окружения ${name}.`);
  return value;
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function yookassaAuth() {
  const credentials = `${requiredEnv("YOOKASSA_SHOP_ID")}:${requiredEnv("YOOKASSA_SECRET_KEY")}`;
  return `Basic ${btoa(credentials)}`;
}

function validReturnURL(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("QOS_BILLING_RETURN_URL должен содержать полный URL приложения.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Адрес возврата оплаты должен использовать HTTPS.");
  }
  return url.toString();
}

function amountText(amount: number) {
  return amount.toFixed(2);
}

async function createYooKassaPayment(
  payment: {
    id: string;
    organization_id: string;
    purpose: "subscription" | "topup";
    plan_months: number | null;
    amount: number;
    idempotence_key: string;
    auto_renew_requested: boolean;
    renewal_for?: string | null;
  },
  paymentMethodId?: string,
) {
  const returnURL = validReturnURL(requiredEnv("QOS_BILLING_RETURN_URL"));
  const returnToApp = new URL(returnURL);
  returnToApp.searchParams.set("qos_billing", "return");
  const body: Record<string, unknown> = {
    amount: { value: amountText(payment.amount), currency: "RUB" },
    capture: true,
    description: payment.purpose === "topup"
      ? "Пополнение баланса XVII"
      : `Подписка XVII на ${payment.plan_months} мес.`,
    metadata: {
      billing_payment_id: payment.id,
      organization_id: payment.organization_id,
    },
  };
  if (paymentMethodId) {
    body.payment_method_id = paymentMethodId;
  } else {
    body.confirmation = { type: "redirect", return_url: returnToApp.toString() };
    if (payment.auto_renew_requested) body.save_payment_method = true;
  }

  const result = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      Authorization: yookassaAuth(),
      "Content-Type": "application/json",
      "Idempotence-Key": payment.idempotence_key,
    },
    body: JSON.stringify(body),
  });
  const details = await result.json().catch(() => null);
  if (!result.ok) {
    throw new Error(`ЮKassa (${result.status}): ${details?.description || details?.type || "Не удалось создать платёж."}`);
  }
  return details;
}

async function requireMember(request: Request, ownerOnly = false) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Для оплаты требуется войти в XVII.");
  const url = requiredEnv("SUPABASE_URL");
  const anonKey = requiredEnv("SUPABASE_ANON_KEY");
  const caller = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await caller.auth.getUser(authorization.slice(7));
  if (authError || !user) throw new Error("Сеанс входа истёк. Войдите повторно.");
  const { data: member, error: memberError } = await caller
    .from("organization_members")
    .select("organization_id, role, status, permissions")
    .eq("user_id", user.id)
    .maybeSingle();
  if (memberError) throw new Error(`Не удалось проверить права: ${memberError.message}`);
  if (!member || member.status !== "active") {
    throw new Error("Учётная запись отключена или отсутствует.");
  }
  if (ownerOnly && member.role !== "owner" && member.permissions?.["billing.manage"] !== true) {
    throw new Error("У вас нет права управлять подпиской и балансом компании.");
  }
  return { organizationId: member.organization_id as string, userId: user.id, role: member.role as string };
}

async function createCheckout(
  db: ReturnType<typeof serviceClient>,
  organizationId: string,
  purpose: "subscription" | "topup",
  amount: number,
  planMonths: number | null,
  autoRenew: boolean,
) {
  const pendingSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: pendingError } = await db
    .from("billing_payments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .gte("created_at", pendingSince);
  if (pendingError) throw new Error(`Не удалось проверить ожидающие платежи: ${pendingError.message}`);
  if ((count || 0) >= 5) throw new Error("Слишком много неоплаченных счетов. Завершите оплату или повторите позже.");

  const { data: payment, error: insertError } = await db
    .from("billing_payments")
    .insert({
      organization_id: organizationId,
      purpose,
      amount,
      plan_months: planMonths,
      auto_renew_requested: autoRenew,
      idempotence_key: crypto.randomUUID(),
    })
    .select("id, organization_id, purpose, plan_months, amount, idempotence_key, auto_renew_requested")
    .single();
  if (insertError) throw new Error(`Не удалось сохранить платёж: ${insertError.message}`);

  try {
    const created = await createYooKassaPayment(payment);
    const { error: updateError } = await db
      .from("billing_payments")
      .update({ provider_payment_id: created.id })
      .eq("id", payment.id)
      .eq("status", "pending");
    if (updateError) throw new Error(`Платёж создан, но не удалось сохранить его идентификатор: ${updateError.message}`);
    const confirmationUrl = created.confirmation?.confirmation_url;
    if (typeof confirmationUrl !== "string" || !confirmationUrl.startsWith("https://")) {
      throw new Error("ЮKassa не вернула безопасную ссылку для оплаты.");
    }
    return { confirmation_url: confirmationUrl, payment_id: payment.id };
  } catch (error) {
    await db.from("billing_payments").update({ status: "failed" }).eq("id", payment.id).eq("status", "pending");
    throw error;
  }
}

async function handleNotification(body: Record<string, unknown>) {
  const event = body.event;
  const paymentObject = body.object as Record<string, unknown> | undefined;
  const providerId = typeof paymentObject?.id === "string" ? paymentObject.id : "";
  if (!providerId || !["payment.succeeded", "payment.canceled"].includes(String(event))) {
    return response({ received: true, ignored: true });
  }

  const providerResponse = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(providerId)}`, {
    headers: { Authorization: yookassaAuth() },
  });
  const verified = await providerResponse.json().catch(() => null);
  if (!providerResponse.ok || verified?.id !== providerId || verified?.status !== (event === "payment.succeeded" ? "succeeded" : "canceled")) {
    throw new Error("Не удалось подтвердить состояние платежа через API ЮKassa.");
  }

  const metadata = verified.metadata || {};
  const paymentId = typeof metadata.billing_payment_id === "string" ? metadata.billing_payment_id : "";
  const organizationId = typeof metadata.organization_id === "string" ? metadata.organization_id : "";
  if (!paymentId || !organizationId) throw new Error("В подтверждённом платеже отсутствуют данные XVII.");

  const db = serviceClient();
  const { data: payment, error: paymentError } = await db
    .from("billing_payments")
    .select("id, organization_id, purpose, plan_months, amount, status, provider_payment_id")
    .eq("id", paymentId)
    .maybeSingle();
  if (paymentError) throw new Error(`Не удалось проверить платёж XVII: ${paymentError.message}`);
  if (!payment || payment.organization_id !== organizationId || payment.provider_payment_id !== providerId) {
    throw new Error("Платёж ЮKassa не соответствует ожидающему платежу XVII.");
  }
  if (Number(verified.amount?.value) !== Number(payment.amount) || verified.amount?.currency !== "RUB") {
    throw new Error("Сумма или валюта платежа не совпадает с ожидаемыми.");
  }
  if (payment.status === "succeeded") return response({ received: true, already_processed: true });
  if (event === "payment.canceled") {
    const canceledUpdate: Record<string, unknown> = { status: "canceled" };
    if (payment.purpose === "subscription") canceledUpdate.renewal_for = null;
    const { error } = await db.from("billing_payments")
      .update(canceledUpdate)
      .eq("id", payment.id)
      .eq("status", "pending");
    if (error) throw new Error(`Не удалось сохранить отмену платежа: ${error.message}`);
    return response({ received: true, status: "canceled" });
  }

  const method = verified.payment_method || {};
  const { error: finalizeError } = await db.rpc("finalize_yookassa_payment", {
    p_payment_id: payment.id,
    p_provider_payment_id: providerId,
    p_payment_method_id: typeof method.id === "string" ? method.id : null,
    p_payment_method_saved: method.saved === true,
  });
  if (finalizeError) throw new Error(`Не удалось зачислить платёж: ${finalizeError.message}`);
  return response({ received: true, status: "succeeded" });
}

async function processRenewals() {
  const db = serviceClient();
  const now = new Date();
  const dueBy = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const { data: organizations, error } = await db
    .from("organizations")
    .select("id, subscription_ends_at, subscription_plan_months, subscription_payment_method_id")
    .eq("subscription_auto_renew", true)
    .not("subscription_payment_method_id", "is", null)
    .not("subscription_ends_at", "is", null)
    .gte("subscription_ends_at", now.toISOString())
    .lte("subscription_ends_at", dueBy.toISOString())
    .limit(100);
  if (error) throw new Error(`Не удалось найти подписки для продления: ${error.message}`);

  const results: Array<{ organization_id: string; result: string }> = [];
  for (const organization of organizations || []) {
    const months = Number(organization.subscription_plan_months);
    const amount = plans.get(months);
    if (!amount || !organization.subscription_payment_method_id) continue;
    const id = crypto.randomUUID();
    const { data: payment, error: insertError } = await db
      .from("billing_payments")
      .insert({
        id,
        organization_id: organization.id,
        purpose: "subscription",
        plan_months: months,
        amount,
        auto_renew_requested: true,
        renewal_for: organization.subscription_ends_at,
        idempotence_key: id,
      })
      .select("id, organization_id, purpose, plan_months, amount, idempotence_key, auto_renew_requested")
      .maybeSingle();
    if (insertError?.code === "23505") continue;
    if (insertError || !payment) throw new Error(`Не удалось подготовить автоматическое продление: ${insertError?.message || "платёж не создан"}`);

    try {
      const created = await createYooKassaPayment(payment, organization.subscription_payment_method_id);
      const { error: updateError } = await db.from("billing_payments")
        .update({ provider_payment_id: created.id })
        .eq("id", payment.id);
      if (updateError) throw new Error(updateError.message);
      results.push({ organization_id: organization.id, result: "payment_created" });
    } catch (renewError) {
      await db.from("billing_payments").update({ status: "failed", renewal_for: null }).eq("id", payment.id);
      console.error("Не удалось продлить подписку.", organization.id, renewError);
      results.push({ organization_id: organization.id, result: "retry_next_run" });
    }
  }
  return response({ processed: results.length, results });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Разрешены только POST-запросы." }, 405);
  if (Number(request.headers.get("content-length") || 0) > 16_384) return response({ error: "Запрос слишком большой." }, 413);

  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.event) return await handleNotification(body);
    if (body.action === "process-renewals") {
      const secret = requiredEnv("QOS_BILLING_CRON_SECRET");
      if (request.headers.get("x-cron-secret") !== secret) return response({ error: "Недостаточно прав." }, 401);
      return await processRenewals();
    }

    const { organizationId } = await requireMember(request, body.action !== "status");
    const db = serviceClient();
    if (body.action === "create-checkout") {
      if (body.purpose === "subscription") {
        const months = Number(body.plan_months);
        const amount = plans.get(months);
        if (!amount) return response({ error: "Выберите доступный план подписки." }, 400);
        if (typeof body.auto_renew !== "boolean") return response({ error: "Подтвердите настройку автопродления." }, 400);
        return response(await createCheckout(db, organizationId, "subscription", amount, months, body.auto_renew));
      }
      if (body.purpose === "topup") {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 100 || amount > 50_000 || Math.round(amount * 100) !== amount * 100) {
          return response({ error: "Пополнять баланс можно на сумму от 100 до 50 000 ₽." }, 400);
        }
        return response(await createCheckout(db, organizationId, "topup", amount, null, false));
      }
      return response({ error: "Неизвестное назначение платежа." }, 400);
    }
    if (body.action === "status") {
      const [
        { data: organization, error: organizationError },
        { data: payments, error: paymentsError },
        { data: balanceTransactions, error: ledgerError },
      ] = await Promise.all([
        db.from("organizations")
          .select("trial_started_at, trial_ends_at, subscription_ends_at, subscription_plan_months, subscription_auto_renew, subscription_payment_method_id, balance")
          .eq("id", organizationId)
          .single(),
        db.from("billing_payments")
          .select("id, purpose, plan_months, amount, status, created_at, completed_at")
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: false })
          .limit(30),
        db.from("billing_balance_ledger")
          .select("id, transaction_type, amount, created_at")
          .eq("organization_id", organizationId)
          .eq("transaction_type", "subscription")
          .order("created_at", { ascending: false })
          .limit(30),
      ]);
      if (organizationError || paymentsError || ledgerError) {
        throw new Error(`Не удалось загрузить подписку: ${organizationError?.message || paymentsError?.message || ledgerError?.message}`);
      }
      return response({
        organization: {
          ...organization,
          has_payment_method: Boolean(organization.subscription_payment_method_id),
          subscription_payment_method_id: undefined,
        },
        payments: [
          ...(payments || []),
          ...(balanceTransactions || []).map((transaction) => ({
            id: transaction.id,
            purpose: "balance_subscription",
            plan_months: null,
            amount: Math.abs(Number(transaction.amount)),
            status: "succeeded",
            created_at: transaction.created_at,
            completed_at: transaction.created_at,
          })),
        ].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)).slice(0, 30),
      });
    }
    if (body.action === "disable-auto-renew") {
      const { error: updateError } = await db.from("organizations")
        .update({ subscription_auto_renew: false })
        .eq("id", organizationId);
      if (updateError) throw new Error(`Не удалось отключить автопродление: ${updateError.message}`);
      return response({ auto_renew: false });
    }
    if (body.action === "enable-auto-renew") {
      const { data: organization, error: readError } = await db.from("organizations")
        .select("subscription_payment_method_id")
        .eq("id", organizationId)
        .single();
      if (readError) throw new Error(`Не удалось проверить способ оплаты: ${readError.message}`);
      if (!organization.subscription_payment_method_id) {
        return response({ error: "Сначала оплатите план и отметьте согласие на сохранение способа оплаты." }, 400);
      }
      const { error: updateError } = await db.from("organizations")
        .update({ subscription_auto_renew: true })
        .eq("id", organizationId);
      if (updateError) throw new Error(`Не удалось включить автопродление: ${updateError.message}`);
      return response({ auto_renew: true });
    }
    return response({ error: "Неизвестное действие." }, 400);
  } catch (error) {
    console.error("qos-billing:", error);
    return response({ error: error instanceof Error ? error.message : "Внутренняя ошибка сервера." }, 400);
  }
});
