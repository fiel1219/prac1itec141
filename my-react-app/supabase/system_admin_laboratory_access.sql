-- Run after inventory_checks.sql and security_hardening.sql. Safe to rerun.
-- Gives active System Admins all-laboratory inventory and inspection access.
-- Laboratory Admins and Operators still require an active matching membership.
-- No accounts, memberships, inventory, or history are changed.
begin;

create or replace function public.inventory_can_access_laboratory(p_laboratory_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and p_laboratory_id is not null and (
    public.inventory_is_system_admin() or exists(select 1 from public.user_accounts u
      join public.laboratory_memberships m on m.user_id=u.id
      where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active'
        and m.laboratory_id=p_laboratory_id and m.role in ('Laboratory Admin','Laboratory Operator')))
$$;

create or replace function public.inventory_can_check_laboratory(p_laboratory_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and p_laboratory_id is not null and (public.inventory_is_system_admin() or exists (
    select 1 from public.user_accounts u join public.laboratory_memberships m on m.user_id=u.id
    where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active'
      and m.laboratory_id=p_laboratory_id and m.role in ('Laboratory Admin','Laboratory Operator')
  ))
$$;

revoke all on function public.inventory_can_access_laboratory(uuid),public.inventory_can_check_laboratory(uuid) from public,anon;
grant execute on function public.inventory_can_access_laboratory(uuid),public.inventory_can_check_laboratory(uuid) to authenticated;

create or replace function public.inventory_save_shelf_check(
  p_laboratory_id uuid,p_shelf_id uuid,p_items jsonb,p_comments text default ''
) returns uuid language plpgsql security definer set search_path=public as $$
declare source_shelf public.shelves; checker public.user_accounts; finding record;
  source_unit public.inventory_units; target_stock public.inventory_units;
  target_status public.unit_status; results jsonb; check_id uuid;
  expected_count bigint; inspected_count bigint; damaged_count bigint; missing_count bigint;
  eligible_count integer; prior_action text; prior_notes text; note text;
begin
  if not public.inventory_can_check_laboratory(p_laboratory_id) then
    raise exception 'Only assigned laboratory staff or System Admins can check this laboratory';
  end if;
  select * into source_shelf from public.shelves where id=p_shelf_id and laboratory_id=p_laboratory_id and status='active' for update;
  if not found then raise exception 'Shelf not found in this laboratory. Reload the shelf'; end if;
  -- Lock the account before checking its current role. Members additionally
  -- lock their assignment; System Admins need no laboratory membership.
  select u.* into checker from public.user_accounts u
    where lower(u.email)=lower(auth.jwt()->>'email') and u.status='active' for share;
  if not found then raise exception 'Your account changed. Sign in again'; end if;
  if checker.role <> 'Admin' then
    perform 1 from public.laboratory_memberships m where m.user_id=checker.id and m.laboratory_id=p_laboratory_id
      and m.role in ('Laboratory Admin','Laboratory Operator') for share;
    if not found then raise exception 'Your laboratory assignment changed. Sign in again'; end if;
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Review the shelf items before saving a check';
  end if;
  if length(coalesce(p_comments,''))>1000 then raise exception 'Keep check notes within 1000 characters'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as x(unit_id uuid) group by unit_id having count(*)>1) then
    raise exception 'Review each stock record only once'; end if;
  perform 1 from public.inventory_units where shelf_id=p_shelf_id and retired_at is null order by id for update;
  select count(*) into eligible_count from public.inventory_units u where shelf_id=p_shelf_id and retired_at is null
    and status in ('available','under_maintenance') and quantity>0
    and not exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null);
  if eligible_count<>jsonb_array_length(p_items) then
    raise exception 'Shelf items changed or some items were not reviewed. Reload the shelf and review every available item';
  end if;
  for finding in select * from jsonb_to_recordset(p_items) as x(
    unit_id uuid,expected_status text,expected_condition text,expected_quantity integer,condition text,notes text
  ) loop
    if finding.condition is null or finding.condition not in ('good','damaged') then
      raise exception 'Choose Good or Damaged for every item'; end if;
    if length(coalesce(finding.notes,''))>1000 then raise exception 'Keep each observation within 1000 characters'; end if;
    select * into source_unit from public.inventory_units u where id=finding.unit_id and shelf_id=p_shelf_id
      and retired_at is null and status in ('available','under_maintenance') and quantity>0
      and not exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null);
    if not found or source_unit.status::text is distinct from finding.expected_status
      or source_unit.condition::text is distinct from finding.expected_condition
      or source_unit.quantity is distinct from finding.expected_quantity then
      raise exception 'An item changed, moved, or was borrowed. Reload the shelf before saving';
    end if;
  end loop;

  -- Store immutable item identities and quantities before updating or merging
  -- stock. Equipment identities and QR codes are never replaced.
  select jsonb_agg(jsonb_build_object(
    'unit_id',u.id,'item_name',u.item_name,'inventory_kind',u.inventory_kind,'description',u.description,
    'reference',(case when u.inventory_kind='equipment' then 'Equipment ' else 'Consumable ' end)
      ||lpad((case when u.inventory_kind='equipment' then u.unit_number else coalesce(u.consumable_number,u.unit_number) end)::text,3,'0'),
    'quantity',u.quantity,'previous_status',u.status,'previous_condition',u.condition,
    'condition',coalesce(x.condition,u.condition::text),'notes',coalesce(trim(x.notes),''),'skipped',x.unit_id is null
  ) order by u.item_name,u.unit_number),sum(u.quantity),
    coalesce(sum(u.quantity) filter(where x.unit_id is not null),0),
    coalesce(sum(u.quantity) filter(where x.condition='damaged'),0),
    coalesce(sum(u.quantity) filter(where u.status in ('missing','not_found')),0)
  into results,expected_count,inspected_count,damaged_count,missing_count
  from public.inventory_units u left join jsonb_to_recordset(p_items) as x(unit_id uuid,condition text,notes text) on x.unit_id=u.id
  where u.shelf_id=p_shelf_id and u.retired_at is null;

  prior_action:=coalesce(current_setting('inventoscan.consumable_action',true),'');
  prior_notes:=coalesce(current_setting('inventoscan.movement_notes',true),'');
  -- Temporarily exclude inspected consumables from their unique stock index.
  -- Reuse transfer consolidation so reclassification does not invent receipts,
  -- stock issues or deletions. Total quantity remains unchanged.
  perform set_config('inventoscan.consumable_action','transfer',true);
  update public.inventory_units set retired_at=now() where inventory_kind='consumable'
    and id in(select x.unit_id from jsonb_to_recordset(p_items) as x(unit_id uuid));
  for finding in select * from jsonb_to_recordset(p_items) as x(unit_id uuid,condition text,notes text) loop
    select * into source_unit from public.inventory_units where id=finding.unit_id;
    target_status:=case when finding.condition='damaged' then 'under_maintenance'::public.unit_status else 'available'::public.unit_status end;
    note:=concat_ws(' · ','Inventory check',nullif(trim(finding.notes),''),nullif(trim(p_comments),''));
    perform set_config('inventoscan.movement_notes',note,true);
    if source_unit.inventory_kind='equipment' then
      update public.inventory_units set condition=finding.condition::public.unit_condition,status=target_status where id=source_unit.id;
    else
      select * into target_stock from public.inventory_units where shelf_id=p_shelf_id and inventory_kind='consumable'
        and lower(trim(item_name))=lower(trim(source_unit.item_name)) and retired_at is null
        and status=target_status and condition=finding.condition::public.unit_condition;
      if target_stock.id is null then
        update public.inventory_units set condition=finding.condition::public.unit_condition,status=target_status,retired_at=null where id=source_unit.id;
      else
        update public.inventory_units set quantity=quantity+source_unit.quantity where id=target_stock.id;
      end if;
      if source_unit.condition::text<>finding.condition or source_unit.status<>target_status then
        insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,quantity,actor,notes,item_description)
          values(p_shelf_id,coalesce(target_stock.id,source_unit.id),source_unit.consumable_number,'adjustment','Inventory check',source_unit.quantity,
            coalesce(nullif(checker.full_name,''),checker.email),note,source_unit.description);
      end if;
      if target_stock.id is not null then delete from public.inventory_units where id=source_unit.id; end if;
    end if;
  end loop;
  perform set_config('inventoscan.consumable_action',prior_action,true);
  perform set_config('inventoscan.movement_notes',prior_notes,true);
  insert into public.inventory_checks(shelf_id,performed_by,performed_by_user_id,result,expected_units,present_units,
    not_found_units,damaged_units,skipped_units,comments,item_results)
  values(p_shelf_id,coalesce(nullif(checker.full_name,''),checker.email),checker.id,
    case when damaged_count>0 then 'damaged_items_found' else 'good' end,expected_count,inspected_count,missing_count,
    damaged_count,expected_count-inspected_count,nullif(trim(p_comments),''),results) returning id into check_id;
  return check_id;
end $$;
revoke all on function public.inventory_save_shelf_check(uuid,uuid,jsonb,text) from public,anon;
grant execute on function public.inventory_save_shelf_check(uuid,uuid,jsonb,text) to authenticated;

notify pgrst, 'reload schema';
commit;
