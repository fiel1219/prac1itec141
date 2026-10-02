-- Run after schema.sql, user account setup, and borrowing_permissions.sql.
-- Safe to rerun. Existing inventory and borrowing history are preserved.
begin;
alter table public.shelves add column if not exists low_stock_threshold integer not null default 2 check (low_stock_threshold >= 0);
alter table public.inventory_units add column if not exists retired_at timestamptz;
alter table public.transactions add column if not exists borrowed_by text;
alter table public.transactions add column if not exists returned_by text;
alter table public.transactions alter column reference set default ('TRX-' || gen_random_uuid()::text);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  shelf_id uuid not null references public.shelves(id),
  unit_id uuid not null references public.inventory_units(id),
  direction text not null check (direction in ('in', 'out', 'adjustment')),
  reason text not null,
  quantity integer not null default 1 check (quantity = 1),
  actor text not null,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists stock_movements_created_idx on public.stock_movements(created_at desc);
alter table public.stock_movements enable row level security;
grant select, insert on public.stock_movements to authenticated;
grant select, insert, update on public.shelves to authenticated;
grant select, insert, update on public.inventory_units to authenticated;
grant select, insert, update on public.transactions to authenticated;
grant select, insert on public.borrowers to authenticated;

drop policy if exists "inventory manage shelves" on public.shelves;
create policy "inventory manage shelves" on public.shelves for all to authenticated using (true) with check (true);
drop policy if exists "inventory manage units" on public.inventory_units;
create policy "inventory manage units" on public.inventory_units for all to authenticated using (true) with check (true);
drop policy if exists "inventory read movements" on public.stock_movements;
create policy "inventory read movements" on public.stock_movements for select to authenticated using (true);
drop policy if exists "inventory record movements" on public.stock_movements;
create policy "inventory record movements" on public.stock_movements for insert to authenticated with check (true);
drop policy if exists "inventory create borrowers" on public.borrowers;
create policy "inventory create borrowers" on public.borrowers for insert to authenticated with check (true);
drop policy if exists "inventory manage transactions" on public.transactions;
create policy "inventory manage transactions" on public.transactions for all to authenticated using (true) with check (true);

create or replace function public.inventory_actor() returns text
language sql stable security invoker set search_path = public
as $$ select coalesce(auth.jwt()->'user_metadata'->>'full_name', auth.jwt()->>'email', auth.uid()::text, 'Operator') $$;

-- The trigger records one movement per unit, including checkout and return.
create or replace function public.record_inventory_movement() returns trigger
language plpgsql security invoker set search_path = public as $$
declare movement_direction text; movement_reason text;
begin
  if TG_OP = 'INSERT' then
    movement_direction := 'in'; movement_reason := 'Received stock';
  elsif new.retired_at is distinct from old.retired_at and new.retired_at is not null then
    movement_direction := 'out'; movement_reason := 'Removed stock';
  elsif new.status is distinct from old.status and new.status = 'borrowed' then
    movement_direction := 'out'; movement_reason := 'Checkout';
  elsif old.status = 'borrowed' and new.status <> 'borrowed' then
    movement_direction := 'in'; movement_reason := 'Return';
  elsif new.status is distinct from old.status or new.condition is distinct from old.condition then
    movement_direction := 'adjustment'; movement_reason := 'Condition / status update';
  else return new;
  end if;
  insert into public.stock_movements(shelf_id, unit_id, direction, reason, actor, notes)
  values(new.shelf_id, new.id, movement_direction, movement_reason, public.inventory_actor(),
    coalesce(nullif(current_setting('inventoscan.movement_notes', true), ''), new.comment));
  return new;
end $$;
drop trigger if exists inventory_movement on public.inventory_units;
create trigger inventory_movement after insert or update on public.inventory_units
for each row execute function public.record_inventory_movement();

create or replace function public.inventory_stock_move(p_shelf_id uuid, p_direction text, p_quantity integer, p_notes text default '')
returns void language plpgsql security invoker set search_path = public as $$
declare selected_shelf public.shelves; next_number integer; chosen_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  if p_direction not in ('in','out') or p_direction is null or p_quantity is null or p_quantity < 1 or p_quantity > 1000 then
    raise exception 'Choose stock-in or stock-out and a quantity from 1 to 1000';
  end if;
  select * into selected_shelf from public.shelves where id = p_shelf_id for update;
  if not found or selected_shelf.status <> 'active' then raise exception 'Active shelf not found'; end if;
  perform set_config('inventoscan.movement_notes', coalesce(p_notes,''), true);
  if p_direction = 'in' then
    select coalesce(max(unit_number),0) into next_number from public.inventory_units where shelf_id = p_shelf_id;
    insert into public.inventory_units(shelf_id, unit_number)
      select p_shelf_id, next_number + n from generate_series(1,p_quantity) n;
  else
    if nullif(trim(p_notes),'') is null then raise exception 'Enter the reason for removing stock'; end if;
    select array_agg(id) into chosen_ids from (
      select id from public.inventory_units where shelf_id = p_shelf_id
        and retired_at is null and status = 'available' and condition = 'good'
        and not exists (select 1 from public.transactions t where t.unit_id = inventory_units.id and t.returned_at is null)
      order by unit_number limit p_quantity for update
    ) candidates;
    if coalesce(cardinality(chosen_ids),0) <> p_quantity then raise exception 'Not enough available units to remove'; end if;
    update public.inventory_units set retired_at = now() where id = any(chosen_ids);
  end if;
end $$;

