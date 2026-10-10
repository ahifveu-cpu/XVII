alter table public.organizations
  add column if not exists trial_started_at timestamptz not null default now(),
  add column if not exists trial_ends_at timestamptz not null default (now() + interval '14 days'),
  add column if not exists subscription_ends_at timestamptz,
  add column if not exists subscription_plan_months integer,
  add column if not exists subscription_auto_renew boolean not null default false,
  add column if not exists subscription_payment_method_id text,
  add column if not exists balance numeric(12, 2) not null default 0
    check (balance >= 0);

create table public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  purpose text not null check (purpose in ('subscription', 'topup')),
  plan_months integer check (plan_months in (1, 3, 6, 12)),
  amount numeric(12, 2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'canceled', 'failed')),
  provider_payment_id text unique,
  idempotence_key uuid not null unique,
  auto_renew_requested boolean not null default false,
  renewal_for timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint billing_payments_plan_consistency check (
    (purpose = 'subscription' and plan_months is not null)
    or (purpose = 'topup' and plan_months is null)
  )
);

create table public.billing_balance_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  payment_id uuid unique references public.billing_payments (id) on delete restrict,
  transaction_type text not null check (transaction_type in ('topup', 'subscription')),
  amount numeric(12, 2) not null check (amount <> 0),
  created_at timestamptz not null default now()
);

create unique index billing_payments_one_renewal
  on public.billing_payments (organization_id, renewal_for)
  where renewal_for is not null;
create index billing_payments_org_created_idx
  on public.billing_payments (organization_id, created_at desc);

alter table public.billing_payments enable row level security;
alter table public.billing_balance_ledger enable row level security;
revoke all on public.billing_payments from anon, authenticated;
revoke all on public.billing_balance_ledger from anon, authenticated;
grant all on public.billing_payments to service_role;
grant all on public.billing_balance_ledger to service_role;

create or replace function public.has_active_subscription()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    join public.organizations as organization
      on organization.id = member.organization_id
    where member.user_id = (select auth.uid())
      and member.status = 'active'
      and (
        organization.subscription_ends_at > now()
        or (
          organization.subscription_ends_at is null
          and organization.trial_ends_at > now()
        )
      )
  )
$$;

revoke all on function public.has_active_subscription() from public, anon;
grant execute on function public.has_active_subscription() to authenticated;

drop policy if exists crm_records_select_active_member on public.crm_records;
create policy crm_records_select_active_member
  on public.crm_records for select to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (select public.has_active_subscription())
    and (
      module = 'branches'
      or (select public.is_organization_manager())
      or (select public.current_member_branch_id()) is null
      or branch_id = (select public.current_member_branch_id())
    )
  );

drop policy if exists crm_records_update_active_member on public.crm_records;
create policy crm_records_update_active_member
  on public.crm_records for update to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (select public.has_active_subscription())
    and (
      (select public.is_organization_manager())
      or (
        module <> 'branches'
        and (
          (select public.current_member_branch_id()) is null
          or branch_id = (select public.current_member_branch_id())
        )
      )
    )
  )
  with check (
    organization_id = (select public.current_organization_id())
    and (select public.has_active_subscription())
    and (
      (select public.is_organization_manager())
      or (
        module <> 'branches'
        and (
          (select public.current_member_branch_id()) is null
          or branch_id = (select public.current_member_branch_id())
        )
      )
    )
  );

drop policy if exists crm_records_delete_manager on public.crm_records;
create policy crm_records_delete_manager
  on public.crm_records for delete to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (select public.has_active_subscription())
    and (select public.is_organization_manager())
  );

create or replace function public.guard_crm_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization_id uuid;
begin
  if auth.uid() is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  organization_id := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  if organization_id = public.current_organization_id()
    and not public.has_active_subscription() then
    raise exception 'Пробный период закончился. Выберите план подписки или пополните баланс.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger crm_records_require_subscription
  before insert or update or delete on public.crm_records
  for each row execute function public.guard_crm_subscription();

