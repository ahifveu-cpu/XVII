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
  if v_organization_id is null or not public.is_organization_manager() then
    raise exception 'Удалять филиалы может только владелец, администратор или менеджер';
  end if;
  if p_branch_id is null or p_target_branch_id is null or p_branch_id = p_target_branch_id then
    raise exception 'Выберите другой филиал для переноса данных';
  end if;

  select branch.*
    into v_source
    from public.crm_records as branch
    where branch.id = p_branch_id
      and branch.organization_id = v_organization_id
      and branch.module = 'branches'
    for update;
  if not found then
    raise exception 'Удаляемый филиал не найден в вашей организации';
  end if;

  select branch.*
    into v_target
    from public.crm_records as branch
    where branch.id = p_target_branch_id
      and branch.organization_id = v_organization_id
      and branch.module = 'branches'
    for update;
  if not found then
    raise exception 'Филиал для переноса не найден в вашей организации';
  end if;

  v_source_name := coalesce(nullif(btrim(v_source.data ->> 'branch'), ''), nullif(btrim(v_source.data ->> 'name'), ''), 'Филиал');
  v_target_name := coalesce(nullif(btrim(v_target.data ->> 'branch'), ''), nullif(btrim(v_target.data ->> 'name'), ''), 'Филиал');

  perform set_config('qos.allow_branch_transfer', 'on', true);

  update public.crm_records as record
    set branch_id = p_target_branch_id
    where record.organization_id = v_organization_id
      and record.branch_id = p_branch_id;
  get diagnostics v_records_moved = row_count;

  update public.organization_members as member
    set branch_id = p_target_branch_id
    where member.organization_id = v_organization_id
      and member.branch_id = p_branch_id;
  get diagnostics v_members_moved = row_count;

  perform set_config('qos.allow_branch_transfer', 'off', true);

  delete from public.crm_records as branch
    where branch.id = p_branch_id
      and branch.organization_id = v_organization_id
      and branch.module = 'branches';

  return jsonb_build_object(
    'deleted_branch', v_source_name,
    'target_branch', v_target_name,
    'records_moved', v_records_moved,
    'members_moved', v_members_moved
  );
end;
$$;

revoke all on function public.delete_crm_branch(uuid, uuid) from public, anon;
grant execute on function public.delete_crm_branch(uuid, uuid) to authenticated;
