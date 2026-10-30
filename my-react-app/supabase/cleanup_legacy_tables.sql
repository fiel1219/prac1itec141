-- Optional cleanup for existing databases. Run in Supabase SQL Editor after
-- current account and inventory migrations. No application tables are removed.
-- Populated tables and tables with dependent objects are kept and reported.
begin;
do $$ declare legacy_name text; has_records boolean; begin
  foreach legacy_name in array array['admin_accounts','operator_accounts','activity_logs'] loop
    if to_regclass(format('public.%I',legacy_name)) is null then continue; end if;
    execute format('lock table public.%I in access exclusive mode',legacy_name);
    execute format('select exists(select 1 from public.%I)',legacy_name) into has_records;
    if has_records then
      raise notice 'Kept public.%: it contains records. Review and migrate or export them before dropping this table.',legacy_name;
      continue;
    end if;
    begin
      execute format('drop table public.%I',legacy_name);
      raise notice 'Removed unused empty table public.%',legacy_name;
    exception when dependent_objects_still_exist then
      raise notice 'Kept public.%: another database object depends on it.',legacy_name;
    end;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
