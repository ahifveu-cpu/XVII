create extension if not exists pgcrypto with schema extensions;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  next_order_number bigint not null default 1 check (next_order_number > 0),
  receipt_template jsonb not null default '{
    "company_name": "qos — сервисный центр",
    "company_phone": "",
    "address": "",
    "receipt_title": "Квитанция о приёме техники",
    "intake_text": "Оборудование принято на диагностику и ремонт.",
    "appearance_text": "Внешний вид и комплектность зафиксированы при приёме.",
    "diagnostics_text": "Точная стоимость ремонта согласовывается после диагностики.",
    "warranty_text": "Гарантия на выполненные работы предоставляется согласно условиям сервиса.",
    "footer_text": "Спасибо, что выбрали наш сервис!",
    "show_estimate": true
  }'::jsonb,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  full_name text not null default '',
  role text not null check (role in ('owner', 'admin', 'manager', 'technician', 'cashier')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  branch_id uuid,
  created_at timestamptz not null default now()
);

create table public.crm_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  branch_id uuid references public.crm_records (id) on delete restrict,
  module text not null check (module in (
    'orders', 'customers', 'tasks', 'calendar', 'inventory', 'services',
    'finance', 'reports', 'team', 'branches', 'documents', 'automation'
  )),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  status text,
  order_number bigint,
  total numeric(12, 2),
  paid_total numeric(12, 2) not null default 0 check (paid_total >= 0),
  payment_method text check (payment_method is null or payment_method in ('cash', 'cashless')),
  payment_status text not null default 'Не оплачено',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_records_id_org_unique unique (id, organization_id),
  constraint crm_records_order_number_org_unique unique (organization_id, order_number),
  constraint crm_records_branch_same_organization foreign key (branch_id, organization_id)
    references public.crm_records (id, organization_id) on delete restrict
);

alter table public.organization_members
  add constraint organization_members_branch_same_organization foreign key (branch_id, organization_id)
    references public.crm_records (id, organization_id) on delete restrict;

create index crm_records_module_created_idx
  on public.crm_records (organization_id, module, created_at desc);
create index crm_records_branch_module_idx
  on public.crm_records (organization_id, branch_id, module, created_at desc);
create index crm_records_data_search_idx on public.crm_records using gin (data jsonb_path_ops);
create index organization_members_organization_idx on public.organization_members (organization_id, role, status);

create function public.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select member.organization_id
  from public.organization_members as member
  where member.user_id = (select auth.uid())
    and member.status = 'active'
  limit 1
$$;

create function public.current_member_branch_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select member.branch_id
  from public.organization_members as member
  where member.user_id = (select auth.uid())
    and member.status = 'active'
  limit 1
$$;

create function public.is_organization_manager()
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
      and member.role in ('owner', 'admin', 'manager')
  )
$$;

create function public.touch_crm_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  raw_amount text;
begin
  new.updated_at := now();
  if new.branch_id = new.id then
    raise exception 'Филиал не может ссылаться на собственную запись';
  end if;

  if new.module = 'orders' then
    raw_amount := regexp_replace(coalesce(new.data ->> 'amount', ''), '[^0-9,.]', '', 'g');
    if raw_amount <> '' then
      new.total := replace(raw_amount, ',', '.')::numeric(12, 2);
    end if;

    if tg_op = 'INSERT' then
      new.paid_total := 0;
      new.payment_method := null;
      new.payment_status := 'Не оплачено';
      new.data := new.data
        - '_record_id'
        - '_created_at'
        - 'paid_amount'
        - 'payment_method'
        - 'payment_status';
    else
      if new.order_number is distinct from old.order_number
        or new.paid_total is distinct from old.paid_total
        or new.payment_method is distinct from old.payment_method then
        if current_user <> 'postgres' then
          raise exception 'Номер заказа и сведения об оплате изменяются только защищённой операцией оплаты';
        end if;
      end if;
      if new.total < old.paid_total then
        raise exception 'Сумма заказа меньше уже внесённой оплаты';
      end if;
    end if;

    new.status := nullif(new.data ->> 'status', '');
    new.data := new.data || jsonb_build_object(
      'number', new.order_number::text,
      'amount', coalesce(new.total, 0)::text || ' ₽',
      'paid_amount', new.paid_total::text || ' ₽',
      'payment_method', coalesce(new.payment_method, ''),
      'payment_status', new.payment_status
    );
  else
    new.data := new.data - '_record_id' - '_created_at';
    new.status := nullif(new.data ->> 'status', '');
    raw_amount := regexp_replace(coalesce(new.data ->> 'amount', new.data ->> 'price', ''), '[^0-9,.]', '', 'g');
    if raw_amount <> '' then
      new.total := replace(raw_amount, ',', '.')::numeric(12, 2);
    end if;
  end if;

  return new;
