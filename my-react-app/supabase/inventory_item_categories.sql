-- Run after inventory_item_descriptions.sql. Safe to rerun; preserves item and QR IDs.
begin;
alter table public.shelves add column if not exists description text not null default '';
alter table public.inventory_units add column if not exists inventory_kind text;
update public.inventory_units u set inventory_kind=s.inventory_kind from public.shelves s
  where s.id=u.shelf_id and u.inventory_kind is null;
alter table public.inventory_units alter column inventory_kind set not null;
alter table public.inventory_units drop constraint if exists inventory_units_kind_check;
alter table public.inventory_units add constraint inventory_units_kind_check check(inventory_kind in ('equipment','consumable'));

-- Legacy direct inserts inherit their former shelf category. Explicit new categories win.
create or replace function public.inventory_guard_item_category() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if TG_OP='UPDATE' and new.inventory_kind is distinct from old.inventory_kind then
    raise exception 'Item category cannot be changed after creation'; end if;
  if new.inventory_kind is null then
    select inventory_kind into new.inventory_kind from public.shelves where id=new.shelf_id;
  end if;
  return new;
end $$;
drop trigger if exists inventory_guard_item_category on public.inventory_units;
create trigger inventory_guard_item_category before insert or update of inventory_kind on public.inventory_units
  for each row execute function public.inventory_guard_item_category();

create or replace function public.inventory_save_shelf_details(p_id uuid,p_code text,p_name text,p_description text default '')
returns uuid language plpgsql security invoker set search_path=public as $$
declare saved_id uuid; legacy_type text; legacy_threshold integer;
begin
  if auth.uid() is null then raise exception 'Sign in to manage shelves'; end if;
  if length(coalesce(p_code,''))>120 or length(coalesce(p_name,''))>120 then raise exception 'Keep shelf code and name within 120 characters'; end if;
  if length(coalesce(p_description,''))>1000 then raise exception 'Keep the description within 1000 characters'; end if;
  if p_id is not null then
    select item_type,low_stock_threshold into legacy_type,legacy_threshold from public.shelves where id=p_id and status='active' for update;
    if not found then raise exception 'Active shelf not found'; end if;
  end if;
  saved_id := public.inventory_save_shelf(p_id,p_code,p_name,coalesce(legacy_type,'Mixed items'),coalesce(legacy_threshold,2));
  update public.shelves set description=trim(coalesce(p_description,'')) where id=saved_id;
  return saved_id;
end $$;

create or replace function public.inventory_item_category_stock_move(
  p_shelf_id uuid,p_direction text,p_item_name text,p_inventory_kind text,p_quantity integer,p_notes text default '',p_description text default ''
) returns void language plpgsql security invoker set search_path=public as $$
declare selected_shelf public.shelves; selected_name text; next_number integer; chosen_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  if p_inventory_kind is null or p_inventory_kind not in ('equipment','consumable') then raise exception 'Choose equipment or consumables'; end if;
  if p_direction is null or p_direction not in ('in','out') or p_quantity is null or p_quantity<1 or p_quantity>1000 then
    raise exception 'Choose stock-in or stock-out and a quantity from 1 to 1000'; end if;
  if nullif(trim(p_item_name),'') is null or length(trim(p_item_name))>120 then raise exception 'Enter an item name from 1 to 120 characters'; end if;
  if length(coalesce(p_notes,''))>1000 or length(coalesce(p_description,''))>1000 then raise exception 'Keep notes and description within 1000 characters'; end if;
  select * into selected_shelf from public.shelves where id=p_shelf_id for update;
  if not found or selected_shelf.status<>'active' then raise exception 'Active shelf not found'; end if;
  select item_name into selected_name from public.inventory_units where shelf_id=p_shelf_id
    and inventory_kind=p_inventory_kind and lower(trim(item_name))=lower(trim(p_item_name)) order by created_at,id limit 1;
  selected_name := coalesce(selected_name,trim(p_item_name));
  perform set_config('inventoscan.movement_notes',coalesce(p_notes,''),true);
  if p_direction='in' then
    select greatest(selected_shelf.next_unit_number,coalesce(max(unit_number)+1,1)) into next_number from public.inventory_units where shelf_id=p_shelf_id;
    update public.shelves set next_unit_number=next_number+p_quantity where id=p_shelf_id;
    insert into public.inventory_units(shelf_id,unit_number,item_name,inventory_kind,description)
      select p_shelf_id,next_number+n-1,selected_name,p_inventory_kind,trim(coalesce(p_description,'')) from generate_series(1,p_quantity) n;
  else
    if nullif(trim(p_notes),'') is null then raise exception 'Enter the reason for removing stock'; end if;
    select array_agg(id) into chosen_ids from (
      select id from public.inventory_units where shelf_id=p_shelf_id and retired_at is null
        and inventory_kind=p_inventory_kind and lower(trim(item_name))=lower(trim(selected_name)) and status='available' and condition='good'
        and not exists(select 1 from public.transactions t where t.unit_id=inventory_units.id and t.returned_at is null)
        order by unit_number limit p_quantity for update
    ) candidates;
    if coalesce(cardinality(chosen_ids),0)<>p_quantity then raise exception 'Not enough available units of this item'; end if;
    update public.inventory_units set retired_at=now() where id=any(chosen_ids);
  end if;
end $$;

create or replace function public.inventory_receive_categorized_items(
  p_shelf_id uuid,p_item_name text,p_inventory_kind text,p_quantity integer,p_description text default ''
) returns void language plpgsql security invoker set search_path=public as $$
begin
  perform public.inventory_item_category_stock_move(p_shelf_id,'in',p_item_name,p_inventory_kind,p_quantity,'',p_description);
