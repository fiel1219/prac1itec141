# VSU InventoScan

QR-based laboratory inventory built with React, Vite, and Supabase.

## Enable the new features on your existing database

Open your project's Supabase SQL Editor and run **supabase/inventoscan_features.sql**, then **supabase/inventory_qr.sql**, then **supabase/inventory_unit_actions.sql**. These migrations enable inventory transactions, the equipment/consumable QR setup, and per-unit Move/Delete actions. They are safe to rerun and preserve existing shelves, unit IDs, shelf QR values, and borrowing history. These files have not been applied to your live database by this code change. If the first two migrations are already installed, only the third is needed for the new unit actions.

For the return-status correction flow, also run **supabase/inventory_return_repair.sql** after those migrations. It updates the return function and adds a way to confirm a physical return when a unit has a stale borrowed status and no active loan. Installing it does not automatically release any borrowed equipment or rewrite historical loans.

Run **supabase/inventory_permanent_delete.sql** after the return migration to replace the old archive behavior with permanent deletion. It removes the archive RPC and its timestamp column, prevents new archived statuses, permanently removes previously retired units without outstanding loans, and deletes previously archived empty shelves. A legacy archived shelf that still contains stock becomes visible again so staff can resolve its units. Historical loans, movements, and inventory checks retain independent snapshots, with nullable references to deleted entities. This script does not delete borrowers or user accounts. Like the other migrations, it has not been run against your live database by these local code edits.

Run **supabase/inventory_shelf_items.sql** after permanent deletion setup to allow different named items on one shelf. It copies each existing shelf's item type onto its existing units, preserves equipment IDs and QR codes, and stores item names in borrowing and movement history. Shelf forms ask only for code, name, and optional shelf description after the later category migration. Enter an item name and quantity under **Add items** in the shelf popup, or use **Stock Movements**. Consumable shelf scans and stock-out require choosing the specific item to issue. The app detects missing setup and disables named stock operations until this migration is applied; shelf creation, inventory viewing, and equipment returns remain available. This migration has not been applied to the live database by these local code changes.

Run **supabase/inventory_item_descriptions.sql** after the named-item migration to save optional descriptions from **Add items**. Each unit in the receipt gets its own copy of the description, which stays with it after a shelf move. Descriptions are available in the equipment popup, equipment QR details, and the unit management table for both equipment and consumables. Existing comments and receipt notes remain separate. This migration has not been applied to the live database by these local code changes.

For a fresh database, first run schema.sql, configure your existing user_accounts/account_approvals tables and approved sign-in account, then run borrowing_permissions.sql, inventoscan_features.sql, inventory_qr.sql, and inventory_unit_actions.sql in that order. Do not run both alternate user-table scripts; retain the account setup you already use. Seed scripts are optional demo data.

Run **supabase/inventory_item_categories.sql LAST** to move Equipment/Consumables onto each item and enable shelf descriptions. The migration copies legacy shelf categories onto their existing units without changing IDs, QR payloads, quantities, descriptions, or active loans. New shelves use a single-column code/name/optional-description form. Choose the category when adding items; both categories may share one shelf, including items with the same name. Equipment keeps a QR per unit; the shelf QR exposes only consumables. Category-aware stock operations, reports, transfers, and loan validation keep the two categories separate. Older stock APIs reject ambiguous item names. Existing shelf category/type columns remain for compatibility with older clients and no longer restrict the current shelf contents. This migration has not been applied to the live database by local edits.

Configure .env.local (never commit it):

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

```sh
npm ci
npm run dev
```

## Features

### Demo login accounts

Run the entire `supabase/demo_accounts.sql` script in Supabase SQL Editor after the existing `user_accounts` table is set up. It creates confirmed email/password Auth users, email identities, and active application accounts. Refresh the login page and click Operator or Admin under "Try a demo account" to sign in directly.

| Role | Email | Password |
| --- | --- | --- |
| Operator | demo.operator@inventoscan.test | InventoOperator2026! |
| Admin | demo.admin@inventoscan.test | InventoAdmin2026! |

These credentials are deliberately public and provide real role access; use demo inventory data. The SQL is safe to rerun and resets only accounts marked as demo users. It refuses to overwrite a non-demo Auth user with the same email.

