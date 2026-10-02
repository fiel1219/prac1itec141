# VSU InventoScan

QR-based laboratory inventory built with React, Vite, and Supabase.

## Enable the new features on your existing database

Open your project's Supabase SQL Editor and run **supabase/inventoscan_features.sql** once. This migration is required before using the updated app, including QR checkout and returns. It is safe to rerun and preserves existing shelves, units, and borrowing history. The code has not applied this migration to your live database.

For a fresh database, first run schema.sql, configure your existing user_accounts/account_approvals tables and approved sign-in account, then run borrowing_permissions.sql and inventoscan_features.sql. Do not run both alternate user-table scripts; retain the account setup you already use. Seed scripts are optional demo data.

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

- **Items:** add and edit shelves and product types, set low-stock thresholds, edit unit status/condition/comments, and generate QR labels. Empty shelves can be archived. Archive and stock removal preserve transaction history.
- **Stock Movements:** receive 1–1000 new numbered units per operation, or remove available units with a required reason. Unit numbers are never reused. Borrowed, damaged, and maintenance units cannot be removed as available stock; return or resolve their condition first.
- **Scan QR / Returns:** existing shelf QR scanning and manual lookup, with atomic checkout/return functions. Damaged returns go to maintenance. The invalid fair-condition option has been removed to match the database enum.
- **Dashboard:** available, borrowed, and attention counts; shelf alerts when good available stock is at or below its threshold. Counts refresh after local changes, every 30 seconds, and when returning to the tab.
- **Reports:** current inventory summary, low-stock filtering, and CSV export. Movement reports include receipt, removal, checkout, return, and condition/status adjustments with date, shelf, direction, operator, and notes filters. Movement recording begins when the migration is installed; existing history is not fabricated or backfilled. Date filters use your browser's local timezone. Summary reports are current snapshots, while movement reports describe activity over time.

A QR identifies a shelf; the operator chooses its individual unit. Editing a shelf preserves its QR value so existing labels continue to work. Camera scanning requires a browser supporting BarcodeDetector, camera permission, and HTTPS or localhost; manual entry remains available.

## Verification

```sh
npm test
npm run lint
npm run build
```

Tests use an isolated in-memory PostgreSQL runtime (PGlite), with mocked Supabase auth functions. They validate migration reruns, authenticated permissions, receiving/removing stock, duplicate checkout and return rejection, damaged returns, archiving, preserved history, counts, and CSV escaping. They do not connect to your live Supabase database or test a physical camera.
