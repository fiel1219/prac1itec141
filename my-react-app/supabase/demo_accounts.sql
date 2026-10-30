-- Run the ENTIRE script in Supabase SQL Editor after user_accounts is set up.
-- Creates confirmed Auth logins AND active application accounts.
-- The Admin application role is System Admin; no laboratory assignment is needed
-- to manage users and laboratories.
-- Demo credentials are intentionally public in the app. Use a demo database.
-- Rerunning resets only these demo passwords; other users are untouched.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
set local search_path = public, extensions, pg_catalog;

do $demo$
declare
  account record;
  account_id uuid;
  existing_metadata jsonb;
begin
  for account in select * from (values
    ('Demo System Admin', 'demo.admin@inventoscan.test', 'InventoAdmin2026!', 'Admin'),
    ('Demo Operator', 'demo.operator@inventoscan.test', 'InventoOperator2026!', 'Operator')
  ) as accounts(full_name, email, password, app_role)
  loop
    select id, raw_user_meta_data into account_id, existing_metadata
      from auth.users where lower(email) = account.email;
    if account_id is not null and coalesce(existing_metadata->>'is_demo', 'false') <> 'true' then
      raise exception 'Email % belongs to a non-demo user. No accounts were changed.', account.email;
    end if;
    account_id := coalesce(account_id, gen_random_uuid());

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', account_id, 'authenticated', 'authenticated',
      account.email, crypt(account.password, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', account.full_name, 'is_demo', true), now(), now(),
      '', '', '', '', '', ''
    ) on conflict (id) do update set
      encrypted_password = excluded.encrypted_password,
      email_confirmed_at = coalesce(auth.users.email_confirmed_at, now()),
      raw_user_meta_data = coalesce(auth.users.raw_user_meta_data, '{}'::jsonb) || excluded.raw_user_meta_data,
      raw_app_meta_data = coalesce(auth.users.raw_app_meta_data, '{}'::jsonb) || excluded.raw_app_meta_data,
      updated_at = now();

    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider, created_at, updated_at
    ) values (
      gen_random_uuid(), account_id, account_id::text,
      jsonb_build_object('sub', account_id::text, 'email', account.email, 'email_verified', true),
      'email', now(), now()
    ) on conflict (provider_id, provider) do update set
      identity_data = excluded.identity_data, updated_at = now();

    insert into public.user_accounts (full_name, email, role, status)
      values (account.full_name, account.email, account.app_role::public.user_role, 'active')
      on conflict (email) do update set full_name = excluded.full_name,
        role = excluded.role, status = excluded.status;
  end loop;
end $demo$;
commit;

select full_name, email, role, status from public.user_accounts
where email in ('demo.admin@inventoscan.test', 'demo.operator@inventoscan.test');
