-- Run LAST, after the inventory feature, QR, unit-action, and return-repair migrations.
-- Delete removes shelf/unit rows. Historical records retain independent snapshots.
-- This also purges previously retired units and empty archived shelves when no loan is open.
begin;
update public.shelves s set next_unit_number=greatest(s.next_unit_number,
  coalesce((select max(u.unit_number)+1 from public.inventory_units u where u.shelf_id=s.id),1));

alter table public.transactions add column if not exists unit_id_snapshot uuid;
alter table public.transactions add column if not exists checkout_shelf_code text;
alter table public.transactions add column if not exists checkout_unit_number integer;
update public.transactions t set unit_id_snapshot=coalesce(t.unit_id_snapshot,t.unit_id),
  checkout_unit_number=coalesce(t.checkout_unit_number,u.unit_number),
  checkout_shelf_code=coalesce(t.checkout_shelf_code,s.code)
  from public.inventory_units u join public.shelves s on s.id=u.shelf_id where t.unit_id=u.id;

alter table public.stock_movements add column if not exists unit_id_snapshot uuid;
alter table public.stock_movements add column if not exists shelf_id_snapshot uuid;
alter table public.stock_movements add column if not exists shelf_code text;
alter table public.stock_movements add column if not exists shelf_name text;
alter table public.stock_movements add column if not exists item_type text;
alter table public.stock_movements add column if not exists unit_number integer;
update public.stock_movements m set unit_id_snapshot=coalesce(m.unit_id_snapshot,m.unit_id),
  shelf_id_snapshot=coalesce(m.shelf_id_snapshot,m.shelf_id),shelf_code=coalesce(m.shelf_code,s.code),
  shelf_name=coalesce(m.shelf_name,s.name),item_type=coalesce(m.item_type,s.item_type)
  from public.shelves s where m.shelf_id=s.id;
update public.stock_movements m set unit_number=coalesce(m.unit_number,u.unit_number)
  from public.inventory_units u where m.unit_id=u.id;

alter table public.inventory_checks add column if not exists shelf_id_snapshot uuid;
alter table public.inventory_checks add column if not exists shelf_code text;
alter table public.inventory_checks add column if not exists shelf_name text;
update public.inventory_checks c set shelf_id_snapshot=coalesce(c.shelf_id_snapshot,c.shelf_id),
  shelf_code=coalesce(c.shelf_code,s.code),shelf_name=coalesce(c.shelf_name,s.name)
  from public.shelves s where c.shelf_id=s.id;

-- Remove live foreign-key references on deletion while retaining the history itself.
alter table public.transactions alter column unit_id drop not null;
alter table public.transactions drop constraint if exists transactions_unit_id_fkey;
alter table public.transactions add constraint transactions_unit_id_fkey foreign key(unit_id)
  references public.inventory_units(id) on delete set null;
alter table public.stock_movements alter column unit_id drop not null;
alter table public.stock_movements alter column shelf_id drop not null;
alter table public.stock_movements drop constraint if exists stock_movements_unit_id_fkey;
alter table public.stock_movements drop constraint if exists stock_movements_shelf_id_fkey;
alter table public.stock_movements add constraint stock_movements_unit_id_fkey foreign key(unit_id)
  references public.inventory_units(id) on delete set null;
alter table public.stock_movements add constraint stock_movements_shelf_id_fkey foreign key(shelf_id)
  references public.shelves(id) on delete set null;
alter table public.inventory_checks alter column shelf_id drop not null;
alter table public.inventory_checks drop constraint if exists inventory_checks_shelf_id_fkey;
alter table public.inventory_checks add constraint inventory_checks_shelf_id_fkey foreign key(shelf_id)
  references public.shelves(id) on delete set null;

create or replace function public.inventory_snapshot_checkout() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.unit_id_snapshot := new.unit_id;
  select s.code,u.unit_number into new.checkout_shelf_code,new.checkout_unit_number
    from public.inventory_units u join public.shelves s on s.id=u.shelf_id where u.id=new.unit_id;
  return new;
end $$;

create or replace function public.inventory_snapshot_movement() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.unit_id_snapshot := coalesce(new.unit_id_snapshot,new.unit_id);
  new.shelf_id_snapshot := coalesce(new.shelf_id_snapshot,new.shelf_id);
  select coalesce(new.shelf_code,s.code),coalesce(new.shelf_name,s.name),coalesce(new.item_type,s.item_type)
    into new.shelf_code,new.shelf_name,new.item_type from public.shelves s where s.id=new.shelf_id;
  if new.unit_number is null then
    select unit_number into new.unit_number from public.inventory_units where id=new.unit_id;
  end if;
  return new;
end $$;
drop trigger if exists inventory_snapshot_movement on public.stock_movements;
create trigger inventory_snapshot_movement before insert on public.stock_movements
  for each row execute function public.inventory_snapshot_movement();

