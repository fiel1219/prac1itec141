-- Combined Admin and Operator user tables.
-- Run this in Supabase after the main schema, if the old admin/operator tables were deleted.

do $$ begin
  create type public.user_role as enum ('Admin', 'Operator');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.user_account_status as enum ('active', 'disabled');
exception when duplicate_object then null;
end $$;

create table if not exists public.user_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  role public.user_role not null default 'Operator',
  status public.user_account_status not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.account_approvals (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  assigned_role public.user_role not null default 'Operator',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
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

drop policy if exists "read user accounts" on public.user_accounts;
create policy "read user accounts" on public.user_accounts
for select to anon, authenticated using (true);

drop policy if exists "submit account approval" on public.account_approvals;
create policy "submit account approval" on public.account_approvals
for insert to anon, authenticated with check (status = 'pending');

drop policy if exists "read account approvals" on public.account_approvals;
create policy "read account approvals" on public.account_approvals
for select to authenticated using (true);

drop policy if exists "manage account approvals" on public.account_approvals;
create policy "manage account approvals" on public.account_approvals
for update to authenticated using (true) with check (status in ('pending', 'approved', 'rejected'));

drop policy if exists "manage user accounts" on public.user_accounts;
create policy "manage user accounts" on public.user_accounts
for insert to authenticated with check (true);

-- Sample combined users.
insert into public.user_accounts (full_name, email, role, status)
values
  ('System Admin', 'admin@stockly.test', 'Admin', 'active'),
  ('Mark Lee', 'mark.lee@stockly.edu', 'Operator', 'active')
on conflict (email) do update
set role = excluded.role, status = excluded.status;
