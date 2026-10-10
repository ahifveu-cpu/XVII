import { createClient, type User } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const allowedRoles = new Set(["admin", "manager", "technician", "cashier"]);
const permissionModules = [
  "dashboard", "orders", "customers", "tasks", "calendar", "inventory", "services",
  "finance", "documents", "reports", "automation", "team", "branches", "settings", "billing",
];
const permissionActions = ["view", "create", "edit", "delete", "import", "export"];
const permissionKeys = new Set([
  ...permissionModules.flatMap((module) => permissionActions.map((action) => `${module}.${action}`)),
  "orders.pay", "orders.receipt", "team.manage", "settings.receipt", "billing.manage",
]);

function defaultPermissions() {
  return Object.fromEntries(permissionModules.map((module) => [`${module}.view`, true]));
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`На сервере не настроена переменная окружения ${name}.`);
  return value;
}

function sendError(error: unknown) {
  console.error("manage-users:", error);
  return response({ error: error instanceof Error ? error.message : "Внутренняя ошибка сервера." }, 400);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Разрешены только POST-запросы." }, 405);
  if (Number(request.headers.get("content-length") || 0) > 16_384) return response({ error: "Запрос слишком большой." }, 413);

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return response({ error: "Требуется авторизация." }, 401);

    const url = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const userClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(authorization.slice(7));
    if (authError || !user) return response({ error: "Срок действия сеанса истёк. Войдите повторно." }, 401);

    const { data: actor, error: actorError } = await userClient
      .from("organization_members")
      .select("user_id, organization_id, role, status, permissions")
      .eq("user_id", user.id)
      .maybeSingle();
    if (actorError) throw new Error(`Не удалось проверить права сотрудника: ${actorError.message}`);
    if (!actor || actor.status !== "active") return response({ error: "Учётная запись отключена или отсутствует." }, 403);
    const body = await request.json();
    if (!body || typeof body.action !== "string") return response({ error: "Укажите действие." }, 400);
    const isOwner = actor.role === "owner";
    const canManageTeam = isOwner || actor.permissions?.["team.manage"] === true;
    if (body.action === "permissions" && !isOwner) {
      return response({ error: "Настраивать права сотрудников может только владелец компании." }, 403);
    }
    if (body.action === "repair" && !isOwner) {
      return response({ error: "Восстановить доступ может только владелец компании." }, 403);
    }
    if (["list", "create", "block", "unblock", "delete"].includes(body.action) && !canManageTeam) {
      return response({ error: "У вас нет права управлять сотрудниками." }, 403);
    }

    if (["create", "repair", "block", "unblock", "delete", "permissions"].includes(body.action)) {
      const { data: organization, error: organizationError } = await userClient
        .from("organizations")
        .select("trial_ends_at, subscription_ends_at")
        .eq("id", actor.organization_id)
        .maybeSingle();
      if (organizationError) throw new Error(`Не удалось проверить подписку компании: ${organizationError.message}`);
      const accessUntil = organization?.subscription_ends_at || organization?.trial_ends_at;
      if (!accessUntil || Date.parse(accessUntil) <= Date.now()) {
        return response({ error: "Пробный период закончился. Продлите подписку XVII перед изменением доступа сотрудников." }, 403);
      }
    }

    const service = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (body.action === "permissions") {
      if (typeof body.user_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.user_id)) {
        return response({ error: "Некорректный идентификатор сотрудника." }, 400);
      }
      if (!body.permissions || typeof body.permissions !== "object" || Array.isArray(body.permissions)) {
        return response({ error: "Передайте объект разрешений сотрудника." }, 400);
      }
      const entries = Object.entries(body.permissions);
      if (entries.some(([key, value]) => !permissionKeys.has(key) || typeof value !== "boolean")) {
        return response({ error: "Список разрешений содержит неизвестные ключи или некорректные значения." }, 400);
      }
      const permissions = { ...defaultPermissions(), ...body.permissions };
      const { data: updatedMember, error: updateError } = await service
        .from("organization_members")
        .update({ permissions })
        .eq("user_id", body.user_id)
        .eq("organization_id", actor.organization_id)
        .neq("role", "owner")
        .select("user_id")
        .maybeSingle();
      if (updateError) throw new Error(`Не удалось сохранить права сотрудника: ${updateError.message}`);
      if (!updatedMember) return response({ error: "Сотрудник не найден в вашей компании или является владельцем." }, 404);
      return response({ success: true, permissions });
    }

    if (body.action === "list") {
      const { data: members, error: memberError } = await service
        .from("organization_members")
        .select("user_id, organization_id, full_name, role, status, branch_id, permissions, created_at")
        .eq("organization_id", actor.organization_id)
        .order("created_at");
      if (memberError) throw new Error(`Не удалось получить список сотрудников: ${memberError.message}`);

      const { data: authUsers, error: authUsersError } = await service.auth.admin.listUsers({ perPage: 1000 });
      if (authUsersError) throw new Error(`Не удалось получить адреса сотрудников: ${authUsersError.message}`);

      const emails = new Map(authUsers.users.map((item: User) => [item.id, item.email]));
      return response({
        users: members.map((member: Record<string, unknown>) => ({
          ...member,
          email: emails.get(member.user_id) || "",
          is_self: member.user_id === user.id,
        })),
      });
    }

    if (body.action === "create") {
      if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
        return response({ error: "Укажите корректный адрес электронной почты сотрудника." }, 400);
      }
      if (typeof body.full_name !== "string" || body.full_name.trim().length < 2 || body.full_name.trim().length > 100) {
        return response({ error: "Укажите имя сотрудника (от 2 до 100 символов)." }, 400);
      }
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) {
        return response({ error: "Временный пароль должен содержать от 12 до 128 символов." }, 400);
      }
      if (typeof body.role !== "string" || !allowedRoles.has(body.role)) {
        return response({ error: "Выберите роль: администратор, менеджер, мастер или кассир." }, 400);
      }
      if (!isOwner && body.role === "admin") {
        return response({ error: "Назначать администраторов может только владелец компании." }, 403);
      }
      const branchId = typeof body.branch_id === "string" && body.branch_id.length > 0 ? body.branch_id : undefined;
      if (branchId) {
        const { data: branch, error: branchError } = await service
          .from("crm_records")
          .select("id")
          .eq("id", branchId)
          .eq("organization_id", actor.organization_id)
          .eq("module", "branches")
          .maybeSingle();
        if (branchError || !branch) return response({ error: "Указанный филиал не относится к вашей компании." }, 400);
      }

      const { data: created, error: createError } = await service.auth.admin.createUser({
        email: body.email.trim().toLowerCase(),
        password: body.password,
        email_confirm: true,
        user_metadata: { full_name: body.full_name.trim() },
        app_metadata: {
          organization_id: actor.organization_id,
          organization_role: body.role,
          ...(branchId ? { branch_id: branchId } : {}),
        },
      });
      if (createError || !created.user) throw new Error(`Не удалось создать учётную запись: ${createError?.message || "Supabase не вернул пользователя."}`);

      const { data: initialMembership, error: initialMembershipError } = await service
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", created.user.id)
        .maybeSingle();
      if (initialMembershipError) {
        throw new Error(`Учётная запись создана, но не удалось проверить её начальную организацию: ${initialMembershipError.message}`);
      }

      const { error: membershipError } = await service
        .from("organization_members")
        .upsert({
          user_id: created.user.id,
          organization_id: actor.organization_id,
          full_name: body.full_name.trim(),
          role: body.role,
          status: "active",
          branch_id: branchId || null,
          permissions: defaultPermissions(),
        }, { onConflict: "user_id" });
      if (membershipError) {
        throw new Error(`Учётная запись создана, но не удалось назначить сотрудника в организацию: ${membershipError.message}`);
      }

      const appMetadata = { ...(created.user.app_metadata || {}) };
      appMetadata.organization_id = actor.organization_id;
      appMetadata.organization_role = body.role;
      if (branchId) appMetadata.branch_id = branchId;
      else delete appMetadata.branch_id;
      const { error: metadataError } = await service.auth.admin.updateUserById(created.user.id, {
        app_metadata: appMetadata,
      });
      if (metadataError) {
        throw new Error(`Сотрудник привязан к компании, но не удалось сохранить его назначение: ${metadataError.message}`);
      }

      if (initialMembership?.organization_id && initialMembership.organization_id !== actor.organization_id) {
        const oldOrganizationId = initialMembership.organization_id;
        const { data: oldMembers, error: oldMembersError } = await service
          .from("organization_members")
          .select("user_id")
          .eq("organization_id", oldOrganizationId);
        if (oldMembersError) throw new Error(`Сотрудник привязан, но не удалось проверить временную организацию: ${oldMembersError.message}`);
        if (oldMembers.length === 1 && oldMembers[0].user_id === created.user.id) {
          const { data: oldRecords, error: oldRecordsError } = await service
            .from("crm_records")
            .select("module, data")
            .eq("organization_id", oldOrganizationId);
          if (oldRecordsError) throw new Error(`Сотрудник привязан, но не удалось проверить временные данные: ${oldRecordsError.message}`);
          const onlyDefaultBranch = oldRecords.length === 1
            && oldRecords[0].module === "branches"
            && oldRecords[0].data?.branch === "Центральный";
          if (oldRecords.length === 0 || onlyDefaultBranch) {
            const { error: cleanupError } = await service
              .from("organizations")
              .delete()
              .eq("id", oldOrganizationId);
            if (cleanupError) throw new Error(`Сотрудник привязан, но не удалось удалить пустую временную организацию: ${cleanupError.message}`);
          }
        }
      }

      return response({ user_id: created.user.id, email: created.user.email });
    }

    if (body.action === "repair") {
      if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
        return response({ error: "Укажите корректный адрес электронной почты сотрудника." }, 400);
      }
      if (typeof body.role !== "string" || !allowedRoles.has(body.role)) {
        return response({ error: "Выберите роль: администратор, менеджер, мастер или кассир." }, 400);
      }
      if (!isOwner && body.role === "admin") {
        return response({ error: "Назначать администраторов может только владелец компании." }, 403);
      }

      const branchId = typeof body.branch_id === "string" && body.branch_id.length > 0 ? body.branch_id : null;
      if (branchId) {
        const { data: branch, error: branchError } = await service
          .from("crm_records")
          .select("id")
          .eq("id", branchId)
          .eq("organization_id", actor.organization_id)
          .eq("module", "branches")
          .maybeSingle();
        if (branchError || !branch) return response({ error: "Указанный филиал не относится к вашей компании." }, 400);
      }

      const { data: authUsers, error: authUsersError } = await service.auth.admin.listUsers({ perPage: 1000 });
      if (authUsersError) throw new Error(`Не удалось найти учётную запись: ${authUsersError.message}`);
      const targetUser = authUsers.users.find((item: User) => item.email?.toLowerCase() === body.email.trim().toLowerCase());
      if (!targetUser) return response({ error: "Аккаунт с такой почтой не найден в Supabase Auth." }, 404);
      if (targetUser.id === user.id) return response({ error: "Нельзя восстановить доступ для собственной учётной записи." }, 400);

      const { data: target, error: targetError } = await service
        .from("organization_members")
        .select("user_id, organization_id, status")
        .eq("user_id", targetUser.id)
        .maybeSingle();
      if (targetError) throw new Error(`Не удалось проверить привязку сотрудника: ${targetError.message}`);
      if (!target) return response({ error: "Для этого аккаунта не найдена запись членства в компании." }, 404);
      if (target.organization_id === actor.organization_id) {
        return response({ error: "Аккаунт уже привязан к вашей компании. Попросите сотрудника войти заново." }, 409);
      }

      const { data: oldMembers, error: oldMembersError } = await service
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", target.organization_id);
      if (oldMembersError) throw new Error(`Не удалось проверить прежнюю организацию: ${oldMembersError.message}`);
      if (oldMembers.length !== 1 || oldMembers[0].user_id !== targetUser.id) {
        return response({ error: "Перенос остановлен: прежняя организация используется другими сотрудниками." }, 409);
      }

      const { data: oldRecords, error: oldRecordsError } = await service
        .from("crm_records")
        .select("id, module, data")
        .eq("organization_id", target.organization_id);
      if (oldRecordsError) throw new Error(`Не удалось проверить данные прежней организации: ${oldRecordsError.message}`);
      const onlyDefaultBranch = oldRecords.length === 1
        && oldRecords[0].module === "branches"
        && oldRecords[0].data?.branch === "Центральный";
      if (oldRecords.length > 0 && !onlyDefaultBranch) {
        return response({ error: "Перенос остановлен: в прежней организации уже есть данные. Сначала обратитесь в поддержку XVII." }, 409);
      }

      const targetName = typeof targetUser.user_metadata?.full_name === "string"
        ? targetUser.user_metadata.full_name
        : targetUser.email || "";
      const { error: membershipError } = await service
        .from("organization_members")
        .upsert({
          user_id: targetUser.id,
          organization_id: actor.organization_id,
          full_name: targetName,
          role: body.role,
          status: target.status,
          branch_id: branchId,
          permissions: defaultPermissions(),
        }, { onConflict: "user_id" });
      if (membershipError) throw new Error(`Не удалось восстановить членство сотрудника: ${membershipError.message}`);

      const appMetadata = { ...(targetUser.app_metadata || {}) };
      appMetadata.organization_id = actor.organization_id;
      appMetadata.organization_role = body.role;
      if (branchId) appMetadata.branch_id = branchId;
      else delete appMetadata.branch_id;
      const { error: authUpdateError } = await service.auth.admin.updateUserById(targetUser.id, {
        app_metadata: appMetadata,
      });
      if (authUpdateError) {
        throw new Error(`Сотрудник привязан к компании, но не удалось обновить метаданные аккаунта: ${authUpdateError.message}`);
      }

      return response({ user_id: targetUser.id, email: targetUser.email, repaired: true });
    }

    if (body.action === "block" || body.action === "unblock" || body.action === "delete") {
      if (typeof body.user_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.user_id)) {
        return response({ error: "Некорректный идентификатор сотрудника." }, 400);
      }
      if (body.user_id === user.id) return response({ error: "Нельзя заблокировать или удалить свою учётную запись." }, 400);

      const { data: target, error: targetError } = await service
        .from("organization_members")
        .select("user_id, organization_id, role")
        .eq("user_id", body.user_id)
        .maybeSingle();
      if (targetError) throw new Error(`Не удалось проверить сотрудника: ${targetError.message}`);
      if (!target || target.organization_id !== actor.organization_id) {
        return response({ error: "Сотрудник не найден в вашей компании." }, 404);
      }
      if (target.role === "owner") return response({ error: "Владельца компании нельзя заблокировать или удалить." }, 403);
      if (target.role === "admin" && !isOwner) {
        return response({ error: "Администратором может управлять только владелец компании." }, 403);
      }

      if (body.action === "delete") {
        const { error: deleteError } = await service.auth.admin.deleteUser(body.user_id);
        if (deleteError) throw new Error(`Не удалось удалить сотрудника: ${deleteError.message}`);
        return response({ success: true });
      }

      const { error: authUpdateError } = await service.auth.admin.updateUserById(body.user_id, {
        ban_duration: body.action === "block" ? "876000h" : "none",
      });
      if (authUpdateError) throw new Error(`Не удалось обновить доступ сотрудника: ${authUpdateError.message}`);

      const { error: membershipUpdateError } = await service
        .from("organization_members")
        .update({ status: body.action === "block" ? "blocked" : "active" })
        .eq("user_id", body.user_id)
        .eq("organization_id", actor.organization_id);
      if (membershipUpdateError) throw new Error(`Доступ к данным закрыт, но обновить профиль не удалось: ${membershipUpdateError.message}`);
      return response({ success: true });
    }

    return response({ error: "Неизвестная операция." }, 400);
  } catch (error) {
    return sendError(error);
  }
});
