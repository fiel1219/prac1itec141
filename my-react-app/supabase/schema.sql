-- Stockly inventory schema. Run this once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create type public.unit_status as enum ('available','borrowed','missing','under_maintenance','not_found');
create type public.unit_condition as enum ('good','damaged');
create type public.shelf_status as enum ('active','archived');
create type public.account_status as enum ('active','disabled');

create table public.shelves (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  item_type text not null,
  status public.shelf_status not null default 'active',
  qr_value text not null unique,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.inventory_units (
  id uuid primary key default gen_random_uuid(),
  shelf_id uuid not null references public.shelves(id),
  unit_number integer not null check (unit_number > 0),
  status public.unit_status not null default 'available',
  condition public.unit_condition not null default 'good',
  comment text,
  created_at timestamptz not null default now(),
  unique (shelf_id, unit_number)
);

create table public.borrowers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  identity_number text not null unique,
  created_at timestamptz not null default now()
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('TRX-' || floor(extract(epoch from now()))::bigint),
  borrower_id uuid not null references public.borrowers(id),
  unit_id uuid not null references public.inventory_units(id),
  borrowed_at timestamptz not null default now(),
  expected_return_at date not null,
  returned_at timestamptz,
  return_status text,
  return_condition public.unit_condition,
  comment text,
  created_at timestamptz not null default now()
);

create table public.inventory_checks (
  id uuid primary key default gen_random_uuid(),
  shelf_id uuid not null references public.shelves(id),
  performed_by text not null,
  result text not null default 'pending',
  expected_units integer not null default 0,
  present_units integer not null default 0,
  not_found_units integer not null default 0,
  damaged_units integer not null default 0,
  comments text,
  checked_at timestamptz not null default now()
);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  entity_type text,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.admin_accounts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  status public.account_status not null default 'active',
  created_at timestamptz not null default now()
);

create index inventory_units_shelf_id_idx on public.inventory_units(shelf_id);
create index transactions_borrower_id_idx on public.transactions(borrower_id);
create index transactions_unit_id_idx on public.transactions(unit_id);
create index activity_logs_created_at_idx on public.activity_logs(created_at desc);

alter table public.shelves enable row level security;
alter table public.inventory_units enable row level security;
alter table public.borrowers enable row level security;
alter table public.transactions enable row level security;
alter table public.inventory_checks enable row level security;
alter table public.activity_logs enable row level security;
alter table public.admin_accounts enable row level security;

-- Prototype policies. Replace these with authenticated role policies before production.
create policy "prototype read shelves" on public.shelves for select using (true);
create policy "prototype read units" on public.inventory_units for select using (true);
create policy "prototype read borrowers" on public.borrowers for select using (true);
create policy "prototype read transactions" on public.transactions for select using (true);
create policy "prototype read checks" on public.inventory_checks for select using (true);
create policy "prototype read logs" on public.activity_logs for select using (true);
create policy "prototype read admins" on public.admin_accounts for select using (true);
