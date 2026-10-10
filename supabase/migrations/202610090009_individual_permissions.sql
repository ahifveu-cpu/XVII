alter table public.organization_members
  add column if not exists permissions jsonb not null default '{
    "dashboard.view": true,
    "orders.view": true,
    "customers.view": true,
    "tasks.view": true,
    "calendar.view": true,
    "inventory.view": true,
    "services.view": true,
    "finance.view": true,
    "documents.view": true,
    "reports.view": true,
    "automation.view": true,
    "team.view": true,
    "branches.view": true,
    "settings.view": true,
    "billing.view": true
  }'::jsonb;

update public.organization_members
set permissions = '{
  "dashboard.view": true,
  "orders.view": true,
  "customers.view": true,
  "tasks.view": true,
  "calendar.view": true,
  "inventory.view": true,
  "services.view": true,
  "finance.view": true,
  "documents.view": true,
  "reports.view": true,
  "automation.view": true,
  "team.view": true,
  "branches.view": true,
  "settings.view": true,
  "billing.view": true
}'::jsonb
where role <> 'owner';

create or replace function public.current_member_can(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.user_id = (select auth.uid())
      and member.status = 'active'
      and (
        member.role = 'owner'
        or member.permissions -> p_permission = 'true'::jsonb
        or (
          right(p_permission, 5) = '.view'
          and (
            member.permissions -> (left(p_permission, length(p_permission) - 5) || '.create') = 'true'::jsonb
            or member.permissions -> (left(p_permission, length(p_permission) - 5) || '.edit') = 'true'::jsonb
            or member.permissions -> (left(p_permission, length(p_permission) - 5) || '.delete') = 'true'::jsonb
            or member.permissions -> (left(p_permission, length(p_permission) - 5) || '.export') = 'true'::jsonb
            or (p_permission = 'orders.view' and (
              member.permissions -> 'orders.pay' = 'true'::jsonb
              or member.permissions -> 'orders.receipt' = 'true'::jsonb
            ))
            or (p_permission = 'team.view' and member.permissions -> 'team.manage' = 'true'::jsonb)
            or (p_permission = 'settings.view' and member.permissions -> 'settings.receipt' = 'true'::jsonb)
            or (p_permission = 'billing.view' and member.permissions -> 'billing.manage' = 'true'::jsonb)
          )
        )
      )
  )
$$;

create or replace function public.is_organization_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_member_can('billing.manage')
$$;

drop policy if exists organization_members_select_member on public.organization_members;
create policy organization_members_select_member
  on public.organization_members for select to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (
      user_id = (select auth.uid())
      or (select public.current_member_can('team.view'))
    )
  );

create or replace function public.create_crm_record(p_module text, p_data jsonb, p_branch_id uuid default null)
returns public.crm_records
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := public.current_organization_id();
  new_record public.crm_records;
  next_number bigint;
  record_data jsonb := p_data - '_record_id' - '_created_at' - 'number' - 'paid_amount' - 'payment_method' - 'payment_status';
begin
  if v_organization_id is null then
    raise exception 'Войдите в QoS с активной учётной записью';
  end if;
  if p_module not in (
    'orders', 'customers', 'tasks', 'calendar', 'inventory', 'services',
    'finance', 'reports', 'team', 'branches', 'documents', 'automation'
  ) then
    raise exception 'Этот раздел CRM недоступен';
  end if;
  if not public.current_member_can(p_module || '.create') then
    raise exception 'У вас нет права создавать записи в этом разделе';
  end if;
  if public.current_member_branch_id() is not null
    and p_branch_id is distinct from public.current_member_branch_id() then
    raise exception 'Запись должна относиться к назначенному вам филиалу';
  end if;
  if jsonb_typeof(p_data) <> 'object' then
    raise exception 'Данные записи должны быть JSON-объектом';
  end if;
  if p_module = 'finance' then
    record_data := record_data - 'order_id';
  end if;
  if p_branch_id is not null and not exists (
    select 1 from public.crm_records as branch
    where branch.id = p_branch_id
      and branch.organization_id = v_organization_id
      and branch.module = 'branches'
  ) then
    raise exception 'Выбранный филиал не принадлежит этой организации';
  end if;
  if p_module = 'orders' and coalesce(btrim(p_data ->> 'customer'), '') = '' then
    raise exception 'Для создания заказа обязательно укажите клиента';
  end if;
  if p_module = 'orders'
    and coalesce(nullif(regexp_replace(coalesce(p_data ->> 'amount', ''), '[^0-9,.]', '', 'g'), ''), '0')::numeric <= 0 then
    raise exception 'Укажите положительную стоимость заказа';
  end if;

  if p_module = 'orders' then
    update public.organizations
      set next_order_number = next_order_number + 1
      where id = v_organization_id
      returning next_order_number - 1 into next_number;
    record_data := record_data || jsonb_build_object('number', next_number::text);
  end if;

  insert into public.crm_records (organization_id, branch_id, module, data, order_number, created_by)
  values (
    v_organization_id,
    case when p_module = 'branches' then null else p_branch_id end,
    p_module,
    record_data,
    next_number,
    auth.uid()
  )
  returning * into new_record;

  return new_record;