end $$;

-- Older clients may operate only when the item name identifies a single category.
create or replace function public.inventory_legacy_item_kind(p_shelf_id uuid,p_item_name text)
returns text language plpgsql security invoker set search_path=public as $$
declare kinds text[]; legacy_kind text;
begin
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  select inventory_kind into legacy_kind from public.shelves where id=p_shelf_id and status='active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  select array_agg(distinct inventory_kind) into kinds from public.inventory_units where shelf_id=p_shelf_id and retired_at is null
    and lower(trim(item_name))=lower(trim(p_item_name));
  if coalesce(cardinality(kinds),0)>1 then raise exception 'Choose an item category in the updated stock form'; end if;
  return coalesce(kinds[1],legacy_kind);
end $$;

create or replace function public.inventory_item_stock_move(p_shelf_id uuid,p_direction text,p_item_name text,p_quantity integer,p_notes text default '')
returns void language plpgsql security invoker set search_path=public as $$
begin
  perform public.inventory_item_category_stock_move(p_shelf_id,p_direction,p_item_name,
    public.inventory_legacy_item_kind(p_shelf_id,p_item_name),p_quantity,p_notes,'');
end $$;
create or replace function public.inventory_receive_items(p_shelf_id uuid,p_item_name text,p_quantity integer,p_description text default '')
returns void language plpgsql security invoker set search_path=public as $$
begin
  perform public.inventory_receive_categorized_items(p_shelf_id,p_item_name,
    public.inventory_legacy_item_kind(p_shelf_id,p_item_name),p_quantity,p_description);
end $$;

create or replace function public.inventory_equipment_loan_only() returns trigger
language plpgsql security invoker set search_path=public as $$
declare selected_kind text;
begin
  select u.inventory_kind into selected_kind from public.inventory_units u join public.shelves s on s.id=u.shelf_id where u.id=new.unit_id for update of s;
  if selected_kind='consumable' then raise exception 'Consumables are issued as stock-out, not borrowed'; end if;
  return new;
end $$;

alter table public.stock_movements add column if not exists inventory_kind text;
update public.stock_movements m set inventory_kind=u.inventory_kind from public.inventory_units u
  where u.id=m.unit_id and m.inventory_kind is null;
create or replace function public.inventory_snapshot_movement() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.unit_id_snapshot := coalesce(new.unit_id_snapshot,new.unit_id);
  new.shelf_id_snapshot := coalesce(new.shelf_id_snapshot,new.shelf_id);
  select coalesce(new.shelf_code,s.code),coalesce(new.shelf_name,s.name),
    coalesce(new.item_type,(select u.item_name from public.inventory_units u where u.id=new.unit_id),s.item_type),
    coalesce(new.inventory_kind,(select u.inventory_kind from public.inventory_units u where u.id=new.unit_id))
    into new.shelf_code,new.shelf_name,new.item_type,new.inventory_kind from public.shelves s where s.id=new.shelf_id;
  if new.unit_number is null then select unit_number into new.unit_number from public.inventory_units where id=new.unit_id; end if;
  return new;
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
  select * into selected_unit from public.inventory_units where id=p_unit_id for update;
  if not found or selected_unit.retired_at is not null then raise exception 'This unit was already removed or does not exist'; end if;
  if selected_unit.inventory_kind<>'equipment' then raise exception 'Use stock-out to issue consumables'; end if;
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

create or replace function public.inventory_delete_unit(p_unit_id uuid,p_reason text)
returns void language plpgsql security invoker set search_path=public as $$
declare source_id uuid; selected_unit public.inventory_units; source_shelf public.shelves; changed_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to delete equipment'; end if;
  if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Enter a deletion reason within 1000 characters'; end if;
  select shelf_id into source_id from public.inventory_units where id=p_unit_id;
  select * into source_shelf from public.shelves where id=source_id for update;
  if not found then raise exception 'This equipment unit or shelf was already deleted'; end if;
  select * into selected_unit from public.inventory_units where id=p_unit_id for update;
  if not found then raise exception 'This equipment unit was already deleted'; end if;
  if selected_unit.inventory_kind<>'equipment' then raise exception 'Use stock-out to issue consumables'; end if;
  if selected_unit.shelf_id<>source_id then raise exception 'This unit moved to another shelf. Refresh and try again'; end if;
  if selected_unit.status='borrowed' or exists(select 1 from public.transactions where unit_id=p_unit_id and returned_at is null)
    then raise exception 'Return borrowed equipment before deleting it'; end if;
  -- Keep display numbers monotonic after physically deleting the highest-numbered unit.
  update public.shelves set next_unit_number=greatest(next_unit_number,
    coalesce((select max(unit_number)+1 from public.inventory_units where shelf_id=source_id),1)) where id=source_id;
  perform set_config('inventoscan.movement_notes',trim(p_reason),true);
  delete from public.inventory_units where id=p_unit_id;
  get diagnostics changed_count = row_count;
  if changed_count<>1 then raise exception 'Could not delete the equipment unit. Check delete permissions'; end if;
end $$;

revoke execute on function public.inventory_save_shelf_details(uuid,text,text,text),
 public.inventory_item_category_stock_move(uuid,text,text,text,integer,text,text),
 public.inventory_receive_categorized_items(uuid,text,text,integer,text),
 public.inventory_legacy_item_kind(uuid,text) from public,anon;
grant execute on function public.inventory_save_shelf_details(uuid,text,text,text),
 public.inventory_item_category_stock_move(uuid,text,text,text,integer,text,text),
 public.inventory_receive_categorized_items(uuid,text,text,integer,text),
 public.inventory_legacy_item_kind(uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
