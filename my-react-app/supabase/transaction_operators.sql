-- Store the operator responsible for each checkout and return.
alter table public.transactions
  add column if not exists borrowed_by text,
  add column if not exists returned_by text;

grant update on public.transactions to authenticated;
