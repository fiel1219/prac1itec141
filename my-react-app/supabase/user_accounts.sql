-- Canonical account setup. Run after schema.sql and before user_laboratories.sql.
-- Safe to rerun. Does not create sample users or change existing account roles.
begin;

do $$ begin
  create type public.user_role as enum ('Admin', 'Operator');
exception when duplicate_object then null;
end $$;

create table if not exists public.user_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  role public.user_role not null default 'Operator',
  status public.account_status not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.account_approvals (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  requested_role public.user_role not null default 'Operator',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Older setup variants used assigned_role or reviewed_role. Normalize their
-- values once so the current registration/approval flow has its required field.
do $$ begin
  if not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='account_approvals' and column_name='requested_role') then
    alter table public.account_approvals add column requested_role public.user_role not null default 'Operator';
    if exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='account_approvals' and column_name='assigned_role') then
      execute 'update public.account_approvals set requested_role=assigned_role::text::public.user_role where assigned_role is not null';
    elsif exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='account_approvals' and column_name='reviewed_role') then
      execute 'update public.account_approvals set requested_role=reviewed_role::text::public.user_role where reviewed_role is not null';
    end if;
  end if;
end $$;

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

commit;
