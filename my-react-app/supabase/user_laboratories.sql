-- Run after user account setup and inventory_laboratories.sql. Safe to rerun.
-- Records laboratory responsibilities. Inventory RLS is unchanged by this migration.
begin;

create table if not exists public.laboratory_memberships (
  user_id uuid not null references public.user_accounts(id) on delete cascade,
  laboratory_id uuid not null references public.laboratories(id) on delete cascade,
  role text not null check (role in ('Laboratory Admin', 'Laboratory Operator')),
  primary key (user_id, laboratory_id)
);
create index if not exists laboratory_memberships_laboratory_idx on public.laboratory_memberships(laboratory_id);
alter table public.laboratory_memberships enable row level security;

-- Existing Admin accounts are System Admins. Laboratory Admin is a separate
-- membership role and never grants system administration privileges.
create or replace function public.inventory_is_system_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.user_accounts
    where lower(email) = lower(auth.jwt()->>'email') and role = 'Admin' and status = 'active'
  )
$$;
revoke all on function public.inventory_is_system_admin() from public, anon;
grant execute on function public.inventory_is_system_admin() to authenticated;

revoke all on public.laboratory_memberships from anon, authenticated;
grant select on public.laboratory_memberships to authenticated;
drop policy if exists "read laboratory memberships" on public.laboratory_memberships;
create policy "read laboratory memberships" on public.laboratory_memberships for select to authenticated
using (public.inventory_is_system_admin() or exists (
  select 1 from public.user_accounts u where u.id = user_id
    and lower(u.email) = lower(auth.jwt()->>'email') and u.status = 'active' and auth.uid() is not null
));

-- Prevent the old prototype's broad account policies from allowing an operator
-- to promote themselves. Role updates go through the atomic function below.
revoke update, delete on public.user_accounts from authenticated, anon;
drop policy if exists "system admin creates accounts" on public.user_accounts;
create policy "system admin creates accounts" on public.user_accounts for insert to authenticated
with check (public.inventory_is_system_admin());
drop policy if exists "require system admin for account creation" on public.user_accounts;
create policy "require system admin for account creation" on public.user_accounts as restrictive for insert to authenticated
with check (public.inventory_is_system_admin());

create or replace function public.inventory_save_user_assignments(
  p_user_id uuid, p_system_role text, p_assignments jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare target public.user_accounts; assignment record;
begin
  -- Serialize changes so two concurrent demotions cannot remove every admin.
  perform pg_advisory_xact_lock(724144, 1);
  if not public.inventory_is_system_admin() then
    raise exception 'Only a System Admin can manage user assignments';
  end if;
  if p_system_role is null or p_system_role not in ('Admin', 'Operator') then
    raise exception 'Choose a valid system role';
  end if;
  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    raise exception 'Provide laboratory assignments as a list';
  end if;
  select * into target from public.user_accounts where id = p_user_id for update;
  if not found then raise exception 'User not found. Refresh the Users page'; end if;
  if target.role = 'Admin' and target.status = 'active' and p_system_role <> 'Admin'
    and not exists (select 1 from public.user_accounts where id <> p_user_id and role = 'Admin' and status = 'active') then
    raise exception 'Keep at least one active System Admin';
  end if;
  for assignment in select * from jsonb_to_recordset(p_assignments) as x(laboratory_id uuid, role text) loop
    if assignment.laboratory_id is null or assignment.role is null
      or assignment.role not in ('Laboratory Admin', 'Laboratory Operator') then
      raise exception 'Choose a laboratory and a valid laboratory role for each assignment';
    end if;
    perform 1 from public.laboratories where id = assignment.laboratory_id for key share;
    if not found then raise exception 'Laboratory not found. Refresh the Users page'; end if;
  end loop;
  if exists (select 1 from jsonb_to_recordset(p_assignments) as x(laboratory_id uuid)
    group by laboratory_id having count(*) > 1) then
    raise exception 'Assign each laboratory only once per user';
  end if;
  update public.user_accounts set role = p_system_role::public.user_role where id = p_user_id;
  delete from public.laboratory_memberships where user_id = p_user_id;
  insert into public.laboratory_memberships(user_id, laboratory_id, role)
    select p_user_id, x.laboratory_id, x.role
    from jsonb_to_recordset(p_assignments) as x(laboratory_id uuid, role text);
end $$;
revoke all on function public.inventory_save_user_assignments(uuid,text,jsonb) from public, anon;
grant execute on function public.inventory_save_user_assignments(uuid,text,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
