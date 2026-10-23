-- Run after inventory_item_categories.sql. Safe to rerun; equipment IDs/QRs stay intact.
begin;
alter table public.inventory_units add column if not exists quantity integer not null default 1;
alter table public.inventory_units add column if not exists consumable_number integer;
alter table public.shelves add column if not exists next_consumable_number integer not null default 1;
alter table public.stock_movements add column if not exists item_description text;
alter table public.stock_movements drop constraint if exists stock_movements_quantity_check;
alter table public.stock_movements add constraint stock_movements_quantity_check check(quantity>0);

-- Snapshot old descriptions before redundant consumable rows are consolidated.
update public.stock_movements m set item_description=u.description from public.inventory_units u
  where u.id=m.unit_id and m.item_description is null;
do $$ begin
  if exists(select 1 from public.inventory_units u where u.inventory_kind='consumable' and
    (u.status='borrowed' or exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null))) then
    raise exception 'Return outstanding consumable loans before consolidating quantities'; end if;
end $$;

-- Preserve unavailable/damaged stock separately; the UI groups these under the same item.
-- This is a storage conversion, so do not fabricate receipt/removal movements for merges.
alter table public.inventory_units disable trigger inventory_guard_unit_delete;
create temporary table consumable_merge on commit drop as
  select shelf_id,lower(trim(item_name)) as item_key,status,condition,
    (array_agg(id order by retired_at is not null,unit_number,id))[1] as keep_id,
    sum(case when retired_at is null then quantity else 0 end)::integer as stock_quantity,
    string_agg(distinct nullif(description,''),E'\n') as descriptions,
    string_agg(distinct nullif(comment,''),E'\n') as comments
  from public.inventory_units where inventory_kind='consumable'
  group by shelf_id,lower(trim(item_name)),status,condition;
update public.inventory_units u set quantity=m.stock_quantity,description=coalesce(m.descriptions,''),comment=m.comments,retired_at=null
  from consumable_merge m where u.id=m.keep_id;
delete from public.inventory_units u using consumable_merge m
  where u.inventory_kind='consumable' and u.shelf_id=m.shelf_id and lower(trim(u.item_name))=m.item_key
    and u.status=m.status and u.condition=m.condition and u.id<>m.keep_id;
alter table public.inventory_units enable trigger inventory_guard_unit_delete;

with item_order as (
  select shelf_id,lower(trim(item_name)) as item_key,min(unit_number) as first_number
  from public.inventory_units where inventory_kind='consumable' group by shelf_id,lower(trim(item_name))
), numbered as (
  select *,row_number() over(partition by shelf_id order by first_number,item_key)::integer as number from item_order
)
update public.inventory_units u set consumable_number=n.number from numbered n
  where u.inventory_kind='consumable' and u.shelf_id=n.shelf_id and lower(trim(u.item_name))=n.item_key and u.consumable_number is null;
update public.shelves s set next_consumable_number=greatest(s.next_consumable_number,
  coalesce((select max(u.consumable_number)+1 from public.inventory_units u where u.shelf_id=s.id),1));
alter table public.inventory_units drop constraint if exists inventory_quantity_check;
alter table public.inventory_units add constraint inventory_quantity_check check(
  (inventory_kind='equipment' and quantity=1) or (inventory_kind='consumable' and quantity>=0));
create unique index if not exists inventory_consumable_stock_key on public.inventory_units
  (shelf_id,lower(trim(item_name)),status,condition) where inventory_kind='consumable' and retired_at is null;

create or replace function public.inventory_guard_unit_delete() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if old.status='borrowed' or exists(select 1 from public.transactions where unit_id=old.id and returned_at is null) then
    raise exception 'Return borrowed equipment before deleting it'; end if;
  if old.inventory_kind='consumable' then
    if old.quantity>0 and old.retired_at is null then raise exception 'Issue remaining consumable quantity before deleting it'; end if;
    return old;
  end if;
  if old.retired_at is null then
    insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,actor,notes)
      values(old.shelf_id,old.id,old.unit_number,'out','Deleted equipment',public.inventory_actor(),
        coalesce(nullif(current_setting('inventoscan.movement_notes',true),''),'Permanently deleted equipment'));
  end if;
  return old;
end $$;

