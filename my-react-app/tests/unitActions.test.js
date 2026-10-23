import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { equipmentQRValue } from '../src/lib/inventoryQR.js'
import { inventoryMigrationRequired } from '../src/lib/inventoryData.js'

test('unit management setup does not block existing shelf deletion and inventory features', async () => {
  const missing = { code: '42703', message: 'Missing next_unit_number' }
  const client = { from: () => ({ select: column => ({ limit: async () => ({ error: column === 'next_unit_number' ? missing : null }) }) }) }
  assert.deepEqual(await inventoryMigrationRequired(client), { required: false, unitActionsRequired: true, permanentDeleteRequired: false, error: null })
})

test('schema checks surface access errors instead of presenting them as missing setup', async () => {
  const denied = { code: '42501', message: 'Permission denied' }
  const client = { from: () => ({ select: column => ({ limit: async () => ({ error: column === 'next_unit_number' ? denied : null }) }) }) }
  assert.deepEqual(await inventoryMigrationRequired(client), { required: false, error: denied })
})

test('unit transfers and targeted deletions preserve identity, historical locations, and shelf counts', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon;
      grant execute on all functions in schema auth to authenticated,anon;`)
    const file = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;', ''))
    await db.exec(await file('inventoscan_features.sql'))
    await db.exec(await file('inventory_qr.sql'))
    const migration = await file('inventory_unit_actions.sql')
    await db.exec(migration); await db.exec(migration)
    await db.exec(`set role authenticated; select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    const call = (sql, params) => db.query(sql, params)
    const makeShelf = async (code, type = 'Microscope', kind = 'equipment') => (await call(`select public.inventory_save_qr_shelf(null,$1,$1,$2,2,$3) as id`, [code, type, kind])).rows[0].id
    const source = await makeShelf('SOURCE'), destination = await makeShelf('DESTINATION')
    const wrongType = await makeShelf('TOOLS','Tools'), supplies = await makeShelf('SUPPLIES','Microscope','consumable')
    const archived = await makeShelf('ARCHIVED')
    await call('select public.inventory_archive_shelf($1)', [archived])
    const receive = shelf => call(`select public.inventory_stock_move($1,'in',2,'Received')`, [shelf])
    await receive(source); await receive(destination)
    const original = (await call('select * from public.inventory_units where shelf_id=$1 order by unit_number', [source])).rows
    const selected = original[1]
    const label = equipmentQRValue(selected)
    const borrower = (await call(`insert into public.borrowers(name,identity_number) values('Student','001') returning id`)).rows[0].id
    await call('select public.inventory_checkout($1,$2,current_date+14)', [selected.id, borrower])
    const loan = (await call('select id from public.transactions where unit_id=$1', [selected.id])).rows[0].id
    const move = target => call(`select public.inventory_move_unit($1,$2,'Reorganized')`, [selected.id, target])
    const remove = reason => call('select public.inventory_delete_unit($1,$2)', [selected.id, reason])
    await assert.rejects(move(destination), /Return borrowed/)
    await assert.rejects(remove('Disposed'), /Return borrowed/)
    await call(`select public.inventory_return($1,'good')`, [loan])
    await assert.rejects(move(source), /different shelf/)
    await assert.rejects(move(wrongType), /same item type/)
    await assert.rejects(move(supplies), /equipment shelves/)
    await assert.rejects(move(archived), /must be active/)
    await assert.rejects(move(null), /destination/)
    const movementBefore = Number((await call('select count(*) from public.stock_movements')).rows[0].count)
    await move(destination)
    const moved = (await call('select * from public.inventory_units where id=$1', [selected.id])).rows[0]
    assert.equal(moved.shelf_id, destination)
    assert.equal(moved.unit_number, 3)
    assert.equal(moved.condition, selected.condition)
    assert.equal(equipmentQRValue(moved), label)
    const history = (await call('select checkout_shelf_code,checkout_unit_number from public.transactions where id=$1', [loan])).rows[0]
    assert.deepEqual(history, { checkout_shelf_code: 'SOURCE', checkout_unit_number: 2 })
    const transfers = (await call(`select shelf_id,unit_number,direction,reason from public.stock_movements where unit_id=$1 and reason like 'Transfer%' order by direction desc`, [selected.id])).rows
    assert.deepEqual(transfers, [
      { shelf_id: source, unit_number: 2, direction: 'out', reason: 'Transfer out' },
      { shelf_id: destination, unit_number: 3, direction: 'in', reason: 'Transfer in' },
    ])
    assert.equal(Number((await call('select count(*) from public.stock_movements')).rows[0].count), movementBefore + 2)
    // The original receipt keeps its old number after the unit is renumbered on transfer.
    assert.equal((await call(`select unit_number from public.stock_movements where unit_id=$1 and reason='Received stock'`, [selected.id])).rows[0].unit_number, 2)
    await call(`select public.inventory_stock_move($1,'in',1,'New stock')`, [source])
    assert.deepEqual((await call('select unit_number from public.inventory_units where shelf_id=$1 order by unit_number', [source])).rows.map(row => row.unit_number), [1, 3])
    await assert.rejects(remove(' '), /reason/)
    await call(`select public.inventory_update_unit($1,'under_maintenance','damaged','Broken')`, [selected.id])
    await remove('Irreparable damage')
    assert.ok((await call('select retired_at from public.inventory_units where id=$1', [selected.id])).rows[0].retired_at)
    assert.equal(Number((await call('select count(*) from public.transactions where unit_id=$1', [selected.id])).rows[0].count), 1)
    assert.equal(Number((await call('select count(*) from public.inventory_units where shelf_id=$1 and retired_at is null', [destination])).rows[0].count), 2)
    await assert.rejects(remove('Again'), /already removed/)
    await assert.rejects(move(source), /already removed/)
    await assert.rejects(call('select public.inventory_archive_shelf($1)', [source]), /Remove all stock/)
    const remaining = (await call('select id from public.inventory_units where shelf_id=$1 and retired_at is null', [source])).rows
    for (const unit of remaining) await call(`select public.inventory_delete_unit($1,'Clearing shelf')`, [unit.id])
    await call('select public.inventory_archive_shelf($1)', [source])
    assert.equal((await call('select status from public.shelves where id=$1', [source])).rows[0].status, 'archived')
    // Rerunning setup after moves keeps the high-water marks and original checkout identifiers.
    await db.exec('reset role'); await db.exec(migration)
    assert.deepEqual((await call('select checkout_shelf_code,checkout_unit_number from public.transactions where id=$1', [loan])).rows[0], history)
    assert.equal((await call('select next_unit_number from public.shelves where id=$1', [source])).rows[0].next_unit_number, 4)
    await db.exec('set role anon')
    await assert.rejects(remove('Unauthorized'), /permission denied/)
    await assert.rejects(move(destination), /permission denied/)
    await db.exec(`reset role; set role authenticated; select set_config('test.uid','',false)`)
    await assert.rejects(remove('Unsigned'), /Sign in/)
    await assert.rejects(move(destination), /Sign in/)
  } finally { await db.close() }
})
