-- Run after inventory_bulk_actions.sql. Safe to rerun.
-- Laboratory deletion is permanent and requires removing its shelves first.
begin;
create table if not exists public.laboratories (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(trim(name)) between 1 and 120),
  description text not null default '' check(length(description)<=1000),
  created_at timestamptz not null default now()
);
create unique index if not exists laboratories_name_key on public.laboratories(lower(trim(name)));
alter table public.laboratories enable row level security;
grant select,insert,update,delete on public.laboratories to authenticated;
revoke all on public.laboratories from anon;
drop policy if exists "inventory manage laboratories" on public.laboratories;
create policy "inventory manage laboratories" on public.laboratories for all to authenticated
  using(auth.uid() is not null) with check(auth.uid() is not null);

-- Seed only on the first installation, so rerunning never resurrects deleted labs.
do $$ begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='shelves' and column_name='laboratory_id') then
    insert into public.laboratories(name) values('Science Laboratory') on conflict do nothing;
    alter table public.shelves add column laboratory_id uuid;
    update public.shelves set laboratory_id=(select id from public.laboratories where lower(trim(name))='science laboratory');
  end if;
end $$;
alter table public.shelves alter column laboratory_id set not null;
alter table public.shelves drop constraint if exists shelves_laboratory_fkey;
alter table public.shelves add constraint shelves_laboratory_fkey foreign key(laboratory_id) references public.laboratories(id) on delete restrict;
alter table public.shelves drop constraint if exists shelves_code_key;
create unique index if not exists shelves_laboratory_code_key on public.shelves(laboratory_id,code);
create index if not exists shelves_laboratory_id_idx on public.shelves(laboratory_id);

-- Older single-laboratory clients remain usable. With multiple labs they must
-- explicitly choose a laboratory instead of silently saving into the wrong one.
create or replace function public.inventory_default_laboratory() returns uuid
language plpgsql stable security invoker set search_path=public as $$
declare total integer; selected_id uuid;
begin
  select count(*),(array_agg(id))[1] into total,selected_id from public.laboratories;
  if total<>1 then raise exception 'Choose a laboratory before adding a shelf'; end if;
  return selected_id;
end $$;
alter table public.shelves alter column laboratory_id set default public.inventory_default_laboratory();

create or replace function public.inventory_guard_shelf_laboratory() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if TG_OP='UPDATE' and new.laboratory_id is distinct from old.laboratory_id then
    raise exception 'A shelf cannot be reassigned to another laboratory'; end if;
  perform 1 from public.laboratories where id=new.laboratory_id for update;
  if not found then raise exception 'Laboratory not found. Refresh and choose another laboratory'; end if;
  return new;
end $$;
drop trigger if exists inventory_guard_shelf_laboratory on public.shelves;
create trigger inventory_guard_shelf_laboratory before insert or update of laboratory_id on public.shelves
  for each row execute function public.inventory_guard_shelf_laboratory();

create or replace function public.inventory_save_laboratory(p_id uuid,p_name text,p_description text default '')
returns uuid language plpgsql security invoker set search_path=public as $$
declare saved_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to manage laboratories'; end if;
  if nullif(trim(p_name),'') is null or length(trim(p_name))>120 then raise exception 'Enter a laboratory name from 1 to 120 characters'; end if;
  if length(coalesce(p_description,''))>1000 then raise exception 'Keep the description within 1000 characters'; end if;
  if p_id is null then
    insert into public.laboratories(name,description) values(trim(p_name),trim(coalesce(p_description,''))) returning id into saved_id;
  else
    update public.laboratories set name=trim(p_name),description=trim(coalesce(p_description,'')) where id=p_id returning id into saved_id;
    if saved_id is null then raise exception 'Laboratory not found or update permission denied'; end if;
  end if;
  return saved_id;
exception when unique_violation then raise exception 'A laboratory with this name already exists';
end $$;

create or replace function public.inventory_guard_laboratory_delete() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if exists(select 1 from public.shelves where laboratory_id=old.id) then
    raise exception 'Delete this laboratory''s shelves before deleting the laboratory'; end if;
  return old;
end $$;
drop trigger if exists inventory_guard_laboratory_delete on public.laboratories;
create trigger inventory_guard_laboratory_delete before delete on public.laboratories
  for each row execute function public.inventory_guard_laboratory_delete();