end;
$$;

create trigger crm_records_touch
  before insert or update on public.crm_records
  for each row execute function public.touch_crm_record();

create function public.protect_order_payment_ledger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and old.module = 'finance' and old.data ? 'order_id' then
    raise exception 'Платёж по заказу хранится в журнале и не может быть удалён отдельно';
  end if;
  if tg_op = 'UPDATE'
    and old.module = 'finance'
    and (old.data ? 'order_id' or new.data ? 'order_id')
    and (
      new.data is distinct from old.data
      or new.module is distinct from old.module
      or new.branch_id is distinct from old.branch_id
    ) then
    raise exception 'Платёж по заказу нельзя изменить вручную';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger crm_records_protect_payment_ledger
  before update or delete on public.crm_records
  for each row execute function public.protect_order_payment_ledger();

create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invited_organization_id uuid;
  new_organization_id uuid;
  invited_role text;
  employee_branch_id uuid;
  employee_name text;
  primary_branch_id uuid;
begin
  invited_organization_id := nullif(new.raw_app_meta_data ->> 'organization_id', '')::uuid;
  invited_role := new.raw_app_meta_data ->> 'organization_role';
  employee_branch_id := nullif(new.raw_app_meta_data ->> 'branch_id', '')::uuid;
  employee_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(new.email, '@', 1)
  );

  if invited_organization_id is not null
    and exists (select 1 from public.organizations where id = invited_organization_id) then
    if invited_role not in ('admin', 'manager', 'technician', 'cashier') then
      raise exception 'Недопустимая роль приглашённого пользователя';
    end if;
    if employee_branch_id is not null and not exists (
      select 1 from public.crm_records as branch
      where branch.id = employee_branch_id
        and branch.organization_id = invited_organization_id
        and branch.module = 'branches'
    ) then
      raise exception 'Филиал пользователя не принадлежит организации';
    end if;

    insert into public.organization_members (user_id, organization_id, full_name, role, branch_id)
    values (new.id, invited_organization_id, employee_name, invited_role, employee_branch_id);
  else
    insert into public.organizations (name)
    values (coalesce(nullif(trim(new.raw_user_meta_data ->> 'company_name'), ''), 'Моя компания'))
    returning id into new_organization_id;

    update public.organizations
      set receipt_template = receipt_template || jsonb_build_object(
        'company_name',
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'company_name'), ''), 'Моя компания')
      )
      where id = new_organization_id;

    insert into public.organization_members (user_id, organization_id, full_name, role)
    values (new.id, new_organization_id, employee_name, 'owner');

    insert into public.crm_records (organization_id, module, data, created_by)
    values (
      new_organization_id,
      'branches',
      jsonb_build_object(
        'branch', 'Центральный',
        'address', '',
        'manager', employee_name,
        'employees', '1 сотрудник',
        'status', 'Открыт'
      ),
      new.id
    )
    returning id into primary_branch_id;

    update public.organization_members
      set branch_id = primary_branch_id
      where user_id = new.id;
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create function public.create_crm_record(p_module text, p_data jsonb, p_branch_id uuid default null)
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
  if p_module = 'branches' and not public.is_organization_manager() then
    raise exception 'Создавать филиалы может только владелец, администратор или менеджер';
  end if;
  if not public.is_organization_manager()
    and public.current_member_branch_id() is not null
    and p_branch_id is distinct from public.current_member_branch_id() then
    raise exception 'Запись должна относиться к назначенному вам филиалу';
  end if;
  if p_module not in (
    'orders', 'customers', 'tasks', 'calendar', 'inventory', 'services',
    'finance', 'reports', 'team', 'branches', 'documents', 'automation'
  ) then
    raise exception 'Этот раздел CRM недоступен';
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

