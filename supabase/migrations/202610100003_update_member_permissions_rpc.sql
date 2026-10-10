create or replace function public.update_member_permissions(p_user_id uuid, p_permissions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := public.current_organization_id();
  saved_permissions jsonb;
begin
  if v_organization_id is null or not exists (
    select 1
    from public.organization_members as actor
    where actor.user_id = (select auth.uid())
      and actor.organization_id = v_organization_id
      and actor.status = 'active'
      and actor.role = 'owner'
  ) then
    raise exception 'Настраивать права сотрудников может только владелец компании';
  end if;
  if not public.has_active_subscription() then
    raise exception 'Пробный период закончился. Продлите подписку перед изменением прав сотрудников';
  end if;
  if p_user_id is null or jsonb_typeof(p_permissions) <> 'object' then
    raise exception 'Укажите сотрудника и объект разрешений';
  end if;
  if exists (
    select 1
    from jsonb_each(p_permissions) as permission(key, value)
    where permission.key !~ '^(dashboard|orders|customers|tasks|calendar|inventory|services|finance|documents|reports|automation|team|branches|settings|billing)\.(view|create|edit|delete|import|export)$|^(orders\.pay|orders\.receipt|team\.manage|settings\.receipt|billing\.manage)$'
      or jsonb_typeof(permission.value) <> 'boolean'
  ) then
    raise exception 'Список разрешений содержит неизвестные ключи или некорректные значения';
  end if;

  update public.organization_members as target
    set permissions = (
      select jsonb_object_agg(permission.key, permission.value)
      from jsonb_each(
        '{"dashboard.view":true,"orders.view":true,"customers.view":true,"tasks.view":true,"calendar.view":true,"inventory.view":true,"services.view":true,"finance.view":true,"documents.view":true,"reports.view":true,"automation.view":true,"team.view":true,"branches.view":true,"settings.view":true,"billing.view":true}'::jsonb
        || p_permissions
      ) as permission(key, value)
    )
    where target.user_id = p_user_id
      and target.organization_id = v_organization_id
      and target.role <> 'owner'
    returning target.permissions into saved_permissions;

  if not found then
    raise exception 'Сотрудник не найден в вашей компании или является владельцем';
  end if;
  return saved_permissions;
end;
$$;

revoke all on function public.update_member_permissions(uuid, jsonb) from public, anon;
grant execute on function public.update_member_permissions(uuid, jsonb) to authenticated;
