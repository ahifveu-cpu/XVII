alter table public.crm_records
  add column if not exists cash_paid_total numeric(12, 2) not null default 0
    check (cash_paid_total >= 0),
  add column if not exists cashless_paid_total numeric(12, 2) not null default 0
    check (cashless_paid_total >= 0);

update public.crm_records as orders
set cash_paid_total = coalesce((
      select sum(nullif(replace(regexp_replace(coalesce(ledger.data ->> 'amount', ''), '[^0-9,.]', '', 'g'), ',', '.'), '')::numeric)
      from public.crm_records as ledger
      where ledger.organization_id = orders.organization_id
        and ledger.module = 'finance'
        and ledger.data ->> 'order_id' = orders.id::text
        and ledger.data ->> 'payment' = 'Наличные'
    ), case when orders.payment_method = 'cash' then orders.paid_total else 0 end),
    cashless_paid_total = coalesce((
      select sum(nullif(replace(regexp_replace(coalesce(ledger.data ->> 'amount', ''), '[^0-9,.]', '', 'g'), ',', '.'), '')::numeric)
      from public.crm_records as ledger
      where ledger.organization_id = orders.organization_id
        and ledger.module = 'finance'
        and ledger.data ->> 'order_id' = orders.id::text
        and ledger.data ->> 'payment' = 'Безналичные'
    ), case when orders.payment_method = 'cashless' then orders.paid_total else 0 end)
where orders.module = 'orders';

create or replace function public.touch_crm_record()
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
      new.cash_paid_total := 0;
      new.cashless_paid_total := 0;
      new.payment_method := null;
      new.payment_status := 'Не оплачено';
      new.data := new.data
        - '_record_id'
        - '_created_at'
        - 'paid_amount'
        - 'cash_paid_total'
        - 'cashless_paid_total'
        - 'payment_method'
        - 'payment_status';
    else
      if new.order_number is distinct from old.order_number
        or new.paid_total is distinct from old.paid_total
        or new.cash_paid_total is distinct from old.cash_paid_total
        or new.cashless_paid_total is distinct from old.cashless_paid_total
        or new.payment_method is distinct from old.payment_method
        or new.payment_status is distinct from old.payment_status then
        if current_user <> 'postgres' then
          raise exception 'Номер заказа и сведения об оплате изменяются только защищённой операцией оплаты';
        end if;
      end if;
      if new.total < old.paid_total then
        raise exception 'Сумма заказа меньше уже внесённой оплаты';
      end if;
    end if;

    if nullif(new.data ->> 'status', '') in ('Выдан', 'Закрыт')
      and coalesce(new.paid_total, 0) < coalesce(new.total, 0) then
      raise exception 'Заказ нельзя выдать или закрыть до полной оплаты';
    end if;

    new.status := nullif(new.data ->> 'status', '');
    new.data := new.data || jsonb_build_object(
      'number', new.order_number::text,
      'amount', coalesce(new.total, 0)::text || ' ₽',
      'paid_amount', new.paid_total::text || ' ₽',
      'cash_paid_total', new.cash_paid_total,
      'cashless_paid_total', new.cashless_paid_total,
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

create or replace function public.protect_order_payment_ledger()
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
      or (
        new.branch_id is distinct from old.branch_id
        and not (
          current_user = 'postgres'
          and current_setting('qos.allow_branch_transfer', true) = 'on'
          and new.data is not distinct from old.data
          and new.module is not distinct from old.module
        )
      )
    ) then
    raise exception 'Платёж по заказу нельзя изменить вручную';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

update public.crm_records
set data = data || jsonb_build_object('status', 'Закрыт')
where module = 'orders'
  and total > 0
  and paid_total >= total
  and coalesce(status, '') not in ('Закрыт', 'Выдан');