create or replace function public.update_receipt_template(p_template jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization_id uuid := public.current_organization_id();
  saved_template jsonb;
begin
  if organization_id is null or not public.is_organization_manager() then
    raise exception 'Настраивать шаблон квитанции может только владелец или управляющий';
  end if;
  if not public.has_active_subscription() then
    raise exception 'Пробный период закончился. Продлите подписку QoS.';
  end if;
  if jsonb_typeof(p_template) <> 'object' then
    raise exception 'Шаблон квитанции должен быть JSON-объектом';
  end if;
  if length(coalesce(p_template ->> 'company_name', '')) > 160
    or length(coalesce(p_template ->> 'receipt_title', '')) > 160
    or length(coalesce(p_template ->> 'footer_text', '')) > 1000 then
    raise exception 'Название компании или текст квитанции превышает допустимую длину';
  end if;

  update public.organizations
    set receipt_template = p_template
    where id = organization_id
    returning receipt_template into saved_template;
  return saved_template;
end;
$$;

create or replace function public.search_crm_records(p_query text, p_branch_id uuid default null)
returns setof public.crm_records
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  organization_id uuid := public.current_organization_id();
  query_pattern text;
begin
  if organization_id is null then
    raise exception 'Войдите в QoS с активной учётной записью';
  end if;
  if not public.has_active_subscription() then
    raise exception 'Пробный период закончился. Продлите подписку QoS.';
  end if;
  if p_query is null or length(trim(p_query)) < 2 or length(p_query) > 100 then
    return;
  end if;
  query_pattern := '%' || replace(
    replace(
      replace(trim(p_query), chr(92), chr(92) || chr(92)),
      '%',
      chr(92) || '%'
    ),
    '_',
    chr(92) || '_'
  ) || '%';

  return query
    select record.*
    from public.crm_records as record
    where record.organization_id = public.current_organization_id()
      and (p_branch_id is null or record.branch_id = p_branch_id)
      and (
        public.is_organization_manager()
        or public.current_member_branch_id() is null
        or record.module = 'branches'
        or record.branch_id = public.current_member_branch_id()
      )
      and record.data::text ilike query_pattern escape E'\\'
    order by record.created_at desc
    limit 50;
end;
$$;

create or replace function public.pay_subscription_from_balance(p_plan_months integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization_id uuid := public.current_organization_id();
  organization public.organizations;
  price numeric(12, 2);
  period_start timestamptz;
  period_end timestamptz;
begin
  if organization_id is null or not public.is_organization_manager() then
    raise exception 'Оплачивать подписку может только владелец или администратор';
  end if;
  price := case p_plan_months
    when 1 then 399
    when 3 then 1125
    when 6 then 2250
    when 12 then 4500
    else null
  end;
  if price is null then
    raise exception 'Выберите доступный план подписки';
  end if;

  select * into organization
    from public.organizations
    where id = organization_id
    for update;
  if organization.balance < price then
    raise exception 'На балансе недостаточно средств для оплаты выбранного плана';
  end if;

  period_start := greatest(
    now(),
    coalesce(organization.subscription_ends_at, organization.trial_ends_at, now())
  );
  period_end := period_start + make_interval(months => p_plan_months);

  update public.organizations
    set balance = balance - price,
        subscription_ends_at = period_end,
        subscription_plan_months = p_plan_months
    where id = organization_id;
  insert into public.billing_balance_ledger (organization_id, transaction_type, amount)
  values (organization_id, 'subscription', -price);

  return jsonb_build_object(
    'balance', organization.balance - price,
    'subscription_ends_at', period_end,
    'plan_months', p_plan_months
  );
end;
$$;

create or replace function public.finalize_yookassa_payment(
  p_payment_id uuid,
  p_provider_payment_id text,
  p_payment_method_id text default null,
  p_payment_method_saved boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment public.billing_payments;
  organization public.organizations;
  period_end timestamptz;
begin
  select * into payment
    from public.billing_payments
    where id = p_payment_id
    for update;
  if not found or payment.provider_payment_id is distinct from p_provider_payment_id then
    raise exception 'Платёж не найден или не совпадает с платежом ЮKassa';
  end if;
  if payment.status = 'succeeded' then
    return jsonb_build_object('status', 'succeeded', 'already_processed', true);
  end if;
  if payment.status <> 'pending' then
    raise exception 'Платёж уже завершён с другим статусом';
  end if;

  select * into organization
    from public.organizations
    where id = payment.organization_id
    for update;
  if not found then
    raise exception 'Организация платежа не найдена';
  end if;

  if payment.purpose = 'topup' then
    update public.organizations
      set balance = balance + payment.amount
      where id = organization.id;
    insert into public.billing_balance_ledger (organization_id, payment_id, transaction_type, amount)
    values (organization.id, payment.id, 'topup', payment.amount);
  else
    period_end := greatest(
      now(),
      coalesce(organization.subscription_ends_at, organization.trial_ends_at, now())
    ) + make_interval(months => payment.plan_months);
    update public.organizations
      set subscription_ends_at = period_end,
          subscription_plan_months = payment.plan_months,
          subscription_payment_method_id = case
            when p_payment_method_saved and p_payment_method_id is not null
              then p_payment_method_id
            else subscription_payment_method_id
          end,
          subscription_auto_renew = payment.auto_renew_requested
            and p_payment_method_saved
            and p_payment_method_id is not null
      where id = organization.id;
  end if;

  update public.billing_payments
    set status = 'succeeded', completed_at = now()
    where id = payment.id;

  return jsonb_build_object(
    'status', 'succeeded',
    'purpose', payment.purpose,
    'balance', case when payment.purpose = 'topup' then organization.balance + payment.amount else organization.balance end,
    'subscription_ends_at', period_end,
    'auto_renew_enabled', payment.auto_renew_requested and p_payment_method_saved
  );
end;
$$;

revoke all on function public.pay_subscription_from_balance(integer) from public, anon;
revoke all on function public.finalize_yookassa_payment(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.pay_subscription_from_balance(integer) to authenticated;
grant execute on function public.finalize_yookassa_payment(uuid, text, text, boolean) to service_role;
