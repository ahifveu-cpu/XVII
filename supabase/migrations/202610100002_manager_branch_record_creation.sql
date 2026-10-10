create or replace function public.current_member_branch_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.current_member_can('billing.manage') then null
    else member.branch_id
  end
  from public.organization_members as member
  where member.user_id = (select auth.uid())
    and member.status = 'active'
  limit 1
$$;

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
    raise exception 'Войдите в XVII с активной учётной записью';
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
  if not public.current_member_can('billing.manage')
    and public.current_member_branch_id() is not null
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
