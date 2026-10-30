-- Run after security_hardening.sql as the database owner. Safe to rerun.
begin;

create or replace function public.inventory_delete_user_account(
  p_user_id uuid, p_confirmation_email text
) returns void language plpgsql security definer set search_path = '' as $$
declare target public.user_accounts; auth_ids uuid[];
begin
  -- Share the role-management lock so deletion and demotion cannot race to
  -- remove the last active System Admin.
  perform pg_catalog.pg_advisory_xact_lock(724144, 1);
  if not public.inventory_is_system_admin() then
    raise exception 'Only a System Admin can delete accounts';
  end if;
  select * into target from public.user_accounts where id = p_user_id for update;
  if not found then raise exception 'User not found. Refresh the Users page'; end if;
  if p_confirmation_email is null or lower(trim(p_confirmation_email)) <> lower(target.email) then
    raise exception 'Enter the account email to confirm deletion';
  end if;
  if target.role = 'Admin' and target.status = 'active'
    and not exists(select 1 from public.user_accounts where id <> target.id and role = 'Admin' and status = 'active') then
    raise exception 'Keep at least one active System Admin';
  end if;
  if lower(target.email) = lower(auth.jwt()->>'email') then
    raise exception 'You cannot delete your own signed-in account';
  end if;
  if exists(select 1 from public.user_accounts where id <> target.id and lower(email) = lower(target.email)) then
    raise exception 'Multiple application accounts match this email. Resolve the duplicate profiles before deleting it';
  end if;

  -- Application IDs are independent of Auth IDs; match the login by email.
  select array_agg(id) into auth_ids from auth.users where lower(email) = lower(target.email);
  if cardinality(auth_ids) > 1 then
    raise exception 'Multiple sign-in accounts match this email. Resolve them in Supabase Auth first';
  end if;
  if auth.uid() = any(auth_ids) then
    raise exception 'You cannot delete your own signed-in account';
  end if;
  delete from auth.users where id = auth_ids[1];
  -- Remove the registration row as well so the email can request access again.
  delete from public.account_approvals where lower(email) = lower(target.email);
  -- Laboratory memberships cascade. Historical inventory records retain their
  -- actor snapshots and are deliberately left intact.
  delete from public.user_accounts where id = target.id;
exception when foreign_key_violation then
  raise exception 'This account still owns dependent records. Transfer its owned records or files before deleting it';
end $$;

revoke all on function public.inventory_delete_user_account(uuid,text) from public, anon;
grant execute on function public.inventory_delete_user_account(uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