create or replace function public.inventory_checkout(p_unit_id uuid, p_borrower_id uuid, p_expected_return date)
returns void language plpgsql security invoker set search_path = public as $$
declare selected_unit public.inventory_units;
begin
  if auth.uid() is null then raise exception 'Sign in to check out an item'; end if;
  -- All stock operations acquire the shelf lock before a unit lock.
  perform 1 from public.shelves where id = (select shelf_id from public.inventory_units where id = p_unit_id) and status = 'active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  select * into selected_unit from public.inventory_units where id = p_unit_id for update;
  if not found or selected_unit.retired_at is not null or selected_unit.status <> 'available' or selected_unit.condition <> 'good'
    or exists(select 1 from public.transactions where unit_id = p_unit_id and returned_at is null) then
    raise exception 'This item is no longer available. Refresh and choose another item';
  end if;
  if p_expected_return is null or p_expected_return < current_date then raise exception 'Return date must be today or later'; end if;
  insert into public.transactions(borrower_id,unit_id,expected_return_at,borrowed_by)
    values(p_borrower_id,p_unit_id,p_expected_return,public.inventory_actor());
  update public.inventory_units set status = 'borrowed' where id = p_unit_id;
end $$;

create or replace function public.inventory_return(p_transaction_id uuid, p_condition text)
returns void language plpgsql security invoker set search_path = public as $$
declare selected_transaction public.transactions;
begin
  if auth.uid() is null then raise exception 'Sign in to return an item'; end if;
  if p_condition is null or p_condition not in ('good','damaged') then raise exception 'Choose good or damaged condition'; end if;
  perform 1 from public.shelves where id = (select u.shelf_id from public.inventory_units u join public.transactions t on t.unit_id=u.id where t.id=p_transaction_id) for update;
  perform 1 from public.inventory_units where id = (select unit_id from public.transactions where id=p_transaction_id) for update;
  select * into selected_transaction from public.transactions where id=p_transaction_id for update;
  if not found or selected_transaction.returned_at is not null then raise exception 'Transaction not found or already returned'; end if;
  update public.transactions set returned_at=now(),return_status='returned',
    return_condition=p_condition::public.unit_condition,returned_by=public.inventory_actor() where id=p_transaction_id;
  update public.inventory_units set condition=p_condition::public.unit_condition,
    status=case when p_condition='damaged' then 'under_maintenance'::public.unit_status else 'available'::public.unit_status end
    where id=selected_transaction.unit_id;
end $$;

create or replace function public.inventory_save_shelf(p_id uuid, p_code text, p_name text, p_item_type text, p_threshold integer)
returns uuid language plpgsql security invoker set search_path = public as $$
declare saved_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to manage items'; end if;
  if coalesce(trim(p_code),'')='' or coalesce(trim(p_name),'')='' or coalesce(trim(p_item_type),'')='' or p_threshold is null or p_threshold < 0 then
    raise exception 'Fill all shelf fields and enter a non-negative threshold'; end if;
  if p_id is null then
    insert into public.shelves(code,name,item_type,qr_value,low_stock_threshold)
      values(trim(p_code),trim(p_name),trim(p_item_type),'VSU-'||gen_random_uuid()::text,p_threshold) returning id into saved_id;
  else
    update public.shelves set code=trim(p_code),name=trim(p_name),item_type=trim(p_item_type),low_stock_threshold=p_threshold
      where id=p_id and status='active' returning id into saved_id;
    if saved_id is null then raise exception 'Active shelf not found'; end if;
  end if;
  return saved_id;
end $$;

create or replace function public.inventory_archive_shelf(p_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in to archive shelves'; end if;
  perform 1 from public.shelves where id=p_id and status='active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  if exists(select 1 from public.inventory_units where shelf_id=p_id and retired_at is null)
    then raise exception 'Remove all stock before archiving this shelf'; end if;
  update public.shelves set status='archived',archived_at=now() where id=p_id;
end $$;

create or replace function public.inventory_update_unit(p_id uuid,p_status text,p_condition text,p_comment text)
returns void language plpgsql security invoker set search_path = public as $$
declare selected_unit public.inventory_units;
begin
  if auth.uid() is null then raise exception 'Sign in to manage items'; end if;
  if p_status is null or p_status not in ('available','missing','under_maintenance','not_found') or p_condition is null or p_condition not in ('good','damaged')
    then raise exception 'Choose a valid status and condition'; end if;
  if p_status='available' and p_condition='damaged' then raise exception 'Damaged items must be marked for maintenance'; end if;
  perform 1 from public.shelves where id=(select shelf_id from public.inventory_units where id=p_id) and status='active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  select * into selected_unit from public.inventory_units where id=p_id for update;
  if not found or selected_unit.retired_at is not null or selected_unit.status='borrowed'
    or exists(select 1 from public.transactions where unit_id=p_id and returned_at is null)
    then raise exception 'Return borrowed items before editing; removed items cannot be edited'; end if;
  update public.inventory_units set status=p_status::public.unit_status,condition=p_condition::public.unit_condition,comment=nullif(trim(p_comment),'') where id=p_id;
end $$;

-- RPCs use caller permissions and do not expose anonymous writes.
revoke execute on function public.inventory_stock_move(uuid,text,integer,text), public.inventory_checkout(uuid,uuid,date),
  public.inventory_return(uuid,text), public.inventory_save_shelf(uuid,text,text,text,integer),
  public.inventory_archive_shelf(uuid), public.inventory_update_unit(uuid,text,text,text) from public, anon;
grant execute on function public.inventory_stock_move(uuid,text,integer,text), public.inventory_checkout(uuid,uuid,date),
  public.inventory_return(uuid,text), public.inventory_save_shelf(uuid,text,text,text,integer),
  public.inventory_archive_shelf(uuid), public.inventory_update_unit(uuid,text,text,text) to authenticated;
commit;
