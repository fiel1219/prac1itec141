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
18. `supabase/account_deletion.sql`
19. `supabase/system_admin_laboratory_access.sql`
20. `supabase/inventory_check_quantities.sql`

`schema.sql` is for a fresh database only. For an existing installation, apply missing migrations in the same order. Keep the migration files: later migrations extend earlier functions, and the upgrade tests exercise that sequence. Run account setup before the membership migration so current account permissions are applied last.

Create your first sign-in user in Supabase Auth and add their matching email to `user_accounts` with role `Admin` and status `active`. Active System Admins can access every laboratory without assignments. System Admins assign Laboratory Admins and Operators under **Users**; laboratory members must be assigned before they can access inventory. For existing databases, run `account_deletion.sql` and then `system_admin_laboratory_access.sql` after `security_hardening.sql` to enable the latest account management and laboratory permissions. The access upgrade changes permission functions without adding memberships or changing inventory/history.

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

- **Account deletion:** System Admins can delete another account from Users after typing its email to confirm. The database checks the caller, protects the last active System Admin, blocks self-deletion, and uses the same lock as role changes and approvals. One transaction deletes the Auth login, its linked Auth records through Supabase's cascades, the application profile, laboratory memberships, and the matching registration request. Inventory, loans, and audit history remain. Missing Auth logins do not prevent removing an orphan application profile. Dependent-record failures roll everything back. Existing tokens lose inventory access because database policies require an active application profile; the deleted Auth account cannot sign in or refresh its session. Apply the migration as the database owner and resolve any externally owned records/files before retrying a blocked deletion. [Supabase user deletion behavior](https://supabase.com/docs/guides/auth/managing-user-data).
- **Laboratory selection:** active System Admins can select and manage inventory in every laboratory without assignments, including newly created laboratories. Laboratory Admins and Operators can select only their assigned laboratories. Inaccessible saved selections fall back to an accessible laboratory; unassigned laboratory members see a disabled selector and no inventory. Accounts and assignments refresh every 30 seconds and when the tab becomes visible. Disabled accounts have no inventory access, including disabled System Admins.
- **Shelves and items:** choose a shelf to receive named equipment or consumables. Equipment is individually tracked; consumables use quantity records. Shelves can contain both categories. Search and edit items under Equipment and Consumables.
- **QR and borrowing:** each equipment unit has a permanent QR identity. Each consumable item has a QR identifying its shelf and consumable reference, shared across its stock conditions and quantities. View/download it from Items or the shelf popup. Scanning that label opens the consumable directly; enter quantity and reason/recipient without choosing an item. Generate a new label after moving the consumable to another shelf. Existing shelf QR labels still work and offer an item picker. Scan equipment to choose/add a borrower, set a return date, and check out. Returns record condition; damaged equipment goes under maintenance. Manual QR entry is available when camera scanning is unsupported. Consumable item labels use the existing stock fields and need no new database migration.
- **Move and delete:** shelf popups support individual and bulk actions. Borrowed equipment must be returned first. Consumables move as full quantities and merge matching stock states. Deletion requires a reason. Delete shelves only after emptying them. History snapshots survive deletion.
- **Inventory Checks:** active System Admins can read/save checks in every laboratory; Laboratory Admins and Operators can do so only in their assigned laboratories. A shelf check separates **Equipment** and **Consumables**. Equipment uses Good/Damaged and updates availability/maintenance status. Consumables use Good (matches record)/Different quantity; a difference requires an actual whole-number count, including zero. Counts, recorded quantities, shortages/excesses, observations, and reviewer details are saved for review. Consumable quantity, condition, status, and stock identity are preserved; no stock movements are created for count differences. Zero-stock consumables can be checked; borrowed and missing records are skipped. Saves are atomic, reject stale inventory, and require a finding for every inspectable record. History shows quantity differences alongside equipment findings and keeps older condition-based check history readable. Apply `inventory_check_quantities.sql` after the access upgrade to enable this workflow on an existing database.
- **Reports:** current inventory summary, search, low-stock filtering, and CSV export. Inventory actions continue recording stock movements in the database.

Database policies enforce laboratory access for shelves, items, transactions, stock movements and checks. Active System Admins have access across all laboratories; other users need a matching laboratory membership. Anonymous requests cannot read inventory or account lists. Borrowers remain a shared catalog for active accounts. Account approvals use one database transaction, so a failed review cannot leave an active account behind. Existing installations must apply `system_admin_laboratory_access.sql` after the security migration; local edits do not install permissions on the live database.

Inventory data and setup queries load in parallel. Successful schema checks share in-flight requests and are cached for five minutes; missing setup and failures are rechecked. Automatic inventory polling pauses in hidden tabs and skips overlapping requests. Borrowers, users and approval lists paginate beyond the API row limit. QR generation loads its library on demand, and date inputs use local calendar dates.

### Demo accounts

| System role | Email | Password |
| --- | --- | --- |
| Operator | demo.operator@inventoscan.test | InventoOperator2026! |
| System Admin | demo.admin@inventoscan.test | InventoAdmin2026! |

Run the entire `supabase/demo_accounts.sql` script in Supabase SQL Editor after account setup, then select **Open system admin demo** on the sign-in page. It creates a confirmed Auth login and an active System Admin profile, or refreshes the existing demo account with the same credentials. System Admins can manage users, laboratories, and inventory without a laboratory assignment. Assign a laboratory to the Operator demo before using its inventory. These are public demo credentials; use a demo database. The seed refuses to replace an unrelated Auth account with the same email.

## Verification

```sh
npm test
npm run lint
npm run build
```

Tests cover migrations, QR resolution, checkout/return, quantity accounting, transfers, deletion, laboratory assignments, inventory checks, and safe legacy cleanup.
