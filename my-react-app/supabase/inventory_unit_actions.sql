-- Run after inventoscan_features.sql and inventory_qr.sql. Safe to rerun.
begin;
alter table public.shelves add column if not exists next_unit_number integer not null default 1 check (next_unit_number > 0);
update public.shelves s set next_unit_number=greatest(s.next_unit_number,
  coalesce((select max(u.unit_number)+1 from public.inventory_units u where u.shelf_id=s.id),1));

-- Preserve the displayed identifiers and locations in historical records after a move.
alter table public.stock_movements add column if not exists unit_number integer;
update public.stock_movements m set unit_number=u.unit_number from public.inventory_units u
  where m.unit_id=u.id and m.unit_number is null;
alter table public.transactions add column if not exists checkout_shelf_code text;
alter table public.transactions add column if not exists checkout_unit_number integer;
update public.transactions t set checkout_shelf_code=coalesce(t.checkout_shelf_code,s.code),
  checkout_unit_number=coalesce(t.checkout_unit_number,u.unit_number)
  from public.inventory_units u join public.shelves s on s.id=u.shelf_id
  where t.unit_id=u.id and (t.checkout_shelf_code is null or t.checkout_unit_number is null);

create or replace function public.inventory_snapshot_checkout() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  select s.code,u.unit_number into new.checkout_shelf_code,new.checkout_unit_number
    from public.inventory_units u join public.shelves s on s.id=u.shelf_id where u.id=new.unit_id;
  return new;
end $$;
drop trigger if exists inventory_snapshot_checkout on public.transactions;
create trigger inventory_snapshot_checkout before insert on public.transactions
  for each row execute function public.inventory_snapshot_checkout();

create or replace function public.record_inventory_movement() returns trigger
language plpgsql security invoker set search_path=public as $$
declare movement_direction text; movement_reason text; movement_notes text;
begin
  movement_notes := coalesce(nullif(current_setting('inventoscan.movement_notes',true),''),new.comment);
  if TG_OP='INSERT' then
    movement_direction := 'in'; movement_reason := 'Received stock';
  elsif new.shelf_id is distinct from old.shelf_id then
    insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,actor,notes) values
      (old.shelf_id,new.id,old.unit_number,'out','Transfer out',public.inventory_actor(),movement_notes),
      (new.shelf_id,new.id,new.unit_number,'in','Transfer in',public.inventory_actor(),movement_notes);
    return new;
  elsif new.retired_at is distinct from old.retired_at and new.retired_at is not null then
    movement_direction := 'out'; movement_reason := 'Removed stock';
  elsif new.status is distinct from old.status and new.status='borrowed' then
    movement_direction := 'out'; movement_reason := 'Checkout';
  elsif old.status='borrowed' and new.status<>'borrowed' then
    movement_direction := 'in'; movement_reason := 'Return';
  elsif new.status is distinct from old.status or new.condition is distinct from old.condition then
    movement_direction := 'adjustment'; movement_reason := 'Condition / status update';
  else return new;
  end if;
  insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,actor,notes)
    values(new.shelf_id,new.id,new.unit_number,movement_direction,movement_reason,public.inventory_actor(),movement_notes);
  return new;
end $$;

-- Receipts retain a shelf's high-water mark even when its highest-numbered unit moves away.
create or replace function public.inventory_stock_move(p_shelf_id uuid,p_direction text,p_quantity integer,p_notes text default '')
returns void language plpgsql security invoker set search_path=public as $$
declare selected_shelf public.shelves; next_number integer; chosen_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  if p_direction is null or p_direction not in ('in','out') or p_quantity is null or p_quantity<1 or p_quantity>1000 then
    raise exception 'Choose stock-in or stock-out and a quantity from 1 to 1000'; end if;
  select * into selected_shelf from public.shelves where id=p_shelf_id for update;
  if not found or selected_shelf.status<>'active' then raise exception 'Active shelf not found'; end if;
  perform set_config('inventoscan.movement_notes',coalesce(p_notes,''),true);
  if p_direction='in' then
    select greatest(selected_shelf.next_unit_number,coalesce(max(unit_number)+1,1)) into next_number
      from public.inventory_units where shelf_id=p_shelf_id;
    update public.shelves set next_unit_number=next_number+p_quantity where id=p_shelf_id;
    insert into public.inventory_units(shelf_id,unit_number)
      select p_shelf_id,next_number+n-1 from generate_series(1,p_quantity) n;
  else
    if nullif(trim(p_notes),'') is null then raise exception 'Enter the reason for removing stock'; end if;
    select array_agg(id) into chosen_ids from (
      select id from public.inventory_units where shelf_id=p_shelf_id and retired_at is null
        and status='available' and condition='good'
        and not exists(select 1 from public.transactions t where t.unit_id=inventory_units.id and t.returned_at is null)
        order by unit_number limit p_quantity for update
    ) candidates;
    if coalesce(cardinality(chosen_ids),0)<>p_quantity then raise exception 'Not enough available units to remove'; end if;
    update public.inventory_units set retired_at=now() where id=any(chosen_ids);
  end if;