create function public.record_order_payment(p_order_id uuid, p_amount numeric, p_method text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := public.current_organization_id();
  current_order public.crm_records;
  updated_order public.crm_records;
  new_transaction public.crm_records;
begin
  if v_organization_id is null then
    raise exception 'Войдите в QoS с активной учётной записью';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 9999999999.99 then
    raise exception 'Укажите положительную сумму оплаты';
  end if;
  if p_method is null or p_method not in ('cash', 'cashless') then
    raise exception 'Выберите наличную или безналичную оплату';
  end if;

  select * into current_order
    from public.crm_records
    where id = p_order_id
      and crm_records.organization_id = v_organization_id
      and module = 'orders'
    for update;

  if not found then
    raise exception 'Заказ не найден или у вас нет доступа к нему';
  end if;
  if current_order.paid_total + p_amount > current_order.total then
    raise exception 'Сумма оплаты превышает остаток по заказу';
  end if;

  update public.crm_records
    set paid_total = paid_total + p_amount,
        payment_method = p_method,
        payment_status = case
          when paid_total + p_amount >= total then 'Оплачен'
          else 'Оплачен частично'
        end,
        data = data || jsonb_build_object(
          'payment_method', p_method,
          'payment_status', case
            when paid_total + p_amount >= total then 'Оплачен'
            else 'Оплачен частично'
          end
        )
    where id = p_order_id
      and organization_id = v_organization_id
    returning * into updated_order;

  insert into public.crm_records (organization_id, branch_id, module, data, created_by)
  values (
    v_organization_id,
    updated_order.branch_id,
    'finance',
    jsonb_build_object(
      'operation', 'Оплата заказа №' || updated_order.order_number::text,
      'category', 'Оплата заказа',
      'type', 'Доход',
      'date', to_char(now() at time zone 'Europe/Moscow', 'DD.MM.YYYY HH24:MI'),
      'payment', case when p_method = 'cash' then 'Наличные' else 'Безналичные' end,
      'amount', '+' || to_char(p_amount, 'FM9999999990D00') || ' ₽',
      'order_id', p_order_id
    ),
    auth.uid()
  )
  returning * into new_transaction;

  return jsonb_build_object('order', to_jsonb(updated_order), 'transaction', to_jsonb(new_transaction));
end;
$$;

create function public.update_receipt_template(p_template jsonb)
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

create function public.search_crm_records(p_query text, p_branch_id uuid default null)
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

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.crm_records enable row level security;

revoke all on public.organizations from anon, authenticated;
revoke all on public.organization_members from anon, authenticated;
revoke all on public.crm_records from anon, authenticated;

grant select on public.organizations, public.organization_members, public.crm_records to authenticated;
grant update (data, branch_id) on public.crm_records to authenticated;
grant delete on public.crm_records to authenticated;

create policy organizations_select_member
  on public.organizations for select to authenticated
  using (id = (select public.current_organization_id()));

create policy organization_members_select_member
  on public.organization_members for select to authenticated
  using (organization_id = (select public.current_organization_id()));

create policy crm_records_select_active_member
  on public.crm_records for select to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (
      module = 'branches'
      or (select public.is_organization_manager())
      or (select public.current_member_branch_id()) is null
      or branch_id = (select public.current_member_branch_id())
    )
  );

create policy crm_records_update_active_member
  on public.crm_records for update to authenticated
  using (
    organization_id = (select public.current_organization_id())
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

create policy crm_records_delete_manager
  on public.crm_records for delete to authenticated
  using (
    organization_id = (select public.current_organization_id())
    and (select public.is_organization_manager())
  );

revoke all on function public.current_organization_id() from public, anon;
revoke all on function public.current_member_branch_id() from public, anon;
revoke all on function public.is_organization_manager() from public, anon;
revoke all on function public.create_crm_record(text, jsonb, uuid) from public, anon;
revoke all on function public.record_order_payment(uuid, numeric, text) from public, anon;
revoke all on function public.update_receipt_template(jsonb) from public, anon;
revoke all on function public.search_crm_records(text, uuid) from public, anon;

grant execute on function public.current_organization_id() to authenticated;
grant execute on function public.current_member_branch_id() to authenticated;
grant execute on function public.is_organization_manager() to authenticated;
grant execute on function public.create_crm_record(text, jsonb, uuid) to authenticated;
grant execute on function public.record_order_payment(uuid, numeric, text) to authenticated;
grant execute on function public.update_receipt_template(jsonb) to authenticated;
grant execute on function public.search_crm_records(text, uuid) to authenticated;

-- Managers access Supabase Auth through the protected Edge Function only.
alter table public.organization_members replica identity full;
