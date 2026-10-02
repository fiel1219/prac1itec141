import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { activeUnits, availableUnits, isLowStock, inventorySummary, csvText } from '../src/lib/inventory.js'

test('inventory counts exclude removed and damaged available units', () => {
  const shelf = { code: 'A', name: 'Tools', item_type: 'Equipment', low_stock_threshold: 1, inventory_units: [
    { status: 'available', condition: 'good' },
    { status: 'available', condition: 'damaged' },
    { status: 'available', condition: 'good', retired_at: '2026-01-01' },
    { status: 'borrowed', condition: 'good' },
  ] }
  assert.equal(activeUnits(shelf).length, 3)
  assert.equal(availableUnits(shelf).length, 1)
  assert.equal(isLowStock(shelf), true)
  assert.equal(inventorySummary([shelf])[0].borrowed, 1)
  assert.equal(isLowStock({ ...shelf, low_stock_threshold: 0 }), false)
  assert.equal(isLowStock({ low_stock_threshold: 0 }), true)
})

test('CSV preserves quotes and newlines and neutralizes spreadsheet formulas', () => {
  assert.equal(csvText(['Name','Notes'], [['A,"B"','line1\nline2'], ['=1+1','  @SUM(A1)']]),
    '"Name","Notes"\r\n"A,""B""","line1\nline2"\r\n"\'=1+1","\'  @SUM(A1)"')
})

test('migration and complete inventory lifecycle preserve counts and history', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon;
      grant execute on all functions in schema auth to authenticated,anon;
    `)
    const schema = (await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;', '')
    await db.exec(schema)
    const migration = await readFile(new URL('../supabase/inventoscan_features.sql',import.meta.url),'utf8')
    await db.exec(migration)
    await db.exec(migration) // Reruns must not duplicate tables, policies, or triggers.
    await db.exec(`set role authenticated; select set_config('test.uid','11111111-1111-1111-1111-111111111111',false)`)
    const shelf = (await db.query(`select public.inventory_save_shelf(null,'A-01','Microscopes','Equipment',2) as id`)).rows[0].id
    const call = (sql,params) => db.query(sql,params)
    const receive = count => call(`select public.inventory_stock_move($1,'in',$2,'Donation')`,[shelf,count])
    const remove = count => call(`select public.inventory_stock_move($1,'out',$2,'Disposed')`,[shelf,count])
    const units = async () => (await db.query(`select * from public.inventory_units where shelf_id=$1 order by unit_number`,[shelf])).rows
    const movementCount = async () => Number((await db.query(`select count(*) from public.stock_movements`)).rows[0].count)
    await receive(3)
    assert.equal((await units()).length,3)
    assert.equal(await movementCount(),3)
    await assert.rejects(remove(4),/Not enough/)
    assert.equal(await movementCount(),3)
    assert.equal((await units()).filter(unit => unit.retired_at).length,0)
    await assert.rejects(call(`select public.inventory_stock_move($1,'in',0,'')`,[shelf]),/quantity/)
    await assert.rejects(call(`select public.inventory_stock_move($1,'out',1,'')`,[shelf]),/reason/)
    const borrower = (await db.query(`insert into public.borrowers(name,identity_number) values('Student','2026-001') returning id`)).rows[0].id
    const unit = (await units())[0].id
    const checkout = () => call(`select public.inventory_checkout($1,$2,current_date+14)`,[unit,borrower])
    await checkout()
    assert.equal((await units())[0].status,'borrowed')
    await assert.rejects(checkout(),/no longer available/)
    await assert.rejects(call(`select public.inventory_update_unit($1,'available','good','')`,[unit]),/Return borrowed/)
    await assert.rejects(remove(3),/Not enough/)
    const transaction = (await db.query(`select id from public.transactions where unit_id=$1`,[unit])).rows[0].id
    await call(`select public.inventory_return($1,'damaged')`,[transaction])
    assert.equal((await units())[0].condition,'damaged')
    assert.equal((await units())[0].status,'under_maintenance')
    await assert.rejects(call(`select public.inventory_return($1,'good')`,[transaction]),/already returned/)
    await assert.rejects(call(`select public.inventory_update_unit($1,'available','damaged','')`,[unit]),/maintenance/)
    await call(`select public.inventory_update_unit($1,'available','good','Repaired')`,[unit])
    await remove(3)
    assert.equal((await units()).filter(unit => !unit.retired_at).length,0)
    await receive(1)
    assert.equal((await units()).at(-1).unit_number,4)
    await assert.rejects(call(`select public.inventory_archive_shelf($1)`,[shelf]),/Remove all stock/)
    await remove(1)
    await call(`select public.inventory_archive_shelf($1)`,[shelf])
    await assert.rejects(receive(1),/Active shelf not found/)
    assert.equal(await movementCount(),11)
    assert.equal(Number((await db.query('select count(*) from public.transactions')).rows[0].count),1)
    assert.equal((await db.query('select returned_by from public.transactions')).rows[0].returned_by,'operator@example.test')
    await db.exec('reset role; set role anon')
    await assert.rejects(receive(1),/permission denied/)
  } finally { await db.close() }
})
