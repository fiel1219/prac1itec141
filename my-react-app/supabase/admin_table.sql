-- Admin accounts table only.
-- Run this after the main schema.sql file.

do $$ begin
  create type public.account_status as enum ('active', 'disabled');
exception when duplicate_object then null;
end $$;

create table if not exists public.admin_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  status public.account_status not null default 'active',
  created_at timestamptz not null default now()
);

alter table public.admin_accounts enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.admin_accounts to anon, authenticated;

drop policy if exists "prototype read admins" on public.admin_accounts;
create policy "prototype read admins"
on public.admin_accounts
for select
to anon, authenticated
using (true);
