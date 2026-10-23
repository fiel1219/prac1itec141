-- Run after inventory_consumable_actions.sql. Safe to rerun.
begin;
create or replace function public.inventory_bulk_item_action(
  p_shelf_id uuid,p_action text,p_equipment_ids uuid[] default '{}',p_consumables jsonb default '[]',
  p_destination_shelf_id uuid default null,p_reason text default ''
) returns void language plpgsql security invoker set search_path=public as $$
declare equipment_id uuid; consumable jsonb; equipment_ids uuid[]:=coalesce(p_equipment_ids,'{}');
  consumables jsonb:=coalesce(p_consumables,'[]'); expected_quantity integer;
begin
  if auth.uid() is null then raise exception 'Sign in to manage selected items'; end if;
  if p_action is null or p_action not in ('move','delete') then raise exception 'Choose Move or Delete'; end if;
  if jsonb_typeof(consumables)<>'array' then raise exception 'Choose a valid consumable selection'; end if;
  if cardinality(equipment_ids)=0 and jsonb_array_length(consumables)=0 then raise exception 'Select at least one item'; end if;
  if length(coalesce(p_reason,''))>1000 then raise exception 'Keep the reason or notes within 1000 characters'; end if;
  if p_action='delete' and nullif(trim(p_reason),'') is null then raise exception 'Enter a deletion reason'; end if;
  if p_action='move' and (p_destination_shelf_id is null or p_destination_shelf_id=p_shelf_id) then
    raise exception 'Choose a different destination shelf'; end if;
  if exists(select 1 from unnest(equipment_ids) as selected(id) where id is null)
    or cardinality(equipment_ids)<>(select count(distinct id) from unnest(equipment_ids) as selected(id)) then
    raise exception 'Choose each equipment item only once'; end if;
  for consumable in select value from jsonb_array_elements(consumables) loop
    if jsonb_typeof(consumable)<>'object' or jsonb_typeof(consumable->'item_name') is distinct from 'string'
      or nullif(trim(consumable->>'item_name'),'') is null
      or jsonb_typeof(consumable->'expected_quantity') is distinct from 'number'
      or (consumable->>'expected_quantity') !~ '^[0-9]+$' then
      raise exception 'Each selected consumable needs its item name and whole-number quantity'; end if;
    -- Cast here so an out-of-range quantity fails before any inventory changes.
    expected_quantity:=(consumable->>'expected_quantity')::integer;
  end loop;
  if exists(select 1 from jsonb_array_elements(consumables) as selected(item)
    group by lower(trim(item->>'item_name')) having count(*)>1) then
    raise exception 'Choose each consumable item only once'; end if;

  -- One RPC is one transaction. Reuse the single-item routines and their history/
  -- quantity guards; any failure rolls back all preceding changes in this batch.
  perform 1 from public.shelves where id=p_shelf_id or (p_action='move' and id=p_destination_shelf_id) order by id for update;
  if not exists(select 1 from public.shelves where id=p_shelf_id and status='active') then
    raise exception 'Active source shelf not found'; end if;
  if p_action='move' and not exists(select 1 from public.shelves where id=p_destination_shelf_id and status='active') then
    raise exception 'Active destination shelf not found'; end if;
  perform 1 from public.inventory_units where id=any(equipment_ids) order by id for update;
  if (select count(*) from public.inventory_units where id=any(equipment_ids) and shelf_id=p_shelf_id
    and inventory_kind='equipment' and retired_at is null)<>cardinality(equipment_ids) then
    raise exception 'A selected equipment item changed shelves or was deleted. Refresh and select again'; end if;
  if exists(select 1 from public.inventory_units u where u.id=any(equipment_ids)
    and (u.status='borrowed' or exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null))) then
    raise exception 'Return borrowed equipment before moving or deleting it'; end if;
  for equipment_id in select id from unnest(equipment_ids) as selected(id) order by id loop
    if p_action='move' then
      perform public.inventory_move_unit(equipment_id,p_destination_shelf_id,coalesce(p_reason,''));
    else
      perform public.inventory_delete_unit(equipment_id,p_reason);
    end if;
    if (p_action='move' and not exists(select 1 from public.inventory_units where id=equipment_id and shelf_id=p_destination_shelf_id))
      or (p_action='delete' and exists(select 1 from public.inventory_units where id=equipment_id)) then
      raise exception 'Could not update every selected equipment item. Check inventory permissions'; end if;
  end loop;
  for consumable in select value from jsonb_array_elements(consumables) order by lower(trim(value->>'item_name')) loop
    if p_action='move' then
      perform public.inventory_move_consumable(p_shelf_id,consumable->>'item_name',p_destination_shelf_id,coalesce(p_reason,''),(consumable->>'expected_quantity')::integer);
    else
      perform public.inventory_delete_consumable(p_shelf_id,consumable->>'item_name',p_reason,(consumable->>'expected_quantity')::integer);
    end if;
    if exists(select 1 from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable' and retired_at is null
      and lower(trim(item_name))=lower(trim(consumable->>'item_name'))) then
      raise exception 'Could not update every selected consumable. Check inventory permissions'; end if;
  end loop;
end $$;
revoke execute on function public.inventory_bulk_item_action(uuid,text,uuid[],jsonb,uuid,text) from public,anon;
grant execute on function public.inventory_bulk_item_action(uuid,text,uuid[],jsonb,uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