end;
$$;

create function public.create_crm_records_batch(
  p_module text,
  p_records jsonb,
  p_branch_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_data jsonb;
  imported_count integer := 0;
begin
  if p_module not in ('orders', 'customers', 'inventory', 'services') then
    raise exception 'Этот раздел CRM недоступен для импорта';
  end if;
  if not public.current_member_can(p_module || '.import')
    or not public.current_member_can(p_module || '.create') then
    raise exception 'Для импорта нужны права создания и импорта в этом разделе';
  end if;
  if jsonb_typeof(p_records) <> 'array' then
    raise exception 'Импорт должен содержать JSON-массив записей';
  end if;
  if jsonb_array_length(p_records) < 1 or jsonb_array_length(p_records) > 500 then
    raise exception 'Импорт должен содержать от 1 до 500 записей';
  end if;

  for record_data in select value from jsonb_array_elements(p_records)
  loop
    if jsonb_typeof(record_data) <> 'object' then
      raise exception 'Каждая запись импорта должна быть JSON-объектом';
    end if;
    perform public.create_crm_record(p_module, record_data, p_branch_id);
    imported_count := imported_count + 1;
  end loop;
  return imported_count;
end;
$$;

revoke all on function public.create_crm_records_batch(text, jsonb, uuid) from public, anon;
grant execute on function public.create_crm_records_batch(text, jsonb, uuid) to authenticated;

drop policy if exists crm_records_select_active_member on public.crm_records;
create policy crm_records_select_active_member
  on public.crm_records for select to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (select public.has_active_subscription())
    and (select public.current_member_can(module || '.view'))
    and (
      module = 'branches'
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
    and (select public.current_member_can(module || '.edit'))
    and (
      module = 'branches'
      or (select public.current_member_branch_id()) is null
      or branch_id = (select public.current_member_branch_id())
    )
  )
  with check (
    organization_id = (select public.current_organization_id())
    and (select public.has_active_subscription())
    and (select public.current_member_can(module || '.edit'))
    and (
      module = 'branches'
      or (select public.current_member_branch_id()) is null
      or branch_id = (select public.current_member_branch_id())
    )
  );

drop policy if exists crm_records_delete_manager on public.crm_records;
create policy crm_records_delete_manager
  on public.crm_records for delete to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (select public.has_active_subscription())
    and module <> 'branches'
    and (select public.current_member_can(module || '.delete'))
    and (
      module = 'branches'
      or (select public.current_member_branch_id()) is null
      or branch_id = (select public.current_member_branch_id())
    )
  );

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
  if organization_id is null or not public.current_member_can('settings.receipt') then
    raise exception 'У вас нет права настраивать талон приёма';
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
    where record.organization_id = organization_id
      and (p_branch_id is null or record.branch_id = p_branch_id)
      and public.current_member_can(record.module || '.view')
      and (
        record.module = 'branches'
        or public.current_member_branch_id() is null
        or record.branch_id = public.current_member_branch_id()
      )
      and record.data::text ilike query_pattern escape E'\\'
    order by record.created_at desc
    limit 50;
end;
$$;