- **Items:** add and edit shelves, receive different named items into each shelf and choose Equipment or Consumables for each item, edit unit status/condition/comments, and generate QR labels. Equipment uses a separate QR for every unit; consumables use one QR per shelf. Delete shelf permanently removes an empty shelf's database row. Historical records use snapshots so reports still work after deletion.
- **Stock Movements:** receive 1–1000 new numbered units per operation, or remove available units with a required reason. Unit numbers are never reused. Borrowed, damaged, and maintenance units cannot be removed as available stock; return or resolve their condition first.
- **Scan QR / Returns:** scan an equipment unit to open only its record for checkout or return. Scan a consumable shelf to view its quantity and issue a whole-number amount with a reason/recipient. Manual QR entry remains available. Atomic database functions validate transactions; consumables cannot be borrowed. Damaged equipment returns go to maintenance.
- **Dashboard:** total shelves, total units, available, borrowed, and attention counts. Counts refresh after local changes, every 30 seconds, and when returning to the tab.
- **Reports:** current inventory summary, low-stock filtering, and CSV export. Movement reports include receipt, removal, checkout, return, and condition/status adjustments with date, shelf, direction, operator, and notes filters. Movement recording begins when the migration is installed; existing history is not fabricated or backfilled. Date filters use your browser's local timezone. Summary reports are current snapshots, while movement reports describe activity over time.

### QR label setup

Choose **Equipment** or **Consumables** in **Add items**. Shelves describe storage locations and can hold both categories. Existing records inherit their former shelf category when `inventory_item_categories.sql` is first run; moving an item or editing a shelf does not change its category.

- **Equipment:** open **Items > Units > Unit QR**, or open a shelf and choose **View QR** beside its equipment unit, to download a label for each unit. The payload is `VSU-EQUIPMENT:<unit UUID>`. It uses the unit's permanent database ID, so matching unit numbers on different shelves produce different labels. Editing shelf details or moving the same unit does not change its QR identity. Retired units cannot be scanned for new transactions.
- **Consumables:** open the shelf and choose **View consumable shelf QR** to download the shelf label. Existing shelf QR values remain unchanged when shelf details are edited. Scanning shows the supply type and available quantity. Issue supplies through the scan result or Stock Movements.

Shelf labels open only consumables on that shelf; equipment borrowing uses the individual equipment QR. The scanner asks staff to use the QR on the individual equipment unit instead. Camera scanning requires a browser supporting BarcodeDetector, camera permission, and HTTPS or localhost; manual entry remains available.

### Manage equipment inside the shelf popup

Open a shelf's item popup from Shelves or Items. Every unit has **View QR**, **Move**, and **Delete** buttons. Borrowed units must be returned before moving or deleting them.

Borrowed units also have a **Return** button. It checks for open loan records before displaying a form. With an active loan, it records the normal return. With no active loan, staff must confirm that the equipment is physically back, choose its condition, and enter a reason. The database refuses status correction while a loan is still open. Confirmed corrections log the operator and reason in movement history without inventing a borrower or loan.

- **Add items:** enter an item name, choose Equipment or Consumables, enter a quantity (1–1000), and an optional description (up to 1000 characters), then confirm or cancel. Shelf actions and QR labels are hidden while this form is open. Receive more of an existing item or add a different item to the same shelf. Each equipment unit gets its own permanent QR identity; consumables share the shelf QR and are listed separately by item name.
- **Move:** choose another active shelf. Notes are optional. The item name, permanent UUID, QR code, condition, and loan history stay with the unit. Its shelf display number can change to avoid collisions. Source and destination movements record the transfer, and subsequent receipts do not reuse numbers vacated by transfers.
- **Delete:** enter a reason and confirm. This permanently deletes the selected equipment row from `inventory_units`. Damaged or maintenance units can also be deleted once no loan is open. Existing loan and movement records remain as history snapshots, with no live equipment row behind them.
- **Delete shelf:** becomes available immediately when the popup has no remaining active units. Confirming permanently removes the row from `shelves` and cleans up any previously removed stock still attached to it. The same permanent action is available under Items. A deleted shelf code can be reused for a new shelf.

Successful actions update the open popup and inventory counts. Database validation also rejects stale actions, such as a unit another user has already borrowed or removed. Missing permanent-delete setup disables Delete while other inventory operations remain available. Installing this setup is required so the app never presents soft deletion as permanent deletion.

The old sample data incorrectly marked some units as borrowed without creating loans, and marked one completed return as still borrowed. Fresh `seed.sql` data fixes those flags. For previously loaded sample data, use the popup's Return confirmation after checking physical presence. Do not clear borrowed statuses in bulk. Returns loads active loans directly and paginates its queries so older open loans remain visible even when history exceeds the API row limit.

## Verification

```sh
npm test
npm run lint
npm run build
```

Tests use an isolated in-memory PostgreSQL runtime (PGlite), with mocked Supabase auth functions. They validate migration reruns, authenticated permissions, receiving/removing stock, duplicate checkout and return rejection, damaged returns, archiving, preserved history, counts, and CSV escaping. They do not connect to your live Supabase database or test a physical camera.
