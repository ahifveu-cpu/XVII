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
  customer_phone text := regexp_replace(coalesce(p_data ->> 'phone', ''), '[^0-9]', '', 'g');
  customer_email text := lower(btrim(coalesce(p_data ->> 'email', '')));
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
  if p_module = 'orders'
    and coalesce(nullif(regexp_replace(coalesce(p_data ->> 'cost_amount', '0'), '[^0-9,.]', '', 'g'), ''), '0')::numeric < 0 then
    raise exception 'Себестоимость заказа не может быть отрицательной';
  end if;
  if p_module = 'orders' and (customer_phone <> '' or customer_email <> '') then
    if customer_phone <> '' then
      perform pg_advisory_xact_lock(hashtextextended(
        v_organization_id::text || ':' || coalesce(p_branch_id::text, 'all') || ':phone:' || customer_phone,
        0
      ));
    end if;
    if customer_email <> '' then
      perform pg_advisory_xact_lock(hashtextextended(
        v_organization_id::text || ':' || coalesce(p_branch_id::text, 'all') || ':email:' || customer_email,
        0
      ));
    end if;
  end if;

  if p_module = 'orders' then
    update public.organizations
      set next_order_number = next_order_number + 1
      where id = v_organization_id
      returning next_order_number - 1 into next_number;
    record_data := record_data || jsonb_build_object('number', next_number::text);
    if nullif(btrim(p_data ->> 'cost_amount'), '') is null then
      record_data := record_data || jsonb_build_object('profit_amount', null);
    else
      record_data := record_data || jsonb_build_object(
        'profit_amount',
        replace(regexp_replace(p_data ->> 'amount', '[^0-9,.]', '', 'g'), ',', '.')::numeric
          - replace(regexp_replace(p_data ->> 'cost_amount', '[^0-9,.]', '', 'g'), ',', '.')::numeric
      );
    end if;
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

  if p_module = 'orders'
    and coalesce(btrim(p_data ->> 'customer'), '') <> ''
    and not exists (
      select 1
      from public.crm_records as customer
      where customer.organization_id = v_organization_id
        and customer.branch_id is not distinct from p_branch_id
        and customer.module = 'customers'
        and (
          (customer_phone <> ''
            and regexp_replace(coalesce(customer.data ->> 'phone', ''), '[^0-9]', '', 'g') = customer_phone)
          or (customer_email <> ''
            and lower(btrim(coalesce(customer.data ->> 'email', ''))) = customer_email)
        )
    ) then
    insert into public.crm_records (organization_id, branch_id, module, data, created_by)
    values (
      v_organization_id,
      p_branch_id,
      'customers',
      jsonb_build_object(
        'name', btrim(p_data ->> 'customer'),
        'phone', nullif(btrim(coalesce(p_data ->> 'phone', '')), ''),
        'email', nullif(customer_email, ''),
        'notes', 'Добавлен автоматически из заказа №' || next_number::text
      ),
      auth.uid()
    );
  end if;

  return new_record;
end;
$$;