create or replace function public.inventory_snapshot_check() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.shelf_id_snapshot := coalesce(new.shelf_id_snapshot,new.shelf_id);
  select coalesce(new.shelf_code,s.code),coalesce(new.shelf_name,s.name)
    into new.shelf_code,new.shelf_name from public.shelves s where s.id=new.shelf_id;
  return new;
end $$;
drop trigger if exists inventory_snapshot_check on public.inventory_checks;
create trigger inventory_snapshot_check before insert on public.inventory_checks
  for each row execute function public.inventory_snapshot_check();

-- These guards also apply to direct table deletes, not only app RPCs.
create or replace function public.inventory_guard_unit_delete() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if old.status='borrowed' or exists(select 1 from public.transactions where unit_id=old.id and returned_at is null) then
    raise exception 'Return borrowed equipment before deleting it'; end if;
  if old.retired_at is null then
    insert into public.stock_movements(shelf_id,unit_id,unit_number,direction,reason,actor,notes)
      values(old.shelf_id,old.id,old.unit_number,'out','Deleted equipment',public.inventory_actor(),
        coalesce(nullif(current_setting('inventoscan.movement_notes',true),''),'Permanently deleted equipment'));
  end if;
  return old;
end $$;
drop trigger if exists inventory_guard_unit_delete on public.inventory_units;
create trigger inventory_guard_unit_delete before delete on public.inventory_units
  for each row execute function public.inventory_guard_unit_delete();

create or replace function public.inventory_guard_shelf_delete() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if exists(select 1 from public.inventory_units where shelf_id=old.id and retired_at is null) then
    raise exception 'Move or delete all units before deleting this shelf'; end if;
  return old;
end $$;
drop trigger if exists inventory_guard_shelf_delete on public.shelves;
create trigger inventory_guard_shelf_delete before delete on public.shelves
  for each row execute function public.inventory_guard_shelf_delete();

grant delete on public.inventory_units,public.shelves to authenticated;

create or replace function public.inventory_delete_unit(p_unit_id uuid,p_reason text)
returns void language plpgsql security invoker set search_path=public as $$
declare source_id uuid; selected_unit public.inventory_units; source_shelf public.shelves; changed_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to delete equipment'; end if;
  if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Enter a deletion reason within 1000 characters'; end if;
  select shelf_id into source_id from public.inventory_units where id=p_unit_id;
  select * into source_shelf from public.shelves where id=source_id for update;
  if not found then raise exception 'This equipment unit or shelf was already deleted'; end if;
  if source_shelf.inventory_kind<>'equipment' then raise exception 'Use stock-out to issue consumables'; end if;
  select * into selected_unit from public.inventory_units where id=p_unit_id for update;
  if not found then raise exception 'This equipment unit was already deleted'; end if;
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

create or replace function public.inventory_delete_shelf(p_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
declare changed_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in to delete shelves'; end if;
  perform 1 from public.shelves where id=p_id for update;
  if not found then raise exception 'Shelf not found or already deleted'; end if;
  perform 1 from public.inventory_units where shelf_id=p_id order by id for update;
  if exists(select 1 from public.inventory_units where shelf_id=p_id and retired_at is null) then
    raise exception 'Move or delete all units before deleting this shelf'; end if;
  if exists(select 1 from public.inventory_units u where u.shelf_id=p_id and
    (u.status='borrowed' or exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null))) then
    raise exception 'Return borrowed equipment before deleting this shelf'; end if;
  delete from public.inventory_units where shelf_id=p_id;
  delete from public.shelves where id=p_id;
  get diagnostics changed_count = row_count;
  if changed_count<>1 then raise exception 'Could not delete the shelf. Check delete permissions'; end if;
end $$;
revoke execute on function public.inventory_delete_unit(uuid,text),public.inventory_delete_shelf(uuid) from public,anon;
grant execute on function public.inventory_delete_unit(uuid,text),public.inventory_delete_shelf(uuid) to authenticated;

-- Finish previously requested deletions. Never purge a unit with a borrowed flag or open loan.
delete from public.inventory_units u where u.retired_at is not null and u.status<>'borrowed'
  and not exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null);
delete from public.shelves s where s.status='archived'
  and not exists(select 1 from public.inventory_units u where u.shelf_id=s.id);
-- Any legacy archived shelf still holding stock must be visible for staff to resolve it.
update public.shelves set status='active' where status='archived';
alter table public.shelves drop constraint if exists shelves_active_only;
alter table public.shelves add constraint shelves_active_only check(status='active');
alter table public.shelves drop column if exists archived_at;
drop function if exists public.inventory_archive_shelf(uuid);
notify pgrst, 'reload schema';
commit;
