create or replace function public.record_order_payment(p_order_id uuid, p_amount numeric, p_method text)
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

  select record.* into current_order
    from public.crm_records as record
    where record.id = p_order_id
      and record.organization_id = v_organization_id
      and record.module = 'orders'
    for update;

  if not found then
    raise exception 'Заказ не найден или у вас нет доступа к нему';
  end if;
  if current_order.paid_total + p_amount > current_order.total then
    raise exception 'Сумма оплаты превышает остаток по заказу';
  end if;

  update public.crm_records as record
    set paid_total = record.paid_total + p_amount,
        payment_method = p_method,
        payment_status = case
          when record.paid_total + p_amount >= record.total then 'Оплачен'
          else 'Оплачен частично'
        end,
        data = record.data || jsonb_build_object(
          'payment_method', p_method,
          'payment_status', case
            when record.paid_total + p_amount >= record.total then 'Оплачен'
            else 'Оплачен частично'
          end
        )
    where record.id = p_order_id
      and record.organization_id = v_organization_id
    returning record.* into updated_order;

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
