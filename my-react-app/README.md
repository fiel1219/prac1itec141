# VSU InventoScan

QR-based laboratory inventory built with React, Vite, and Supabase.

## Enable the new features on your existing database

Open your project's Supabase SQL Editor and run **supabase/inventoscan_features.sql**, then **supabase/inventory_qr.sql**. These migrations enable inventory transactions and the equipment/consumable QR setup. Both are safe to rerun and preserve existing shelves, unit IDs, shelf QR values, and borrowing history. These files have not been applied to your live database by this code change.

For a fresh database, first run schema.sql, configure your existing user_accounts/account_approvals tables and approved sign-in account, then run borrowing_permissions.sql, inventoscan_features.sql, and inventory_qr.sql in that order. Do not run both alternate user-table scripts; retain the account setup you already use. Seed scripts are optional demo data.

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

- **Items:** add and edit shelves and product types, choose Equipment or Consumables, set low-stock thresholds, edit unit status/condition/comments, and generate QR labels. Equipment uses a separate QR for every unit; consumables use one QR per shelf. Empty shelves can be archived. Archive and stock removal preserve transaction history.
- **Stock Movements:** receive 1–1000 new numbered units per operation, or remove available units with a required reason. Unit numbers are never reused. Borrowed, damaged, and maintenance units cannot be removed as available stock; return or resolve their condition first.
- **Scan QR / Returns:** scan an equipment unit to open only its record for checkout or return. Scan a consumable shelf to view its quantity and issue a whole-number amount with a reason/recipient. Manual QR entry remains available. Atomic database functions validate transactions; consumables cannot be borrowed. Damaged equipment returns go to maintenance.
- **Dashboard:** available, borrowed, and attention counts; shelf alerts when good available stock is at or below its threshold. Counts refresh after local changes, every 30 seconds, and when returning to the tab.
- **Reports:** current inventory summary, low-stock filtering, and CSV export. Movement reports include receipt, removal, checkout, return, and condition/status adjustments with date, shelf, direction, operator, and notes filters. Movement recording begins when the migration is installed; existing history is not fabricated or backfilled. Date filters use your browser's local timezone. Summary reports are current snapshots, while movement reports describe activity over time.

### QR label setup

After applying `inventory_qr.sql`, existing shelves default to **Equipment**. Under **Items > Edit**, change supply shelves to **Consumables**. Return any borrowed equipment before changing its shelf to consumables. The current data model retains one product type per shelf.

- **Equipment:** open **Items > Units > Unit QR**, or **Equipment QRs**, to download a label for each unit. The payload is `VSU-EQUIPMENT:<unit UUID>`. It uses the unit's permanent database ID, so matching unit numbers on different shelves produce different labels. Editing shelf details or moving the same unit does not change its QR identity. Retired units cannot be scanned for new transactions.
- **Consumables:** choose **Shelf QR** to download the shelf label. Existing shelf QR values remain unchanged when shelf details are edited. Scanning shows the supply type and available quantity. Issue supplies through the scan result or Stock Movements.

Old equipment shelf labels no longer open borrowing transactions. The scanner asks staff to use the QR on the individual equipment unit instead. Camera scanning requires a browser supporting BarcodeDetector, camera permission, and HTTPS or localhost; manual entry remains available.

## Verification

```sh
npm test
npm run lint
npm run build
```

Tests use an isolated in-memory PostgreSQL runtime (PGlite), with mocked Supabase auth functions. They validate migration reruns, authenticated permissions, receiving/removing stock, duplicate checkout and return rejection, damaged returns, archiving, preserved history, counts, and CSV escaping. They do not connect to your live Supabase database or test a physical camera.
