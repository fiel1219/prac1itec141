# VSU InventoScan

Laboratory inventory built with React, Vite, and Supabase.

## Local setup

Create `.env.local` with your project's public connection settings:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

```sh
npm ci
npm run dev
```

## Database setup

For a fresh database, run these scripts in Supabase SQL Editor in this order:

1. `supabase/schema.sql`
2. `supabase/user_accounts.sql`
3. `supabase/inventoscan_features.sql`
4. `supabase/inventory_qr.sql`
5. `supabase/inventory_unit_actions.sql`
6. `supabase/inventory_return_repair.sql`
7. `supabase/inventory_permanent_delete.sql`
8. `supabase/inventory_shelf_items.sql`
9. `supabase/inventory_item_descriptions.sql`
10. `supabase/inventory_item_categories.sql`
11. `supabase/inventory_consumable_quantities.sql`
12. `supabase/inventory_consumable_actions.sql`
13. `supabase/inventory_bulk_actions.sql`
14. `supabase/inventory_laboratories.sql`
15. `supabase/user_laboratories.sql`
16. `supabase/inventory_checks.sql`
17. `supabase/security_hardening.sql`

`schema.sql` is for a fresh database only. For an existing installation, apply missing migrations in the same order. Keep the migration files: later migrations extend earlier functions, and the upgrade tests exercise that sequence. Run account setup before the membership migration so current account permissions are applied last.

Create your first sign-in user in Supabase Auth and add their matching email to `user_accounts` with role `Admin` and status `active`. System Admins assign laboratory roles under **Users**. Existing accounts are not automatically assigned to laboratories.

Optional sample inventory: run `supabase/seed.sql` immediately after `schema.sql`, before the feature migrations. Optional demo logins: run `supabase/demo_accounts.sql` after account setup.

### Existing database cleanup

`supabase/cleanup_legacy_tables.sql` removes empty legacy `admin_accounts`, `operator_accounts`, and `activity_logs` tables. It keeps populated tables or tables with dependent objects and reports why they were retained. Review and migrate/export those records before removing them. It does not remove current accounts, inventory, loans, checks, or movement history.

Local file edits do not apply SQL to your live database.

## Current tables

| Tables | Purpose |
| --- | --- |
| `user_accounts`, `account_approvals` | User profiles, system roles, registration requests |
| `laboratories`, `laboratory_memberships` | Laboratories and per-user roles |
| `shelves`, `inventory_units` | Storage locations, equipment, consumable quantities |
| `borrowers`, `transactions` | Borrowers, checkout and return records |
| `stock_movements`, `inventory_checks` | Stock audit history and shelf inspections |

## Features and permissions

- **Laboratory selection:** active users can select only assigned laboratories. Inaccessible saved selections fall back to an assigned laboratory; unassigned accounts see a disabled selector and no laboratory inventory. Assignments refresh every 30 seconds and when the tab becomes visible. System Admins retain Users and laboratory management; inventory selection still requires a laboratory assignment.
- **Shelves and items:** choose a shelf to receive named equipment or consumables. Equipment is individually tracked; consumables use quantity records. Shelves can contain both categories. Search and edit items under Equipment and Consumables.
- **QR and borrowing:** each equipment unit has a permanent QR identity. Each consumable item has a QR identifying its shelf and consumable reference, shared across its stock conditions and quantities. View/download it from Items or the shelf popup. Scanning that label opens the consumable directly; enter quantity and reason/recipient without choosing an item. Generate a new label after moving the consumable to another shelf. Existing shelf QR labels still work and offer an item picker. Scan equipment to choose/add a borrower, set a return date, and check out. Returns record condition; damaged equipment goes under maintenance. Manual QR entry is available when camera scanning is unsupported. Consumable item labels use the existing stock fields and need no new database migration.
- **Move and delete:** shelf popups support individual and bulk actions. Borrowed equipment must be returned first. Consumables move as full quantities and merge matching stock states. Deletion requires a reason. Delete shelves only after emptying them. History snapshots survive deletion.
- **Inventory Checks:** only active, assigned Laboratory Admins and Laboratory Operators can read/save checks. Choose a shelf and explicitly mark each inspectable record Good or Damaged, with optional observations. Borrowed, missing, and zero-stock records are skipped. Good items become available; damaged items go under maintenance. Consumable findings apply to the displayed stock quantity. Saves are atomic and reject changed inventory; the latest ten checks expand to show findings and reviewer details.
- **Reports:** current inventory summary, search, low-stock filtering, and CSV export. Inventory actions continue recording stock movements in the database.

After `security_hardening.sql`, laboratory memberships are enforced in the database for shelves, items, transactions, stock movements and checks. Anonymous requests cannot read inventory or account lists. System Admins can administer laboratories and accounts, while inventory access still requires a laboratory membership. Borrowers remain a shared catalog for active accounts. Account approvals use one database transaction, so a failed review cannot leave an active account behind. Apply this migration last on existing installations; local edits do not install these protections on the live database.

Inventory data and setup queries load in parallel. Successful schema checks share in-flight requests and are cached for five minutes; missing setup and failures are rechecked. Automatic inventory polling pauses in hidden tabs and skips overlapping requests. Borrowers, users and approval lists paginate beyond the API row limit. QR generation loads its library on demand, and date inputs use local calendar dates.

### Demo accounts

| System role | Email | Password |
| --- | --- | --- |
| Operator | demo.operator@inventoscan.test | InventoOperator2026! |
| System Admin | demo.admin@inventoscan.test | InventoAdmin2026! |

Run the entire `supabase/demo_accounts.sql` script in Supabase SQL Editor after account setup, then select **Open system admin demo** on the sign-in page. It creates a confirmed Auth login and an active System Admin profile, or refreshes the existing demo account with the same credentials. System Admins can manage users and laboratories without a laboratory assignment. Assign a laboratory to the Operator demo before using its inventory. These are public demo credentials; use a demo database. The seed refuses to replace an unrelated Auth account with the same email.

## Verification

```sh
npm test
npm run lint
npm run build
```

Tests cover migrations, QR resolution, checkout/return, quantity accounting, transfers, deletion, laboratory assignments, inventory checks, and safe legacy cleanup.
