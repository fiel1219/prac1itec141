-- Run after inventory_permanent_delete.sql. Safe to rerun; preserves units and QR IDs.
begin;
alter table public.inventory_units add column if not exists item_name text;
update public.inventory_units u set item_name=coalesce(nullif(trim(s.item_type),''),'Item')
  from public.shelves s where s.id=u.shelf_id and nullif(trim(u.item_name),'') is null;
alter table public.inventory_units alter column item_name set not null;
-- Compatibility for old clients inserting units directly; new receipts require a name.
alter table public.inventory_units alter column item_name set default 'Item';
alter table public.transactions add column if not exists checkout_item_name text;
update public.transactions t set checkout_item_name=u.item_name
  from public.inventory_units u where u.id=t.unit_id and t.checkout_item_name is null;
update public.transactions t set checkout_item_name=(select m.item_type from public.stock_movements m
  where m.unit_id_snapshot=t.unit_id_snapshot and m.item_type is not null order by m.created_at limit 1)
  where t.checkout_item_name is null;

create or replace function public.inventory_snapshot_checkout() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.unit_id_snapshot := new.unit_id;
  select s.code,u.unit_number,u.item_name into new.checkout_shelf_code,new.checkout_unit_number,new.checkout_item_name
    from public.inventory_units u join public.shelves s on s.id=u.shelf_id where u.id=new.unit_id;
  return new;
end $$;

create or replace function public.inventory_snapshot_movement() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.unit_id_snapshot := coalesce(new.unit_id_snapshot,new.unit_id);
  new.shelf_id_snapshot := coalesce(new.shelf_id_snapshot,new.shelf_id);
  select coalesce(new.shelf_code,s.code),coalesce(new.shelf_name,s.name),
    coalesce(new.item_type,(select u.item_name from public.inventory_units u where u.id=new.unit_id),s.item_type)
    into new.shelf_code,new.shelf_name,new.item_type from public.shelves s where s.id=new.shelf_id;
  if new.unit_number is null then
    select unit_number into new.unit_number from public.inventory_units where id=new.unit_id;
  end if;
  return new;
end $$;

create or replace function public.inventory_item_stock_move(
  p_shelf_id uuid,p_direction text,p_item_name text,p_quantity integer,p_notes text default ''
) returns void language plpgsql security invoker set search_path=public as $$
declare selected_shelf public.shelves; selected_name text; next_number integer; chosen_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  if p_direction is null or p_direction not in ('in','out') or p_quantity is null or p_quantity<1 or p_quantity>1000 then
    raise exception 'Choose stock-in or stock-out and a quantity from 1 to 1000'; end if;
  if nullif(trim(p_item_name),'') is null or length(trim(p_item_name))>120 then
    raise exception 'Enter an item name from 1 to 120 characters'; end if;
  if length(coalesce(p_notes,''))>1000 then raise exception 'Keep the notes within 1000 characters'; end if;
  select * into selected_shelf from public.shelves where id=p_shelf_id for update;
  if not found or selected_shelf.status<>'active' then raise exception 'Active shelf not found'; end if;
  select item_name into selected_name from public.inventory_units
    where shelf_id=p_shelf_id and lower(trim(item_name))=lower(trim(p_item_name)) order by created_at,id limit 1;
  selected_name := coalesce(selected_name,trim(p_item_name));
  perform set_config('inventoscan.movement_notes',coalesce(p_notes,''),true);
  if p_direction='in' then
    select greatest(selected_shelf.next_unit_number,coalesce(max(unit_number)+1,1)) into next_number
      from public.inventory_units where shelf_id=p_shelf_id;
    update public.shelves set next_unit_number=next_number+p_quantity where id=p_shelf_id;
    insert into public.inventory_units(shelf_id,unit_number,item_name)
      select p_shelf_id,next_number+n-1,selected_name from generate_series(1,p_quantity) n;
  else
    if nullif(trim(p_notes),'') is null then raise exception 'Enter the reason for removing stock'; end if;
    select array_agg(id) into chosen_ids from (
      select id from public.inventory_units where shelf_id=p_shelf_id and retired_at is null
        and lower(trim(item_name))=lower(trim(selected_name)) and status='available' and condition='good'
        and not exists(select 1 from public.transactions t where t.unit_id=inventory_units.id and t.returned_at is null)
        order by unit_number limit p_quantity for update
    ) candidates;
    if coalesce(cardinality(chosen_ids),0)<>p_quantity then raise exception 'Not enough available units of this item'; end if;
    update public.inventory_units set retired_at=now() where id=any(chosen_ids);
  end if;
end $$;

-- Old stock screens cannot silently issue a mixture of different items.
create or replace function public.inventory_stock_move(p_shelf_id uuid,p_direction text,p_quantity integer,p_notes text default '')
returns void language plpgsql security invoker set search_path=public as $$
declare names text[]; legacy_name text;
begin
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  select item_type into legacy_name from public.shelves where id=p_shelf_id and status='active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  select array_agg(distinct item_name) into names from public.inventory_units where shelf_id=p_shelf_id and retired_at is null;
  if coalesce(cardinality(names),0)>1 then raise exception 'Choose an item in the updated stock form'; end if;
  perform public.inventory_item_stock_move(p_shelf_id,p_direction,coalesce(names[1],nullif(trim(legacy_name),''),'Item'),p_quantity,p_notes);
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

revoke execute on function public.inventory_item_stock_move(uuid,text,text,integer,text) from public,anon;
grant execute on function public.inventory_item_stock_move(uuid,text,text,integer,text) to authenticated;
notify pgrst, 'reload schema';
commit;
