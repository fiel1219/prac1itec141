-- Run after inventory_check_quantities.sql, as the database owner.
-- New Auth users and pending requests commit together. Safe to rerun.
begin;

create or replace function public.inventory_create_registration_request(p_email text, p_full_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare normalized_email text := lower(trim(p_email));
begin
  -- Phone-only users are outside this application's email registration flow.
  if nullif(normalized_email, '') is null then return; end if;
  if exists(select 1 from public.user_accounts where lower(trim(email)) = normalized_email)
    or exists(select 1 from public.account_approvals where lower(trim(email)) = normalized_email) then
    return;
  end if;
  insert into public.account_approvals(full_name, email, requested_role, status)
    values(coalesce(nullif(trim(p_full_name), ''), normalized_email), normalized_email, 'Operator', 'pending')
    on conflict(email) do nothing;
end $$;
revoke all on function public.inventory_create_registration_request(text, text) from public, anon, authenticated;

create or replace function public.inventory_on_auth_registration()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.inventory_create_registration_request(new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end $$;
revoke all on function public.inventory_on_auth_registration() from public, anon, authenticated;

drop trigger if exists inventoscan_registration_request on auth.users;
create trigger inventoscan_registration_request after insert on auth.users
  for each row execute function public.inventory_on_auth_registration();

-- Recover Auth accounts left behind by the old two-write signup flow.
-- Existing profiles and reviewed/pending requests are preserved, including roles.
do $$
declare account record;
begin
  for account in select email, raw_user_meta_data ->> 'full_name' as full_name from auth.users loop
    perform public.inventory_create_registration_request(account.email, account.full_name);
  end loop;
end $$;

-- Registration no longer accepts approval rows supplied by anonymous clients.
revoke insert on public.account_approvals from public, anon, authenticated;
drop policy if exists "submit account approval" on public.account_approvals;

-- The browser checks this before signup to avoid using an unupgraded backend.
create or replace function public.inventory_registration_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from pg_catalog.pg_trigger
    where tgrelid = 'auth.users'::pg_catalog.regclass
      and tgname = 'inventoscan_registration_request'
      and tgfoid = 'public.inventory_on_auth_registration()'::pg_catalog.regprocedure
      and tgenabled in ('O', 'A'));
$$;
revoke all on function public.inventory_registration_ready() from public;
grant execute on function public.inventory_registration_ready() to anon, authenticated;

commit;
