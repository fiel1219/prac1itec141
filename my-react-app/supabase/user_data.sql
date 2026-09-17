-- Sample combined user data.
-- Run user_table.sql first.
insert into public.user_accounts (full_name, email, role, status)
values
  ('System Admin', 'admin@stockly.test', 'Admin', 'active'),
  ('Mark Lee', 'mark.lee@stockly.edu', 'Operator', 'active'),
  ('Lina Reyes', 'lina.reyes@stockly.edu', 'Operator', 'active')
on conflict (email) do update
set full_name = excluded.full_name,
    role = excluded.role,
    status = excluded.status;
