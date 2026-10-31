-- Run after inventory_checks.sql. Safe to rerun. Preserves existing data.
begin;
create index if not exists user_accounts_email_lookup_idx on public.user_accounts(lower(email));
create index if not exists user_accounts_name_lookup_idx on public.user_accounts(full_name,id);
create index if not exists borrowers_name_lookup_idx on public.borrowers(name,id);
create index if not exists account_approvals_pending_lookup_idx on public.account_approvals(created_at desc,id) where status='pending';

create or replace function public.inventory_has_active_account() returns boolean
language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and exists(select 1 from public.user_accounts
    where lower(email)=lower(auth.jwt()->>'email') and status='active')
$$;
create or replace function public.inventory_can_access_laboratory(p_laboratory_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and p_laboratory_id is not null and (
    public.inventory_is_system_admin() or exists(select 1 from public.user_accounts u
      join public.laboratory_memberships m on m.user_id=u.id
      where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active'
        and m.laboratory_id=p_laboratory_id and m.role in ('Laboratory Admin','Laboratory Operator')))
$$;
revoke all on function public.inventory_has_active_account(),public.inventory_can_access_laboratory(uuid) from public,anon;
grant execute on function public.inventory_has_active_account(),public.inventory_can_access_laboratory(uuid) to authenticated;

-- Restrictive policies also constrain the permissive prototype policies left
-- by older installations. Anonymous users can still submit pending requests.
revoke select on public.user_accounts,public.account_approvals,public.laboratories,
  public.shelves,public.inventory_units,public.borrowers,public.transactions,
  public.stock_movements,public.inventory_checks from public,anon;
drop policy if exists "require own account or system admin" on public.user_accounts;
create policy "require own account or system admin" on public.user_accounts as restrictive for select to authenticated
  using(auth.uid() is not null and (lower(email)=lower(auth.jwt()->>'email') or public.inventory_is_system_admin()));
drop policy if exists "require system admin for approvals" on public.account_approvals;
create policy "require system admin for approvals" on public.account_approvals as restrictive for select to authenticated
  using(public.inventory_is_system_admin());
revoke update,delete on public.user_accounts,public.account_approvals from public,anon,authenticated;

drop policy if exists "require laboratory visibility" on public.laboratories;
create policy "require laboratory visibility" on public.laboratories as restrictive for all to authenticated
  using(public.inventory_is_system_admin() or public.inventory_can_access_laboratory(id))
  with check(public.inventory_is_system_admin() or public.inventory_can_access_laboratory(id));
-- Inventory functions lock laboratory rows before changing shelves. Allow those
-- locks for members; a trigger separately protects actual laboratory mutations.
create or replace function public.inventory_guard_laboratory_administration() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if not public.inventory_is_system_admin() then raise exception 'Only a System Admin can manage laboratories'; end if;
  if TG_OP='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists inventory_guard_laboratory_administration on public.laboratories;
create trigger inventory_guard_laboratory_administration before insert or update or delete on public.laboratories
  for each row execute function public.inventory_guard_laboratory_administration();
-- Deletion must see shelves outside the administrator's personal memberships.
alter function public.inventory_guard_laboratory_delete() security definer;

drop policy if exists "require assigned shelf" on public.shelves;
create policy "require assigned shelf" on public.shelves as restrictive for all to authenticated
  using(public.inventory_can_access_laboratory(laboratory_id))
  with check(public.inventory_can_access_laboratory(laboratory_id));
drop policy if exists "require assigned inventory" on public.inventory_units;
create policy "require assigned inventory" on public.inventory_units as restrictive for all to authenticated
  using(exists(select 1 from public.shelves s where s.id=shelf_id and public.inventory_can_access_laboratory(s.laboratory_id)))
  with check(exists(select 1 from public.shelves s where s.id=shelf_id and public.inventory_can_access_laboratory(s.laboratory_id)));
drop policy if exists "require assigned transactions" on public.transactions;
create policy "require assigned transactions" on public.transactions as restrictive for all to authenticated
  using(public.inventory_can_access_laboratory(laboratory_id)) with check(public.inventory_can_access_laboratory(laboratory_id));
drop policy if exists "require assigned movements" on public.stock_movements;
create policy "require assigned movements" on public.stock_movements as restrictive for all to authenticated
  using(public.inventory_can_access_laboratory(laboratory_id)) with check(public.inventory_can_access_laboratory(laboratory_id));
drop policy if exists "require active borrower access" on public.borrowers;
create policy "require active borrower access" on public.borrowers as restrictive for all to authenticated
  using(public.inventory_has_active_account()) with check(public.inventory_has_active_account());

create or replace function public.inventory_approve_account(p_approval_id uuid,p_role text) returns uuid
language plpgsql security definer set search_path=public as $$
declare request public.account_approvals; reviewer text; account_id uuid;
begin
  perform pg_advisory_xact_lock(724144,1);
  if not public.inventory_is_system_admin() then raise exception 'Only a System Admin can approve accounts'; end if;
  if p_role is null or p_role not in ('Admin','Operator') then raise exception 'Choose a valid account role'; end if;
  select * into request from public.account_approvals where id=p_approval_id for update;
  if not found or request.status::text<>'pending' then raise exception 'This request was already reviewed or no longer exists'; end if;
  if nullif(trim(request.full_name),'') is null or nullif(trim(request.email),'') is null then raise exception 'The request needs a name and email'; end if;
  if exists(select 1 from public.user_accounts where lower(email)=lower(trim(request.email))) then
    raise exception 'This email already has an account. Manage its roles through Users'; end if;
  select coalesce(nullif(full_name,''),email) into reviewer from public.user_accounts where lower(email)=lower(auth.jwt()->>'email');
  insert into public.user_accounts(full_name,email,role,status)
    values(trim(request.full_name),lower(trim(request.email)),p_role::public.user_role,'active') returning id into account_id;
  update public.account_approvals set status='approved',requested_role=p_role::public.user_role,
    reviewed_by=reviewer,reviewed_at=now() where id=request.id;
  return account_id;
end $$;
revoke all on function public.inventory_approve_account(uuid,text) from public,anon;
grant execute on function public.inventory_approve_account(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