create or replace function public.record_inventory_movement() returns trigger
language plpgsql security invoker set search_path=public as $$
declare movement_direction text; movement_reason text; movement_notes text; movement_quantity integer;
begin
  movement_notes := coalesce(nullif(current_setting('inventoscan.movement_notes',true),''),new.comment);
  if new.inventory_kind='consumable' then
    if TG_OP='INSERT' then
      movement_quantity:=new.quantity; movement_direction:='in'; movement_reason:='Received stock';
    elsif new.quantity is distinct from old.quantity then
      movement_quantity:=abs(new.quantity-old.quantity);
      movement_direction:=case when new.quantity>old.quantity then 'in' else 'out' end;
      movement_reason:=case when new.quantity>old.quantity then 'Received stock' else 'Issued consumables' end;
    elsif new.status is distinct from old.status or new.condition is distinct from old.condition then
      movement_quantity:=greatest(new.quantity,1); movement_direction:='adjustment'; movement_reason:='Condition / status update';
    else return new;
    end if;
    if movement_quantity>0 then
      insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,quantity,actor,notes)
        values(new.shelf_id,new.id,new.consumable_number,movement_direction,movement_reason,movement_quantity,public.inventory_actor(),movement_notes);
    end if;
    return new;
  end if;
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

create or replace function public.inventory_snapshot_movement() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.unit_id_snapshot := coalesce(new.unit_id_snapshot,new.unit_id);
  new.shelf_id_snapshot := coalesce(new.shelf_id_snapshot,new.shelf_id);
  select coalesce(new.shelf_code,s.code),coalesce(new.shelf_name,s.name),
    coalesce(new.item_type,(select u.item_name from public.inventory_units u where u.id=new.unit_id),s.item_type),
    coalesce(new.inventory_kind,(select u.inventory_kind from public.inventory_units u where u.id=new.unit_id))
    into new.shelf_code,new.shelf_name,new.item_type,new.inventory_kind from public.shelves s where s.id=new.shelf_id;
  new.item_description:=coalesce(new.item_description,(select description from public.inventory_units where id=new.unit_id));
  if new.unit_number is null then select unit_number into new.unit_number from public.inventory_units where id=new.unit_id; end if;
  return new;
end $$;

create or replace function public.inventory_item_category_stock_move(
  p_shelf_id uuid,p_direction text,p_item_name text,p_inventory_kind text,p_quantity integer,p_notes text default '',p_description text default ''
) returns void language plpgsql security invoker set search_path=public as $$
declare selected_shelf public.shelves; selected_name text; next_number integer; chosen_ids uuid[]; selected_stock public.inventory_units; display_number integer;
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
  if p_inventory_kind='consumable' then
    select * into selected_stock from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
      and lower(trim(item_name))=lower(trim(selected_name)) and retired_at is null and status='available' and condition='good' for update;
    if p_direction='in' then
      if selected_stock.id is not null then
        update public.inventory_units set quantity=quantity+p_quantity,
          description=case when nullif(trim(p_description),'') is null then description else trim(p_description) end where id=selected_stock.id;
      else
        select consumable_number into display_number from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
          and lower(trim(item_name))=lower(trim(selected_name)) order by unit_number limit 1;
        if display_number is null then
          display_number:=selected_shelf.next_consumable_number;
          update public.shelves set next_consumable_number=display_number+1 where id=p_shelf_id;
        end if;
        select greatest(selected_shelf.next_unit_number,coalesce(max(unit_number)+1,1)) into next_number from public.inventory_units where shelf_id=p_shelf_id;
        update public.shelves set next_unit_number=next_number+1 where id=p_shelf_id;
        insert into public.inventory_units(shelf_id,unit_number,item_name,inventory_kind,description,quantity,consumable_number)
          values(p_shelf_id,next_number,selected_name,'consumable',trim(coalesce(p_description,'')),p_quantity,display_number);
      end if;
    else
      if nullif(trim(p_notes),'') is null then raise exception 'Enter the reason for removing stock'; end if;
      if selected_stock.id is null or selected_stock.quantity<p_quantity then raise exception 'Not enough available consumable quantity'; end if;
      if exists(select 1 from public.transactions where unit_id=selected_stock.id and returned_at is null) then raise exception 'Return outstanding loans before issuing stock'; end if;
      update public.inventory_units set quantity=quantity-p_quantity where id=selected_stock.id;
    end if;
    return;
  end if;
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

create or replace function public.inventory_delete_shelf(p_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
declare changed_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to delete shelves'; end if;
  perform 1 from public.shelves where id=p_id for update;
  if not found then raise exception 'Shelf not found or already deleted'; end if;
  perform 1 from public.inventory_units where shelf_id=p_id order by id for update;
  if exists(select 1 from public.inventory_units where shelf_id=p_id and retired_at is null and quantity>0) then
    raise exception 'Move or delete all units before deleting this shelf'; end if;
  if exists(select 1 from public.inventory_units u where u.shelf_id=p_id and
    (u.status='borrowed' or exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null))) then
    raise exception 'Return borrowed equipment before deleting this shelf'; end if;
  delete from public.inventory_units where shelf_id=p_id;
  delete from public.shelves where id=p_id;
  get diagnostics changed_count = row_count;
  if changed_count<>1 then raise exception 'Could not delete the shelf. Check delete permissions'; end if;
end $$;
notify pgrst, 'reload schema';
commit;
