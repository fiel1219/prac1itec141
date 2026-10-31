-- Run after role_navigation_access.sql as the database owner. Safe to rerun.
-- Operators view inventory and use validated daily-operation RPCs.
-- System Admins and assigned Laboratory Admins manage inventory.
begin;

create or replace function public.inventory_can_manage_laboratory(p_laboratory_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_laboratory_id is not null and (
    public.inventory_is_system_admin() or exists(
      select 1 from public.user_accounts u join public.laboratory_memberships m on m.user_id=u.id
      where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active' and u.role='Operator'
        and m.laboratory_id=p_laboratory_id and m.role='Laboratory Admin'));
$$;

create or replace function public.inventory_can_operate_laboratory(p_laboratory_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_laboratory_id is not null and exists(
    select 1 from public.user_accounts u join public.laboratory_memberships m on m.user_id=u.id
    where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active' and u.role='Operator'
      and m.laboratory_id=p_laboratory_id and m.role in ('Laboratory Admin','Laboratory Operator'));
$$;

create or replace function public.inventory_require_action_access(p_laboratory_id uuid,p_action text)
returns void language plpgsql security definer set search_path = '' as $$
declare account public.user_accounts;
begin
  if auth.uid() is null or p_laboratory_id is null or p_action is null or p_action not in ('manage','operate') then
    raise exception 'A matching laboratory permission is required';
  end if;
  select u.* into account from public.user_accounts u
    where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active' for share;
  if account.id is not null then
    if p_action='manage' and account.role='Admin' then return; end if;
    if account.role='Operator' then
      perform 1 from public.laboratory_memberships m where m.user_id=account.id and m.laboratory_id=p_laboratory_id
        and (m.role='Laboratory Admin' or (p_action='operate' and m.role='Laboratory Operator')) for share;
      if found then return; end if;
    end if;
  end if;
  if p_action='manage' then raise exception 'Only a System Admin or assigned Laboratory Admin can manage inventory'; end if;
  raise exception 'Only assigned Laboratory Admins and Operators can perform daily operations';
end $$;

revoke all on function public.inventory_can_manage_laboratory(uuid),public.inventory_can_operate_laboratory(uuid),
  public.inventory_require_action_access(uuid,text) from public,anon;
grant execute on function public.inventory_can_manage_laboratory(uuid),public.inventory_can_operate_laboratory(uuid),
  public.inventory_require_action_access(uuid,text) to authenticated;

-- Read policies remain unchanged. Inventory writes require management rights.
drop policy if exists "managers insert shelves" on public.shelves;
create policy "managers insert shelves" on public.shelves as restrictive for insert to authenticated
  with check(public.inventory_can_manage_laboratory(laboratory_id));
drop policy if exists "managers update shelves" on public.shelves;
create policy "managers update shelves" on public.shelves as restrictive for update to authenticated
  using(public.inventory_can_manage_laboratory(laboratory_id)) with check(public.inventory_can_manage_laboratory(laboratory_id));
drop policy if exists "managers delete shelves" on public.shelves;
create policy "managers delete shelves" on public.shelves as restrictive for delete to authenticated
  using(public.inventory_can_manage_laboratory(laboratory_id));

drop policy if exists "managers insert inventory" on public.inventory_units;
create policy "managers insert inventory" on public.inventory_units as restrictive for insert to authenticated
  with check(exists(select 1 from public.shelves s where s.id=shelf_id and public.inventory_can_manage_laboratory(s.laboratory_id)));
drop policy if exists "managers update inventory" on public.inventory_units;
create policy "managers update inventory" on public.inventory_units as restrictive for update to authenticated
  using(exists(select 1 from public.shelves s where s.id=shelf_id and public.inventory_can_manage_laboratory(s.laboratory_id)))
  with check(exists(select 1 from public.shelves s where s.id=shelf_id and public.inventory_can_manage_laboratory(s.laboratory_id)));
drop policy if exists "managers delete inventory" on public.inventory_units;
create policy "managers delete inventory" on public.inventory_units as restrictive for delete to authenticated
  using(exists(select 1 from public.shelves s where s.id=shelf_id and public.inventory_can_manage_laboratory(s.laboratory_id)));

drop policy if exists "managers insert movements" on public.stock_movements;
create policy "managers insert movements" on public.stock_movements as restrictive for insert to authenticated
  with check(public.inventory_can_manage_laboratory(laboratory_id));
drop policy if exists "managers update movements" on public.stock_movements;
create policy "managers update movements" on public.stock_movements as restrictive for update to authenticated
  using(public.inventory_can_manage_laboratory(laboratory_id)) with check(public.inventory_can_manage_laboratory(laboratory_id));
drop policy if exists "managers delete movements" on public.stock_movements;
create policy "managers delete movements" on public.stock_movements as restrictive for delete to authenticated
  using(public.inventory_can_manage_laboratory(laboratory_id));

-- Loan writes go through the guarded RPCs below, including staff with both roles.
revoke insert,update,delete on public.transactions from public,anon,authenticated;

create or replace function public.inventory_guard_daily_unit_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lab_id uuid;
begin
  if (old.status='borrowed' or new.status='borrowed')
    and (old.status is distinct from new.status or old.condition is distinct from new.condition) then
    select laboratory_id into lab_id from public.shelves where id=old.shelf_id;
    perform public.inventory_require_action_access(lab_id,'operate');
  end if;
  return new;
end $$;
revoke all on function public.inventory_guard_daily_unit_status() from public,anon,authenticated;

-- Daily RPCs retain their stock validation and history behavior, but run their
-- writes as owner after checking and locking the caller's laboratory permission.
create or replace function public.inventory_checkout(p_unit_id uuid, p_borrower_id uuid, p_expected_return date)
returns void language plpgsql security definer set search_path = public as $$
declare selected_unit public.inventory_units;
begin
  perform public.inventory_require_action_access((select laboratory_id from public.shelves where id=(select shelf_id from public.inventory_units where id=p_unit_id)),'operate');
  if auth.uid() is null then raise exception 'Sign in to check out an item'; end if;
  -- All stock operations acquire the shelf lock before a unit lock.
  perform 1 from public.shelves where id = (select shelf_id from public.inventory_units where id = p_unit_id) and status = 'active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  select * into selected_unit from public.inventory_units where id = p_unit_id for update;
  if not found or selected_unit.retired_at is not null or selected_unit.status <> 'available' or selected_unit.condition <> 'good'
    or exists(select 1 from public.transactions where unit_id = p_unit_id and returned_at is null) then
    raise exception 'This item is no longer available. Refresh and choose another item';
  end if;
  -- Recheck the locked unit's actual shelf in case it moved during lookup.
  perform public.inventory_require_action_access((select laboratory_id from public.shelves where id=selected_unit.shelf_id),'operate');
  if p_expected_return is null or p_expected_return < current_date then raise exception 'Return date must be today or later'; end if;
  insert into public.transactions(borrower_id,unit_id,expected_return_at,borrowed_by)
    values(p_borrower_id,p_unit_id,p_expected_return,public.inventory_actor());
  update public.inventory_units set status = 'borrowed' where id = p_unit_id;
end $$;
create or replace function public.inventory_return(p_transaction_id uuid,p_condition text)
returns void language plpgsql security definer set search_path=public as $$
declare selected_transaction public.transactions; selected_unit public.inventory_units;
  selected_unit_id uuid; changed_count integer; next_status public.unit_status;
begin
  perform public.inventory_require_action_access((select s.laboratory_id from public.transactions t join public.inventory_units u on u.id=t.unit_id join public.shelves s on s.id=u.shelf_id where t.id=p_transaction_id),'operate');
  if auth.uid() is null then raise exception 'Sign in to return an item'; end if;
  if p_condition is null or p_condition not in ('good','damaged') then raise exception 'Choose good or damaged condition'; end if;
  select unit_id into selected_unit_id from public.transactions where id=p_transaction_id;
  if not found then raise exception 'Transaction not found or already returned'; end if;
  perform 1 from public.shelves where id=(select shelf_id from public.inventory_units where id=selected_unit_id) for update;
  select * into selected_unit from public.inventory_units where id=selected_unit_id for update;
  if not found or selected_unit.retired_at is not null then raise exception 'Equipment unit not found or removed'; end if;
  perform public.inventory_require_action_access((select laboratory_id from public.shelves where id=selected_unit.shelf_id),'operate');
  select * into selected_transaction from public.transactions where id=p_transaction_id for update;
  if not found or selected_transaction.returned_at is not null then raise exception 'Transaction not found or already returned'; end if;
  update public.transactions set returned_at=now(),return_status='returned',
    return_condition=p_condition::public.unit_condition,returned_by=public.inventory_actor() where id=p_transaction_id;
  get diagnostics changed_count = row_count;
  if changed_count<>1 then raise exception 'Could not update the loan record. Check return permissions'; end if;
  -- Legacy data may contain more than one open loan for a unit. Keep it borrowed until all are closed.
  if exists(select 1 from public.transactions where unit_id=selected_unit_id and returned_at is null) then
    next_status := 'borrowed';
  elsif p_condition='damaged' then next_status := 'under_maintenance';
  else next_status := 'available'; end if;
  perform set_config('inventoscan.movement_notes','Equipment return recorded',true);
  update public.inventory_units set condition=p_condition::public.unit_condition,status=next_status where id=selected_unit_id;
  get diagnostics changed_count = row_count;
  if changed_count<>1 then raise exception 'Could not update the equipment status. Check return permissions'; end if;
end $$;
create or replace function public.inventory_reconcile_return(p_unit_id uuid,p_condition text,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare selected_unit public.inventory_units; changed_count integer;
begin
  perform public.inventory_require_action_access((select laboratory_id from public.shelves where id=(select shelf_id from public.inventory_units where id=p_unit_id)),'operate');
  if auth.uid() is null then raise exception 'Sign in to confirm equipment returns'; end if;
  if p_condition is null or p_condition not in ('good','damaged') then raise exception 'Choose good or damaged condition'; end if;
  if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Enter a return confirmation reason within 1000 characters'; end if;
  perform 1 from public.shelves where id=(select shelf_id from public.inventory_units where id=p_unit_id) for update;
  select * into selected_unit from public.inventory_units where id=p_unit_id for update;
  if not found or selected_unit.retired_at is not null then raise exception 'Equipment unit not found or removed'; end if;
  perform public.inventory_require_action_access((select laboratory_id from public.shelves where id=selected_unit.shelf_id),'operate');
  if exists(select 1 from public.transactions where unit_id=p_unit_id and returned_at is null) then
    raise exception 'This unit still has an active loan. Record its return first'; end if;
  if selected_unit.status<>'borrowed' then raise exception 'The unit status already changed. Refresh the shelf'; end if;
  perform set_config('inventoscan.movement_notes','Confirmed physical return with no active loan: '||trim(p_reason),true);
  update public.inventory_units set condition=p_condition::public.unit_condition,
    status=case when p_condition='damaged' then 'under_maintenance'::public.unit_status else 'available'::public.unit_status end
    where id=p_unit_id;
  get diagnostics changed_count = row_count;
  if changed_count<>1 then raise exception 'Could not update the equipment status. Check return permissions'; end if;
end $$;
create or replace function public.inventory_stock_move(p_shelf_id uuid,p_direction text,p_quantity integer,p_notes text default '')
returns void language plpgsql security definer set search_path=public as $$
declare names text[]; legacy_name text;
begin
  perform public.inventory_require_action_access((select laboratory_id from public.shelves where id=p_shelf_id),case when p_direction='out' then 'operate' else 'manage' end);
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  select item_type into legacy_name from public.shelves where id=p_shelf_id and status='active' for update;
  if not found then raise exception 'Active shelf not found'; end if;
  select array_agg(distinct item_name) into names from public.inventory_units where shelf_id=p_shelf_id and retired_at is null;
  if coalesce(cardinality(names),0)>1 then raise exception 'Choose an item in the updated stock form'; end if;
  perform public.inventory_item_stock_move(p_shelf_id,p_direction,coalesce(names[1],nullif(trim(legacy_name),''),'Item'),p_quantity,p_notes);
end $$;
create or replace function public.inventory_item_category_stock_move(
  p_shelf_id uuid,p_direction text,p_item_name text,p_inventory_kind text,p_quantity integer,p_notes text default '',p_description text default ''
) returns void language plpgsql security definer set search_path=public as $$
declare selected_shelf public.shelves; selected_name text; next_number integer; chosen_ids uuid[]; selected_stock public.inventory_units; display_number integer;
begin
  perform public.inventory_require_action_access(
    (select laboratory_id from public.shelves where id=p_shelf_id),
    case when p_direction='out' then 'operate' else 'manage' end);
  if p_direction='out' and p_inventory_kind<>'consumable' then
    raise exception 'Borrow equipment through checkout. Only consumables can be issued';
  end if;
  if auth.uid() is null then raise exception 'Sign in to record stock'; end if;
  if p_inventory_kind is null or p_inventory_kind not in ('equipment','consumable') then raise exception 'Choose equipment or consumables'; end if;
  if p_direction is null or p_direction not in ('in','out') or p_quantity is null or p_quantity<1 or p_quantity>1000 then
    raise exception 'Choose stock-in or stock-out and a quantity from 1 to 1000'; end if;
  if nullif(trim(p_item_name),'') is null or length(trim(p_item_name))>120 then raise exception 'Enter an item name from 1 to 120 characters'; end if;
  if length(coalesce(p_notes,''))>1000 or length(coalesce(p_description,''))>1000 then raise exception 'Keep notes and description within 1000 characters'; end if;
  select * into selected_shelf from public.shelves where id=p_shelf_id for update;
  if not found or selected_shelf.status<>'active' then raise exception 'Active shelf not found'; end if;
  perform public.inventory_require_action_access(selected_shelf.laboratory_id,
    case when p_direction='out' then 'operate' else 'manage' end);
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

-- Legacy named-item calls also lock the shelf while resolving its category.
create or replace function public.inventory_item_stock_move(p_shelf_id uuid,p_direction text,p_item_name text,p_quantity integer,p_notes text default '')
returns void language plpgsql security definer set search_path=public as $$
begin
  perform public.inventory_require_action_access((select laboratory_id from public.shelves where id=p_shelf_id),
    case when p_direction='out' then 'operate' else 'manage' end);
  perform public.inventory_item_category_stock_move(p_shelf_id,p_direction,p_item_name,
    public.inventory_legacy_item_kind(p_shelf_id,p_item_name),p_quantity,p_notes,'');
end $$;

revoke all on function public.inventory_checkout(uuid,uuid,date),public.inventory_return(uuid,text),
  public.inventory_reconcile_return(uuid,text,text),public.inventory_stock_move(uuid,text,integer,text),
  public.inventory_item_category_stock_move(uuid,text,text,text,integer,text,text),
  public.inventory_item_stock_move(uuid,text,text,integer,text) from public,anon;
grant execute on function public.inventory_checkout(uuid,uuid,date),public.inventory_return(uuid,text),
  public.inventory_reconcile_return(uuid,text,text),public.inventory_stock_move(uuid,text,integer,text),
  public.inventory_item_category_stock_move(uuid,text,text,text,integer,text,text),
  public.inventory_item_stock_move(uuid,text,text,integer,text) to authenticated;
notify pgrst, 'reload schema';
commit;
