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
