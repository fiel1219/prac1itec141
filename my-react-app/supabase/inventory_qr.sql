-- Run after inventoscan_features.sql. Safe to rerun; existing labels and history remain intact.
begin;
alter table public.shelves add column if not exists inventory_kind text not null default 'equipment'
  check (inventory_kind in ('equipment', 'consumable'));

-- A separate RPC keeps the original shelf-saving API compatible with older clients.
create or replace function public.inventory_save_qr_shelf(
  p_id uuid, p_code text, p_name text, p_item_type text, p_threshold integer, p_inventory_kind text
) returns uuid language plpgsql security invoker set search_path = public as $$
declare saved_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to manage items'; end if;
  if p_inventory_kind is null or p_inventory_kind not in ('equipment', 'consumable') then
    raise exception 'Choose equipment or consumable';
  end if;
  if p_id is not null then
    perform 1 from public.shelves where id=p_id and status='active' for update;
    if not found then raise exception 'Active shelf not found'; end if;
    if p_inventory_kind='consumable' and exists (
      select 1 from public.inventory_units u where u.shelf_id=p_id and (
        u.status='borrowed' or exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null)
      )
    ) then raise exception 'Return borrowed equipment before changing this shelf to consumables'; end if;
  end if;
  saved_id := public.inventory_save_shelf(p_id,p_code,p_name,p_item_type,p_threshold);
  update public.shelves set inventory_kind=p_inventory_kind where id=saved_id;
  return saved_id;
end $$;

-- Also enforce the rule for older clients using the existing checkout RPC.
create or replace function public.inventory_equipment_loan_only() returns trigger
language plpgsql security invoker set search_path=public as $$
declare selected_kind text;
begin
  select s.inventory_kind into selected_kind from public.shelves s
    join public.inventory_units u on u.shelf_id=s.id where u.id=new.unit_id for update of s;
  if selected_kind='consumable' then
    raise exception 'Consumables are issued as stock-out, not borrowed';
  end if;
  return new;
end $$;
drop trigger if exists inventory_equipment_loan_only on public.transactions;
create trigger inventory_equipment_loan_only before insert on public.transactions
  for each row execute function public.inventory_equipment_loan_only();

revoke execute on function public.inventory_save_qr_shelf(uuid,text,text,text,integer,text) from public,anon;
grant execute on function public.inventory_save_qr_shelf(uuid,text,text,text,integer,text) to authenticated;
commit;
