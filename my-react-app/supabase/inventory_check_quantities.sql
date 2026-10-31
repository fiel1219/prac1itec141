-- Run after system_admin_laboratory_access.sql. Safe to rerun.
-- Equipment checks update condition. Consumable counts are audit findings only.
begin;
alter table public.inventory_checks add column if not exists quantity_discrepancies integer not null default 0
  check (quantity_discrepancies >= 0);

create or replace function public.inventory_save_categorized_shelf_check(
  p_laboratory_id uuid,p_shelf_id uuid,p_items jsonb,p_comments text default ''
) returns uuid language plpgsql security definer set search_path=public as $$
declare source_shelf public.shelves; checker public.user_accounts; finding record;
  source_unit public.inventory_units; target_status public.unit_status;
  results jsonb; check_id uuid; expected_count bigint; inspected_count bigint;
  damaged_count bigint; missing_count bigint; skipped_count bigint; discrepancy_count integer;
  eligible_count bigint; prior_notes text; note text;
begin
  if not public.inventory_can_check_laboratory(p_laboratory_id) then
    raise exception 'Only assigned laboratory staff or System Admins can check this laboratory';
  end if;
  select * into source_shelf from public.shelves where id=p_shelf_id and laboratory_id=p_laboratory_id and status='active' for update;
  if not found then raise exception 'Shelf not found in this laboratory. Reload the shelf'; end if;
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
    raise exception 'Review each stock record only once';
  end if;
  perform 1 from public.inventory_units where shelf_id=p_shelf_id and retired_at is null order by id for update;
  -- Zero-stock consumables can also have a physical count that differs.
  select count(*) into eligible_count from public.inventory_units u where shelf_id=p_shelf_id and retired_at is null
    and status in ('available','under_maintenance') and (inventory_kind='consumable' or quantity>0)
    and not exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null);
  if eligible_count<>jsonb_array_length(p_items) then
    raise exception 'Shelf items changed or some items were not reviewed. Reload the shelf and review every item';
  end if;
  for finding in select * from jsonb_to_recordset(p_items) as x(
    unit_id uuid,expected_status text,expected_condition text,expected_quantity numeric,expected_inventory_kind text,
    condition text,count_result text,actual_quantity numeric,notes text
  ) loop
    select * into source_unit from public.inventory_units u where id=finding.unit_id and shelf_id=p_shelf_id
      and retired_at is null and status in ('available','under_maintenance') and (inventory_kind='consumable' or quantity>0)
      and not exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null);
    if not found or source_unit.status::text is distinct from finding.expected_status
      or source_unit.condition::text is distinct from finding.expected_condition
      or source_unit.inventory_kind is distinct from finding.expected_inventory_kind
      or source_unit.quantity is distinct from finding.expected_quantity then
      raise exception 'An item changed, moved, or was borrowed. Reload the shelf before saving';
    end if;
    if length(coalesce(finding.notes,''))>1000 then raise exception 'Keep each observation within 1000 characters'; end if;
    if source_unit.inventory_kind='consumable' then
      if finding.count_result is null or finding.count_result not in ('matches','different') then
        raise exception 'Choose Matches record or Different quantity for every consumable';
      end if;
      if finding.actual_quantity is null or finding.actual_quantity<0 or finding.actual_quantity>2147483647
        or finding.actual_quantity<>trunc(finding.actual_quantity) then
        raise exception 'Enter a whole-number actual quantity of zero or more';
      end if;
      if (finding.count_result='matches') is distinct from (finding.actual_quantity=source_unit.quantity) then
        raise exception 'The consumable finding must agree with the actual and recorded quantities';
      end if;
    elsif finding.condition is null or finding.condition not in ('good','damaged') then
      raise exception 'Choose Good or Damaged for every equipment unit';
    end if;
  end loop;

  select jsonb_agg(jsonb_build_object(
    'unit_id',u.id,'item_name',u.item_name,'inventory_kind',u.inventory_kind,'description',u.description,
    'reference',(case when u.inventory_kind='equipment' then 'Equipment ' else 'Consumable ' end)
      ||lpad((case when u.inventory_kind='equipment' then u.unit_number else coalesce(u.consumable_number,u.unit_number) end)::text,3,'0'),
    'quantity',u.quantity,'expected_quantity',u.quantity,
    'actual_quantity',case when x.unit_id is null then null when u.inventory_kind='consumable' then x.actual_quantity else u.quantity end,
    'quantity_difference',case when u.inventory_kind='consumable' and x.unit_id is not null then x.actual_quantity-u.quantity else null end,
    'count_result',case when u.inventory_kind='consumable' then x.count_result else null end,
    'previous_status',u.status,'previous_condition',u.condition,
    'condition',case when u.inventory_kind='consumable' then u.condition::text else coalesce(x.condition,u.condition::text) end,
    'notes',coalesce(trim(x.notes),''),'skipped',x.unit_id is null
  ) order by u.inventory_kind,u.item_name,u.unit_number),coalesce(sum(u.quantity),0),
    coalesce(sum(case when x.unit_id is null then 0 when u.inventory_kind='consumable' then x.actual_quantity else u.quantity end),0),
    coalesce(sum(u.quantity) filter(where u.inventory_kind='equipment' and x.condition='damaged'),0),
    coalesce(sum(u.quantity) filter(where u.status in ('missing','not_found')),0),
    coalesce(sum(u.quantity) filter(where x.unit_id is null),0),
    count(*) filter(where u.inventory_kind='consumable' and x.count_result='different')
  into results,expected_count,inspected_count,damaged_count,missing_count,skipped_count,discrepancy_count
  from public.inventory_units u left join jsonb_to_recordset(p_items) as x(
    unit_id uuid,condition text,count_result text,actual_quantity numeric,notes text
  ) on x.unit_id=u.id
  where u.shelf_id=p_shelf_id and u.retired_at is null;

  prior_notes:=coalesce(current_setting('inventoscan.movement_notes',true),'');
  -- Only equipment changes stock state. Consumable quantities, conditions,
  -- stock identities, and movement history remain exactly as recorded.
  for finding in select * from jsonb_to_recordset(p_items) as x(unit_id uuid,condition text,notes text) loop
    select * into source_unit from public.inventory_units where id=finding.unit_id;
    if source_unit.inventory_kind='equipment' then
      target_status:=case when finding.condition='damaged' then 'under_maintenance'::public.unit_status else 'available'::public.unit_status end;
      note:=concat_ws(' · ','Inventory check',nullif(trim(finding.notes),''),nullif(trim(p_comments),''));
      perform set_config('inventoscan.movement_notes',note,true);
      update public.inventory_units set condition=finding.condition::public.unit_condition,status=target_status where id=source_unit.id;
    end if;
  end loop;
  perform set_config('inventoscan.movement_notes',prior_notes,true);
  insert into public.inventory_checks(shelf_id,performed_by,performed_by_user_id,result,expected_units,present_units,
    not_found_units,damaged_units,skipped_units,quantity_discrepancies,comments,item_results)
  values(p_shelf_id,coalesce(nullif(checker.full_name,''),checker.email),checker.id,
    case when damaged_count>0 and discrepancy_count>0 then 'issues_found'
      when damaged_count>0 then 'damaged_items_found' when discrepancy_count>0 then 'quantity_differences_found' else 'good' end,
    expected_count,inspected_count,missing_count,damaged_count,skipped_count,discrepancy_count,nullif(trim(p_comments),''),results)
  returning id into check_id;
  return check_id;
end $$;
revoke all on function public.inventory_save_categorized_shelf_check(uuid,uuid,jsonb,text) from public,anon;
grant execute on function public.inventory_save_categorized_shelf_check(uuid,uuid,jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
