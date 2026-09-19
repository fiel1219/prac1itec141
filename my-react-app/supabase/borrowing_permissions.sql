-- Allow signed-in operators to complete the checkout workflow.
-- Run this once in the Supabase SQL Editor.

alter table public.transactions
  add column if not exists borrowed_by text,
  add column if not exists returned_by text;

grant insert on public.borrowers to authenticated;
grant insert on public.transactions to authenticated;
grant update on public.inventory_units to authenticated;
grant update on public.transactions to authenticated;

drop policy if exists "authenticated create borrowers" on public.borrowers;
create policy "authenticated create borrowers"
  on public.borrowers for insert to authenticated
  with check (true);

drop policy if exists "authenticated create transactions" on public.transactions;
create policy "authenticated create transactions"
  on public.transactions for insert to authenticated
  with check (true);

drop policy if exists "authenticated update inventory units" on public.inventory_units;
create policy "authenticated update inventory units"
  on public.inventory_units for update to authenticated
  using (true)
  with check (true);

drop policy if exists "authenticated return transactions" on public.transactions;
create policy "authenticated return transactions"
  on public.transactions for update to authenticated
  using (true)
  with check (true);