create or replace function public.record_order_payment_split(
  p_order_id uuid,
  p_cash_amount numeric,
  p_cashless_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := public.current_organization_id();
  current_order public.crm_records;
  updated_order public.crm_records;
  cash_transaction public.crm_records;
  cashless_transaction public.crm_records;
  v_cash_amount numeric(12, 2) := coalesce(p_cash_amount, 0);
  v_cashless_amount numeric(12, 2) := coalesce(p_cashless_amount, 0);
  v_total_payment numeric(12, 2);
  v_method text;
  v_payment_status text;
  v_status text;
begin
  if v_organization_id is null then
    raise exception 'Войдите в QoS с активной учётной записью';
  end if;
  if v_cash_amount < 0 or v_cashless_amount < 0
    or v_cash_amount > 9999999999.99 or v_cashless_amount > 9999999999.99
    or v_cash_amount + v_cashless_amount <= 0 then
    raise exception 'Укажите сумму оплаты наличными и/или безналично';
  end if;
  v_total_payment := v_cash_amount + v_cashless_amount;

  select record.* into current_order
    from public.crm_records as record
    where record.id = p_order_id
      and record.organization_id = v_organization_id
      and record.module = 'orders'
    for update;
  if not found then
    raise exception 'Заказ не найден или у вас нет доступа к нему';
  end if;
  if current_order.paid_total + v_total_payment > current_order.total then
    raise exception 'Сумма оплаты превышает остаток по заказу';
  end if;

  v_payment_status := case
    when current_order.paid_total + v_total_payment >= current_order.total then 'Оплачен'
    else 'Оплачен частично'
  end;
  v_status := case
    when current_order.paid_total + v_total_payment >= current_order.total then 'Закрыт'
    else coalesce(current_order.status, 'Новый')
  end;
  v_method := case
    when current_order.cash_paid_total + v_cash_amount > 0
      and current_order.cashless_paid_total + v_cashless_amount > 0 then null
    when v_cash_amount > 0 then 'cash'
    else 'cashless'
  end;

  update public.crm_records as record
    set paid_total = record.paid_total + v_total_payment,
        cash_paid_total = record.cash_paid_total + v_cash_amount,
        cashless_paid_total = record.cashless_paid_total + v_cashless_amount,
        payment_method = v_method,
        payment_status = v_payment_status,
        data = record.data || jsonb_build_object(
          'status', v_status,
          'payment_method', coalesce(v_method, ''),
          'payment_status', v_payment_status,
          'cash_paid_total', record.cash_paid_total + v_cash_amount,
          'cashless_paid_total', record.cashless_paid_total + v_cashless_amount
        )
    where record.id = p_order_id
      and record.organization_id = v_organization_id
    returning record.* into updated_order;

  if v_cash_amount > 0 then
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
        'payment', 'Наличные',
        'amount', '+' || to_char(v_cash_amount, 'FM9999999990D00') || ' ₽',
        'order_id', p_order_id
      ),
      auth.uid()
    )
    returning * into cash_transaction;
  end if;

  if v_cashless_amount > 0 then
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
        'payment', 'Безналичные',
        'amount', '+' || to_char(v_cashless_amount, 'FM9999999990D00') || ' ₽',
        'order_id', p_order_id
      ),
      auth.uid()
    )
    returning * into cashless_transaction;
  end if;

  return jsonb_build_object(
    'order', to_jsonb(updated_order),
    'transactions', jsonb_strip_nulls(jsonb_build_array(
      case when cash_transaction.id is not null then to_jsonb(cash_transaction) end,
      case when cashless_transaction.id is not null then to_jsonb(cashless_transaction) end
    ))
  );
end;
$$;

create or replace function public.record_order_payment(p_order_id uuid, p_amount numeric, p_method text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_method = 'cash' then
    return public.record_order_payment_split(p_order_id, p_amount, 0);
  elsif p_method = 'cashless' then
    return public.record_order_payment_split(p_order_id, 0, p_amount);
  end if;
  raise exception 'Выберите наличную или безналичную оплату';
end;
$$;

revoke all on function public.record_order_payment_split(uuid, numeric, numeric) from public, anon;
grant execute on function public.record_order_payment_split(uuid, numeric, numeric) to authenticated;
