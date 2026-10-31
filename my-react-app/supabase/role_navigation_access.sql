-- Run after atomic_registration.sql as the database owner. Safe to rerun.
-- Common inventory and records access remains laboratory-scoped as before.
begin;

create or replace function public.inventory_can_check_laboratory(p_laboratory_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_laboratory_id is not null and exists(
    select 1 from public.user_accounts u join public.laboratory_memberships m on m.user_id=u.id
    where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active' and u.role='Operator'
      and m.laboratory_id=p_laboratory_id and m.role='Laboratory Admin');
$$;

create or replace function public.inventory_can_operate_laboratory(p_laboratory_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_laboratory_id is not null and exists(
    select 1 from public.user_accounts u join public.laboratory_memberships m on m.user_id=u.id
    where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active' and u.role='Operator'
      and m.laboratory_id=p_laboratory_id and m.role='Laboratory Operator');
$$;

-- Lock the caller's profile/membership while saving so role changes cannot
-- commit halfway through a check or daily operation.
create or replace function public.inventory_require_laboratory_role(p_laboratory_id uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare account_id uuid;
begin
  if auth.uid() is null or p_laboratory_id is null or p_role is null
    or p_role not in ('Laboratory Admin','Laboratory Operator') then
    raise exception 'A matching laboratory role is required';
  end if;
  select u.id into account_id from public.user_accounts u
    where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active' and u.role='Operator' for share;
  if account_id is not null then
    perform 1 from public.laboratory_memberships m where m.user_id=account_id
      and m.laboratory_id=p_laboratory_id and m.role=p_role for share;
    if found then return; end if;
  end if;
  raise exception 'Only an assigned % can perform this action', p_role;
end $$;

revoke all on function public.inventory_can_check_laboratory(uuid),public.inventory_can_operate_laboratory(uuid),
  public.inventory_require_laboratory_role(uuid,text) from public,anon;
grant execute on function public.inventory_can_check_laboratory(uuid),public.inventory_can_operate_laboratory(uuid),
  public.inventory_require_laboratory_role(uuid,text) to authenticated;

-- Preserve shared transaction-history reads; only operators can write loans.
drop policy if exists "operators create loans" on public.transactions;
create policy "operators create loans" on public.transactions as restrictive for insert to authenticated
  with check(public.inventory_can_operate_laboratory(laboratory_id));
drop policy if exists "operators update loans" on public.transactions;
create policy "operators update loans" on public.transactions as restrictive for update to authenticated
  using(public.inventory_can_operate_laboratory(laboratory_id))
  with check(public.inventory_can_operate_laboratory(laboratory_id));

create or replace function public.inventory_guard_daily_unit_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lab_id uuid;
begin
  if (old.status='borrowed' or new.status='borrowed')
    and (old.status is distinct from new.status or old.condition is distinct from new.condition) then
    select laboratory_id into lab_id from public.shelves where id=old.shelf_id;
    perform public.inventory_require_laboratory_role(lab_id,'Laboratory Operator');
  end if;
  return new;
end $$;
revoke all on function public.inventory_guard_daily_unit_status() from public,anon,authenticated;
drop trigger if exists inventory_guard_daily_unit_status on public.inventory_units;
create trigger inventory_guard_daily_unit_status before update of status,condition on public.inventory_units
  for each row execute function public.inventory_guard_daily_unit_status();

create or replace function public.inventory_guard_check_role() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lab_id uuid;
begin
  select laboratory_id into lab_id from public.shelves where id=new.shelf_id;
  perform public.inventory_require_laboratory_role(lab_id,'Laboratory Admin');
  return new;
end $$;
revoke all on function public.inventory_guard_check_role() from public,anon,authenticated;
drop trigger if exists inventory_guard_check_role on public.inventory_checks;
create trigger inventory_guard_check_role before insert on public.inventory_checks
  for each row execute function public.inventory_guard_check_role();

-- The categorized stock function below retains existing stock-in behavior.
-- Stock-out (including calls from legacy stock RPCs) requires an operator.
create or replace function public.inventory_item_category_stock_move(
  p_shelf_id uuid,p_direction text,p_item_name text,p_inventory_kind text,p_quantity integer,p_notes text default '',p_description text default ''
) returns void language plpgsql security invoker set search_path=public as $$
declare selected_shelf public.shelves; selected_name text; next_number integer; chosen_ids uuid[]; selected_stock public.inventory_units; display_number integer;
begin
  if p_direction='out' then
    perform public.inventory_require_laboratory_role(
      (select laboratory_id from public.shelves where id=p_shelf_id),'Laboratory Operator');
  end if;
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

revoke all on function public.inventory_item_category_stock_move(uuid,text,text,text,integer,text,text) from public,anon;
grant execute on function public.inventory_item_category_stock_move(uuid,text,text,text,integer,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
