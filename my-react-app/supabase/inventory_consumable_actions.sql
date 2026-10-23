-- Run after inventory_consumable_quantities.sql. Safe to rerun.
begin;
create or replace function public.inventory_move_consumable(
  p_shelf_id uuid,p_item_name text,p_destination_shelf_id uuid,p_notes text default '',p_expected_quantity integer default null
) returns void language plpgsql security invoker set search_path=public as $$
declare source_shelf public.shelves; destination public.shelves; source_stock public.inventory_units;
  destination_stock public.inventory_units; display_number integer; next_number integer; total_quantity bigint;
  prior_action text; notes text;
begin
  if auth.uid() is null then raise exception 'Sign in to move consumables'; end if;
  if p_destination_shelf_id is null or p_destination_shelf_id=p_shelf_id then raise exception 'Choose a different destination shelf'; end if;
  if nullif(trim(p_item_name),'') is null then raise exception 'Choose a consumable item'; end if;
  if length(coalesce(p_notes,''))>1000 then raise exception 'Keep the notes within 1000 characters'; end if;
  perform 1 from public.shelves where id in (p_shelf_id,p_destination_shelf_id) order by id for update;
  select * into source_shelf from public.shelves where id=p_shelf_id;
  select * into destination from public.shelves where id=p_destination_shelf_id;
  if source_shelf.status is distinct from 'active'::public.shelf_status or destination.status is distinct from 'active'::public.shelf_status then
    raise exception 'Both shelves must be active'; end if;
  perform 1 from public.inventory_units where shelf_id in (p_shelf_id,p_destination_shelf_id) and inventory_kind='consumable'
    and lower(trim(item_name))=lower(trim(p_item_name)) order by shelf_id,id for update;
  select sum(quantity) into total_quantity from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
    and lower(trim(item_name))=lower(trim(p_item_name)) and retired_at is null;
  if total_quantity is null then raise exception 'Consumable item not found or already moved'; end if;
  if p_expected_quantity is not null and p_expected_quantity<>total_quantity then raise exception 'Consumable quantity changed. Refresh the shelf and try again'; end if;
  if exists(select 1 from public.inventory_units u where u.shelf_id in (p_shelf_id,p_destination_shelf_id)
    and u.inventory_kind='consumable' and lower(trim(u.item_name))=lower(trim(p_item_name))
    and (u.status='borrowed' or exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null))) then
    raise exception 'Return outstanding loans before moving this consumable'; end if;
  select consumable_number into display_number from public.inventory_units where shelf_id=p_destination_shelf_id and inventory_kind='consumable'
    and lower(trim(item_name))=lower(trim(p_item_name)) and retired_at is null order by unit_number limit 1;
  if display_number is null then
    display_number:=destination.next_consumable_number;
    update public.shelves set next_consumable_number=display_number+1 where id=p_destination_shelf_id;
  end if;
  update public.shelves set next_unit_number=greatest(next_unit_number,
    coalesce((select max(unit_number)+1 from public.inventory_units where shelf_id=p_shelf_id),1)) where id=p_shelf_id;
  prior_action:=coalesce(current_setting('inventoscan.consumable_action',true),'');
  perform set_config('inventoscan.consumable_action','transfer',true);
  notes:=format('Moved from %s to %s. %s',source_shelf.code,destination.code,coalesce(trim(p_notes),''));
  for source_stock in select * from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
    and lower(trim(item_name))=lower(trim(p_item_name)) and retired_at is null order by unit_number loop
    select * into destination_stock from public.inventory_units where shelf_id=p_destination_shelf_id and inventory_kind='consumable'
      and lower(trim(item_name))=lower(trim(p_item_name)) and retired_at is null
      and status=source_stock.status and condition=source_stock.condition;
    if source_stock.quantity>0 then
      insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,quantity,actor,notes,item_description)
        values(p_shelf_id,source_stock.id,source_stock.consumable_number,'out','Transfer out',source_stock.quantity,public.inventory_actor(),notes,source_stock.description);
    end if;
    if destination_stock.id is not null then
      update public.inventory_units set quantity=quantity+source_stock.quantity,
        description=case when description='' then source_stock.description else description end where id=destination_stock.id;
      if source_stock.quantity>0 then
        insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,quantity,actor,notes,item_description)
          values(p_destination_shelf_id,destination_stock.id,display_number,'in','Transfer in',source_stock.quantity,public.inventory_actor(),notes,source_stock.description);
      end if;
      delete from public.inventory_units where id=source_stock.id;
    else
      select greatest(next_unit_number,coalesce((select max(unit_number)+1 from public.inventory_units where shelf_id=p_destination_shelf_id),1))
        into next_number from public.shelves where id=p_destination_shelf_id;
      update public.shelves set next_unit_number=next_number+1 where id=p_destination_shelf_id;
      update public.inventory_units set shelf_id=p_destination_shelf_id,unit_number=next_number,consumable_number=display_number where id=source_stock.id;
      if source_stock.quantity>0 then
        insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,quantity,actor,notes,item_description)
          values(p_destination_shelf_id,source_stock.id,display_number,'in','Transfer in',source_stock.quantity,public.inventory_actor(),notes,source_stock.description);
      end if;
    end if;
  end loop;
  perform set_config('inventoscan.consumable_action',prior_action,true);
