-- Admin sample data only.
-- Run admin_table.sql before running this file.

insert into public.admin_accounts (full_name, email, status)
values
  ('Jane Doe', 'jane.doe@stockly.edu', 'active'),
  ('Alex Tan', 'alex.tan@stockly.edu', 'active'),
  ('Rina Garcia', 'rina.garcia@stockly.edu', 'disabled')
on conflict (email) do update
set full_name = excluded.full_name,
    status = excluded.status;

-- Add one new admin later with:
-- insert into public.admin_accounts (full_name, email, status)
-- values ('New Admin', 'new.admin@stockly.edu', 'active');
