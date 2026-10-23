-- Run after inventory_shelf_items.sql. Safe to rerun; existing items remain intact.
begin;
alter table public.inventory_units add column if not exists description text not null default '';

create or replace function public.inventory_receive_items(
  p_shelf_id uuid,p_item_name text,p_quantity integer,p_description text default ''
) returns void language plpgsql security invoker set search_path=public as $$
declare selected_shelf public.shelves; selected_name text; next_number integer;
begin
  if auth.uid() is null then raise exception 'Sign in to add items'; end if;
  if p_quantity is null or p_quantity<1 or p_quantity>1000 then
    raise exception 'Enter a quantity from 1 to 1000'; end if;
  if nullif(trim(p_item_name),'') is null or length(trim(p_item_name))>120 then
    raise exception 'Enter an item name from 1 to 120 characters'; end if;
  if length(coalesce(p_description,''))>1000 then raise exception 'Keep the description within 1000 characters'; end if;
  select * into selected_shelf from public.shelves where id=p_shelf_id for update;
  if not found or selected_shelf.status<>'active' then raise exception 'Active shelf not found'; end if;
  select item_name into selected_name from public.inventory_units
    where shelf_id=p_shelf_id and lower(trim(item_name))=lower(trim(p_item_name)) order by created_at,id limit 1;
  selected_name := coalesce(selected_name,trim(p_item_name));
  select greatest(selected_shelf.next_unit_number,coalesce(max(unit_number)+1,1)) into next_number
    from public.inventory_units where shelf_id=p_shelf_id;
  update public.shelves set next_unit_number=next_number+p_quantity where id=p_shelf_id;
  perform set_config('inventoscan.movement_notes','',true);
  insert into public.inventory_units(shelf_id,unit_number,item_name,description)
    select p_shelf_id,next_number+n-1,selected_name,trim(coalesce(p_description,'')) from generate_series(1,p_quantity) n;
end $$;

revoke execute on function public.inventory_receive_items(uuid,text,integer,text) from public,anon;
grant execute on function public.inventory_receive_items(uuid,text,integer,text) to authenticated;
notify pgrst, 'reload schema';
commit;