create or replace function public.delete_crm_branch(p_branch_id uuid, p_target_branch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := public.current_organization_id();
  v_source public.crm_records;
  v_target public.crm_records;
  v_records_moved integer;
  v_members_moved integer;
  v_source_name text;
  v_target_name text;
begin
  if v_organization_id is null or not public.current_member_can('branches.delete') then
    raise exception 'У вас нет права удалять филиалы';
  end if;
  if p_branch_id is null or p_target_branch_id is null or p_branch_id = p_target_branch_id then
    raise exception 'Выберите другой филиал для переноса данных';
  end if;

  select branch.* into v_source
    from public.crm_records as branch
    where branch.id = p_branch_id
      and branch.organization_id = v_organization_id
      and branch.module = 'branches'
    for update;
  if not found then raise exception 'Удаляемый филиал не найден в вашей организации'; end if;

  select branch.* into v_target
    from public.crm_records as branch
    where branch.id = p_target_branch_id
      and branch.organization_id = v_organization_id
      and branch.module = 'branches'
    for update;
  if not found then raise exception 'Филиал для переноса не найден в вашей организации'; end if;

  v_source_name := coalesce(nullif(btrim(v_source.data ->> 'branch'), ''), nullif(btrim(v_source.data ->> 'name'), ''), 'Филиал');
  v_target_name := coalesce(nullif(btrim(v_target.data ->> 'branch'), ''), nullif(btrim(v_target.data ->> 'name'), ''), 'Филиал');

  perform set_config('qos.allow_branch_transfer', 'on', true);
  update public.crm_records as record
    set branch_id = p_target_branch_id
    where record.organization_id = v_organization_id and record.branch_id = p_branch_id;
  get diagnostics v_records_moved = row_count;
  update public.organization_members as member
    set branch_id = p_target_branch_id
    where member.organization_id = v_organization_id and member.branch_id = p_branch_id;
  get diagnostics v_members_moved = row_count;
  perform set_config('qos.allow_branch_transfer', 'off', true);
  delete from public.crm_records as branch
    where branch.id = p_branch_id and branch.organization_id = v_organization_id and branch.module = 'branches';

  return jsonb_build_object(
    'deleted_branch', v_source_name,
    'target_branch', v_target_name,
    'records_moved', v_records_moved,
    'members_moved', v_members_moved
  );
end;
$$;

alter function public.record_order_payment_split(uuid, numeric, numeric)
  rename to record_order_payment_split_unchecked;
revoke all on function public.record_order_payment_split_unchecked(uuid, numeric, numeric) from public, anon, authenticated;

create function public.record_order_payment_split(
  p_order_id uuid,
  p_cash_amount numeric,
  p_cashless_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_member_can('orders.pay') then
    raise exception 'У вас нет права принимать оплату по заказам';
  end if;
  if public.current_member_branch_id() is not null and not exists (
    select 1 from public.crm_records as record
    where record.id = p_order_id
      and record.organization_id = public.current_organization_id()
      and record.module = 'orders'
      and record.branch_id = public.current_member_branch_id()
  ) then
    raise exception 'Заказ не найден в назначенном вам филиале';
  end if;
  perform set_config('qos.allow_order_payment', 'on', true);
  return public.record_order_payment_split_unchecked(p_order_id, p_cash_amount, p_cashless_amount);
end;
$$;

revoke all on function public.record_order_payment_split(uuid, numeric, numeric) from public, anon;
grant execute on function public.record_order_payment_split(uuid, numeric, numeric) to authenticated;

create or replace function public.protect_order_payment_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.module = 'orders'
    and (
      new.paid_total is distinct from old.paid_total
      or new.cash_paid_total is distinct from old.cash_paid_total
      or new.cashless_paid_total is distinct from old.cashless_paid_total
      or new.payment_method is distinct from old.payment_method
      or new.payment_status is distinct from old.payment_status
    )
    and current_setting('qos.allow_order_payment', true) is distinct from 'on' then
    raise exception 'Сведения об оплатах можно менять только через регистрацию платежа';
  end if;
  return new;
end;
$$;

drop trigger if exists crm_records_protect_order_payment_fields on public.crm_records;
create trigger crm_records_protect_order_payment_fields
  before update on public.crm_records
  for each row execute function public.protect_order_payment_fields();

revoke all on function public.current_member_can(text) from public, anon;
grant execute on function public.current_member_can(text) to authenticated;