create or replace function public.inventory_delete_laboratory(p_id uuid) returns void
language plpgsql security invoker set search_path=public as $$
declare changed integer;
begin
  if auth.uid() is null then raise exception 'Sign in to delete laboratories'; end if;
  perform 1 from public.laboratories where id=p_id for update;
  if not found then raise exception 'Laboratory not found or already deleted'; end if;
  delete from public.laboratories where id=p_id;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Could not delete the laboratory. Check delete permissions'; end if;
end $$;

create or replace function public.inventory_save_laboratory_shelf(
  p_laboratory_id uuid,p_id uuid,p_code text,p_name text,p_description text default ''
) returns uuid language plpgsql security invoker set search_path=public as $$
declare saved_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to manage shelves'; end if;
  if nullif(trim(p_code),'') is null or nullif(trim(p_name),'') is null or length(trim(p_code))>120 or length(trim(p_name))>120 then
    raise exception 'Enter a shelf code and name from 1 to 120 characters'; end if;
  if length(coalesce(p_description,''))>1000 then raise exception 'Keep the description within 1000 characters'; end if;
  perform 1 from public.laboratories where id=p_laboratory_id for update;
  if not found then raise exception 'Laboratory not found. Refresh and choose another laboratory'; end if;
  if p_id is null then
    insert into public.shelves(laboratory_id,code,name,item_type,inventory_kind,qr_value,description)
      values(p_laboratory_id,trim(p_code),trim(p_name),'Mixed items','equipment','VSU-'||gen_random_uuid()::text,trim(coalesce(p_description,''))) returning id into saved_id;
  else
    update public.shelves set code=trim(p_code),name=trim(p_name),description=trim(coalesce(p_description,''))
      where id=p_id and laboratory_id=p_laboratory_id and status='active' returning id into saved_id;
    if saved_id is null then raise exception 'Shelf not found in this laboratory or update permission denied'; end if;
  end if;
  return saved_id;
exception when unique_violation then raise exception 'This shelf code is already used in the laboratory';
end $$;

-- History retains its original laboratory identity even after shelves/labs are
-- deleted. Before laboratories existed, all history belonged to Science Laboratory.
do $$ declare history_table text; begin
  foreach history_table in array array['transactions','stock_movements','inventory_checks'] loop
    if not exists(select 1 from information_schema.columns where table_schema='public' and table_name=history_table and column_name='laboratory_id') then
      execute format('alter table public.%I add column laboratory_id uuid, add column laboratory_name text',history_table);
      execute format('update public.%I set laboratory_id=(select id from public.laboratories where lower(trim(name))=''science laboratory''), laboratory_name=''Science Laboratory''',history_table);
    end if;
    execute format('create index if not exists %I on public.%I(laboratory_id)',history_table||'_laboratory_id_idx',history_table);
  end loop;
end $$;

create or replace function public.inventory_snapshot_laboratory() returns trigger
language plpgsql security invoker set search_path=public as $$
declare source_shelf uuid; lab_id uuid; lab_name text;
begin
  if TG_TABLE_NAME='transactions' then
    select shelf_id into source_shelf from public.inventory_units where id=new.unit_id;
  else source_shelf:=new.shelf_id;
  end if;
  select l.id,l.name into lab_id,lab_name from public.shelves s join public.laboratories l on l.id=s.laboratory_id where s.id=source_shelf;
  if lab_id is not null then new.laboratory_id:=lab_id;new.laboratory_name:=lab_name; end if;
  return new;
end $$;
drop trigger if exists inventory_snapshot_laboratory on public.transactions;
create trigger inventory_snapshot_laboratory before insert on public.transactions for each row execute function public.inventory_snapshot_laboratory();
drop trigger if exists inventory_snapshot_laboratory on public.stock_movements;
create trigger inventory_snapshot_laboratory before insert on public.stock_movements for each row execute function public.inventory_snapshot_laboratory();
drop trigger if exists inventory_snapshot_laboratory on public.inventory_checks;
create trigger inventory_snapshot_laboratory before insert on public.inventory_checks for each row execute function public.inventory_snapshot_laboratory();

revoke execute on function public.inventory_default_laboratory(),public.inventory_save_laboratory(uuid,text,text),
  public.inventory_delete_laboratory(uuid),public.inventory_save_laboratory_shelf(uuid,uuid,text,text,text) from public,anon;
grant execute on function public.inventory_default_laboratory(),public.inventory_save_laboratory(uuid,text,text),
  public.inventory_delete_laboratory(uuid),public.inventory_save_laboratory_shelf(uuid,uuid,text,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
