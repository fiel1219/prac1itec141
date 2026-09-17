-- Run after schema.sql. Adds one sample administrator account.
insert into public.admin_accounts (full_name, email, status)
values ('Jane Doe', 'jane.doe@stockly.edu', 'active')
on conflict (email) do nothing;

-- To add another admin, change these values and run the command:
-- insert into public.admin_accounts (full_name, email, status)
-- values ('Alex Tan', 'alex.tan@stockly.edu', 'active');