end $$;

create or replace function public.inventory_delete_consumable(
  p_shelf_id uuid,p_item_name text,p_reason text,p_expected_quantity integer default null
) returns void language plpgsql security invoker set search_path=public as $$
declare total_quantity bigint; prior_action text;
begin
  if auth.uid() is null then raise exception 'Sign in to delete consumables'; end if;
  if nullif(trim(p_item_name),'') is null then raise exception 'Choose a consumable item'; end if;
  if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Enter a deletion reason within 1000 characters'; end if;
  perform 1 from public.shelves where id=p_shelf_id and status='active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  perform 1 from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
    and lower(trim(item_name))=lower(trim(p_item_name)) order by id for update;
  select sum(quantity) into total_quantity from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
    and lower(trim(item_name))=lower(trim(p_item_name)) and retired_at is null;
  if total_quantity is null then raise exception 'Consumable item not found or already deleted'; end if;
  if p_expected_quantity is not null and p_expected_quantity<>total_quantity then raise exception 'Consumable quantity changed. Refresh the shelf and try again'; end if;
  if exists(select 1 from public.inventory_units u where u.shelf_id=p_shelf_id and u.inventory_kind='consumable'
    and lower(trim(u.item_name))=lower(trim(p_item_name))
    and (u.status='borrowed' or exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null))) then
    raise exception 'Return outstanding loans before deleting this consumable'; end if;
  prior_action:=coalesce(current_setting('inventoscan.consumable_action',true),'');
  perform set_config('inventoscan.consumable_action','delete',true);
  perform set_config('inventoscan.movement_notes',trim(p_reason),true);
  delete from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
    and lower(trim(item_name))=lower(trim(p_item_name)) and retired_at is null;
  perform set_config('inventoscan.consumable_action',prior_action,true);
end $$;

create or replace function public.inventory_guard_unit_delete() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if old.status='borrowed' or exists(select 1 from public.transactions where unit_id=old.id and returned_at is null) then
    raise exception 'Return borrowed equipment before deleting it'; end if;
  if old.inventory_kind='consumable' then
    if current_setting('inventoscan.consumable_action',true)='transfer' then return old; end if;
    if old.quantity>0 and old.retired_at is null then
      if current_setting('inventoscan.consumable_action',true) is distinct from 'delete' then
        raise exception 'Issue remaining consumable quantity before deleting it'; end if;
      insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,quantity,actor,notes)
        values(old.shelf_id,old.id,old.consumable_number,'out','Deleted consumable',old.quantity,public.inventory_actor(),current_setting('inventoscan.movement_notes',true));
    end if;
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
  if new.inventory_kind='consumable' and current_setting('inventoscan.consumable_action',true)='transfer' then return new; end if;
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

revoke execute on function public.inventory_move_consumable(uuid,text,uuid,text,integer),public.inventory_delete_consumable(uuid,text,text,integer) from public,anon;
grant execute on function public.inventory_move_consumable(uuid,text,uuid,text,integer),public.inventory_delete_consumable(uuid,text,text,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
