-- Operator accounts and approval requests.
-- Run this after schema.sql and admin_table.sql.

do $$ begin
  create type public.approval_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

create table if not exists public.operator_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  status public.account_status not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.account_approvals (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  requested_role text not null default 'Operator' check (requested_role in ('Admin', 'Operator')),
  status public.approval_status not null default 'pending',
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.operator_accounts enable row level security;
alter table public.account_approvals enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.operator_accounts to anon, authenticated;
grant select on public.account_approvals to anon, authenticated;
grant insert on public.account_approvals to anon, authenticated;
grant insert on public.operator_accounts, public.admin_accounts to authenticated;
grant delete on public.operator_accounts, public.admin_accounts to authenticated;
grant update on public.account_approvals to authenticated;

drop policy if exists "prototype read operators" on public.operator_accounts;
create policy "prototype read operators" on public.operator_accounts for select to anon, authenticated using (true);
drop policy if exists "prototype read approvals" on public.account_approvals;
create policy "prototype read approvals" on public.account_approvals for select to anon, authenticated using (true);
drop policy if exists "prototype submit approval" on public.account_approvals;
create policy "prototype submit approval" on public.account_approvals for insert to anon, authenticated with check (status = 'pending');
drop policy if exists "prototype approve account" on public.account_approvals;
create policy "prototype approve account" on public.account_approvals for update to authenticated using (true) with check (status in ('pending', 'approved', 'rejected'));
drop policy if exists "prototype manage admins" on public.admin_accounts;
create policy "prototype manage admins" on public.admin_accounts for delete to authenticated using (true);
drop policy if exists "prototype manage operators" on public.operator_accounts;
create policy "prototype manage operators" on public.operator_accounts for delete to authenticated using (true);
