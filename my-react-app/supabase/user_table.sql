-- Combined Admin and Operator account table.
-- Run this file in Supabase SQL Editor.

do $$ begin
  create type public.user_role as enum ('Admin', 'Operator');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.approval_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

create table if not exists public.user_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  role public.user_role not null,
  status public.account_status not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.account_approvals (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  status public.approval_status not null default 'pending',
  reviewed_role public.user_role,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.user_accounts enable row level security;
alter table public.account_approvals enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.user_accounts, public.account_approvals to anon, authenticated;
grant insert on public.account_approvals to anon, authenticated;
grant insert, update on public.user_accounts, public.account_approvals to authenticated;

drop policy if exists "prototype read users" on public.user_accounts;
create policy "prototype read users" on public.user_accounts for select to anon, authenticated using (true);
drop policy if exists "prototype manage users" on public.user_accounts;
create policy "prototype manage users" on public.user_accounts for all to authenticated using (true) with check (true);
drop policy if exists "prototype read approvals combined" on public.account_approvals;
create policy "prototype read approvals combined" on public.account_approvals for select to anon, authenticated using (true);
drop policy if exists "prototype submit approvals combined" on public.account_approvals;
create policy "prototype submit approvals combined" on public.account_approvals for insert to anon, authenticated with check (status = 'pending');
drop policy if exists "prototype update approvals combined" on public.account_approvals;
create policy "prototype update approvals combined" on public.account_approvals for update to authenticated using (true) with check (true);
