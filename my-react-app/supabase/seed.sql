-- Stockly sample data
-- Run supabase/schema.sql first, then run this file in Supabase SQL Editor.

-- Shelves
insert into public.shelves (code, name, item_type, qr_value)
values
  ('A-01', 'Keyboard Station', 'Keyboards', 'stockly:shelf:A-01'),
  ('A-02', 'Mouse Station', 'Mice', 'stockly:shelf:A-02'),
  ('B-01', 'Monitor Bay', 'Monitors', 'stockly:shelf:B-01'),
  ('B-02', 'Cable Storage', 'HDMI Cables', 'stockly:shelf:B-02'),
  ('C-01', 'Headset Rack', 'Headsets', 'stockly:shelf:C-01')
on conflict (code) do nothing;

-- Generate numbered units for each shelf.
insert into public.inventory_units (shelf_id, unit_number, status, condition, comment)
select s.id, numbers.unit_number,
  case
    when s.code = 'A-01' and numbers.unit_number in (3, 4) then 'borrowed'::public.unit_status
    when s.code = 'A-02' and numbers.unit_number in (11, 12, 13) then 'borrowed'::public.unit_status
    when s.code = 'B-01' and numbers.unit_number = 2 then 'borrowed'::public.unit_status
    when s.code = 'B-01' and numbers.unit_number = 8 then 'under_maintenance'::public.unit_status
    when s.code = 'C-01' and numbers.unit_number in (5, 6) then 'borrowed'::public.unit_status
    else 'available'::public.unit_status
  end,
  case when s.code = 'B-01' and numbers.unit_number = 8
    then 'damaged'::public.unit_condition else 'good'::public.unit_condition end,
  case when s.code = 'B-01' and numbers.unit_number = 8
    then 'Display has a cracked panel' else null end
from public.shelves s
join lateral generate_series(1,
  case s.code
    when 'A-01' then 10
    when 'A-02' then 15
    when 'B-01' then 8
    when 'B-02' then 20
    when 'C-01' then 12
  end) as numbers(unit_number) on true
on conflict (shelf_id, unit_number) do nothing;

-- Borrowers
insert into public.borrowers (name, identity_number)
values
  ('Juan Dela Cruz', '2024-00124'),
  ('Maria Santos', '2023-00811'),
  ('John Cruz', '2024-00452'),
  ('Ana Reyes', '2024-00677')
on conflict (identity_number) do nothing;

-- Borrowing history for currently borrowed units.
insert into public.transactions
  (reference, borrower_id, unit_id, borrowed_at, expected_return_at)
select x.reference, b.id, u.id, x.borrowed_at, x.expected_return_at
from (values
  ('TRX-1042', '2024-00124', 'A-01', 3, '2026-09-17 10:24:00+08'::timestamptz, '2026-09-24'::date),
  ('TRX-1040', '2024-00452', 'A-02', 11, '2026-09-16 15:42:00+08'::timestamptz, '2026-09-23'::date),
  ('TRX-1038', 'Ana Reyes', 'C-01', 5, '2026-09-15 09:30:00+08'::timestamptz, '2026-09-16'::date)
) as x(reference, borrower_key, shelf_code, unit_number, borrowed_at, expected_return_at)
join public.shelves s on s.code = x.shelf_code
join public.inventory_units u on u.shelf_id = s.id and u.unit_number = x.unit_number
join public.borrowers b on b.identity_number = x.borrower_key or b.name = x.borrower_key
on conflict (reference) do nothing;

-- Completed return history.
insert into public.transactions
  (reference, borrower_id, unit_id, borrowed_at, expected_return_at, returned_at, return_status, return_condition, comment)
select 'TRX-1041', b.id, u.id, '2026-09-16 08:00:00+08', '2026-09-17', '2026-09-17 09:15:00+08', 'available', 'good', 'Returned after class'
from public.borrowers b, public.shelves s, public.inventory_units u
where b.identity_number = '2023-00811' and s.code = 'B-01' and u.shelf_id = s.id and u.unit_number = 2
on conflict (reference) do nothing;

-- Inventory check records.
insert into public.inventory_checks
  (shelf_id, performed_by, result, expected_units, present_units, not_found_units, damaged_units, comments)
select id, 'Jane Doe', 'complete', 10, 10, 0, 0, 'All keyboards verified.' from public.shelves where code = 'A-01'
union all
select id, 'Mark Lee', 'review_needed', 8, 7, 0, 1, 'Monitor #008 sent for maintenance.' from public.shelves where code = 'B-01';

-- Important activity history.
insert into public.activity_logs (actor, action, entity_type, details)
values
  ('Jane Doe', 'Created sample shelves', 'shelf', '{"count": 5}'::jsonb),
  ('Jane Doe', 'Borrowed Keyboard #003', 'transaction', '{"reference":"TRX-1042","shelf":"A-01"}'::jsonb),
  ('Mark Lee', 'Returned Monitor #002', 'transaction', '{"reference":"TRX-1041","shelf":"B-01"}'::jsonb),
  ('Jane Doe', 'Marked Monitor #008 under maintenance', 'inventory_unit', '{"shelf":"B-01"}'::jsonb);