end $$;

create or replace function public.inventory_delete_unit(p_unit_id uuid,p_reason text)
returns void language plpgsql security invoker set search_path=public as $$
declare source_id uuid; selected_unit public.inventory_units; source_shelf public.shelves;
begin
  if auth.uid() is null then raise exception 'Sign in to delete equipment'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Enter a reason for deleting this unit'; end if;
  if length(p_reason)>1000 then raise exception 'Keep the reason within 1000 characters'; end if;
  select shelf_id into source_id from public.inventory_units where id=p_unit_id;
  select * into source_shelf from public.shelves where id=source_id for update;
  if not found or source_shelf.status<>'active' then raise exception 'Active shelf not found'; end if;
  if source_shelf.inventory_kind<>'equipment' then raise exception 'Use stock-out to issue consumables'; end if;
  select * into selected_unit from public.inventory_units where id=p_unit_id for update;
  if not found or selected_unit.retired_at is not null then raise exception 'This unit was already removed or does not exist'; end if;
  if selected_unit.shelf_id<>source_id then raise exception 'This unit moved to another shelf. Refresh and try again'; end if;
  if selected_unit.status='borrowed' or exists(select 1 from public.transactions where unit_id=p_unit_id and returned_at is null)
    then raise exception 'Return borrowed equipment before deleting it'; end if;
  perform set_config('inventoscan.movement_notes',trim(p_reason),true);
  update public.inventory_units set retired_at=now() where id=p_unit_id;
end $$;

create or replace function public.inventory_move_unit(p_unit_id uuid,p_destination_shelf_id uuid,p_notes text default '')
returns void language plpgsql security invoker set search_path=public as $$
declare source_id uuid; selected_unit public.inventory_units; source_shelf public.shelves; destination public.shelves; next_number integer;
begin
  if auth.uid() is null then raise exception 'Sign in to move equipment'; end if;
  if p_destination_shelf_id is null then raise exception 'Choose a destination shelf'; end if;
  if length(coalesce(p_notes,''))>1000 then raise exception 'Keep the notes within 1000 characters'; end if;
  select shelf_id into source_id from public.inventory_units where id=p_unit_id;
  if source_id is null then raise exception 'Equipment unit not found'; end if;
  if source_id=p_destination_shelf_id then raise exception 'Choose a different shelf'; end if;
  -- Lock both shelves in a consistent order before the unit, matching other inventory RPCs.
  perform 1 from public.shelves where id in (source_id,p_destination_shelf_id) order by id for update;
  select * into source_shelf from public.shelves where id=source_id;
  select * into destination from public.shelves where id=p_destination_shelf_id;
  if source_shelf.status is distinct from 'active'::public.shelf_status or destination.status is distinct from 'active'::public.shelf_status
    then raise exception 'Both shelves must be active'; end if;
  if source_shelf.inventory_kind<>'equipment' or destination.inventory_kind<>'equipment'
    then raise exception 'Equipment can only move between equipment shelves'; end if;
  if lower(trim(source_shelf.item_type))<>lower(trim(destination.item_type))
    then raise exception 'Choose a shelf with the same item type'; end if;
  select * into selected_unit from public.inventory_units where id=p_unit_id for update;
  if not found or selected_unit.retired_at is not null then raise exception 'This unit was already removed or does not exist'; end if;
  if selected_unit.shelf_id<>source_id then raise exception 'This unit moved to another shelf. Refresh and try again'; end if;
  if selected_unit.status='borrowed' or exists(select 1 from public.transactions where unit_id=p_unit_id and returned_at is null)
    then raise exception 'Return borrowed equipment before moving it'; end if;
  update public.shelves set next_unit_number=greatest(next_unit_number,
    coalesce((select max(unit_number)+1 from public.inventory_units where shelf_id=source_id),1)) where id=source_id;
  select greatest(destination.next_unit_number,coalesce(max(unit_number)+1,1)) into next_number
    from public.inventory_units where shelf_id=p_destination_shelf_id;
  update public.shelves set next_unit_number=next_number+1 where id=p_destination_shelf_id;
  perform set_config('inventoscan.movement_notes',format('Moved from %s to %s. %s',source_shelf.code,destination.code,coalesce(trim(p_notes),'')),true);
  update public.inventory_units set shelf_id=p_destination_shelf_id,unit_number=next_number where id=p_unit_id;
end $$;

revoke execute on function public.inventory_delete_unit(uuid,text),public.inventory_move_unit(uuid,uuid,text) from public,anon;
grant execute on function public.inventory_delete_unit(uuid,text),public.inventory_move_unit(uuid,uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
