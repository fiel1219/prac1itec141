-- Run after the inventory feature/QR/unit-action migrations. Safe to rerun.
-- Existing loans and unit statuses stay unchanged until staff record/confirm a return.
begin;
create or replace function public.inventory_return(p_transaction_id uuid,p_condition text)
returns void language plpgsql security invoker set search_path=public as $$
declare selected_transaction public.transactions; selected_unit public.inventory_units;
  selected_unit_id uuid; changed_count integer; next_status public.unit_status;
begin
  if auth.uid() is null then raise exception 'Sign in to return an item'; end if;
  if p_condition is null or p_condition not in ('good','damaged') then raise exception 'Choose good or damaged condition'; end if;
  select unit_id into selected_unit_id from public.transactions where id=p_transaction_id;
  if not found then raise exception 'Transaction not found or already returned'; end if;
  perform 1 from public.shelves where id=(select shelf_id from public.inventory_units where id=selected_unit_id) for update;
  select * into selected_unit from public.inventory_units where id=selected_unit_id for update;
  if not found or selected_unit.retired_at is not null then raise exception 'Equipment unit not found or removed'; end if;
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
returns void language plpgsql security invoker set search_path=public as $$
declare selected_unit public.inventory_units; changed_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to confirm equipment returns'; end if;
  if p_condition is null or p_condition not in ('good','damaged') then raise exception 'Choose good or damaged condition'; end if;
  if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Enter a return confirmation reason within 1000 characters'; end if;
  perform 1 from public.shelves where id=(select shelf_id from public.inventory_units where id=p_unit_id) for update;
  select * into selected_unit from public.inventory_units where id=p_unit_id for update;
  if not found or selected_unit.retired_at is not null then raise exception 'Equipment unit not found or removed'; end if;
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
revoke execute on function public.inventory_return(uuid,text),public.inventory_reconcile_return(uuid,text,text) from public,anon;
grant execute on function public.inventory_return(uuid,text),public.inventory_reconcile_return(uuid,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
