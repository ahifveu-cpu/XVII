create or replace function public.handle_new_auth_user()
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
  end if;

  return new;
end;
$$;

do $$
begin
  perform set_config('qos.allow_branch_transfer', 'on', true);

  update public.crm_records as record
    set branch_id = null
    from public.crm_records as branch
    where branch.module = 'branches'
      and branch.data ->> 'branch' = 'Центральный'
      and branch.data ->> 'employees' = '1 сотрудник'
      and record.branch_id = branch.id;

  update public.organization_members as member
    set branch_id = null
    from public.crm_records as branch
    where branch.module = 'branches'
      and branch.data ->> 'branch' = 'Центральный'
      and branch.data ->> 'employees' = '1 сотрудник'
      and member.branch_id = branch.id;

  delete from public.crm_records as branch
    where branch.module = 'branches'
      and branch.data ->> 'branch' = 'Центральный'
      and branch.data ->> 'employees' = '1 сотрудник'
      and not exists (
        select 1
        from public.crm_records as record
        where record.branch_id = branch.id
      )
      and not exists (
        select 1
        from public.organization_members as member
        where member.branch_id = branch.id
      );
end;
$$;
