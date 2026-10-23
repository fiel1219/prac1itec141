import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { inventoryMigrationRequired } from '../src/lib/inventoryData.js'

test('missing permanent-delete setup disables deletion without blocking other inventory features', async () => {
  const client = { from: () => ({ select: column => ({ limit: async () => ({ error: column === 'unit_id_snapshot' ? { code:'42703' } : null }) }) }) }
  assert.deepEqual(await inventoryMigrationRequired(client), { required:false,unitActionsRequired:false,permanentDeleteRequired:true,error:null })
})

test('permanent deletion removes real rows, purges legacy archives, and keeps independent history', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon; grant execute on all functions in schema auth to authenticated,anon;`)
    const file = name => readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;', ''))
    for (const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql']) await db.exec(await file(name))
    await db.exec(`set role authenticated; select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    const call = (sql,params) => db.query(sql,params)
    const shelf = async code => (await call(`select public.inventory_save_qr_shelf(null,$1,$1,'Equipment',0,'equipment') as id`,[code])).rows[0].id
    const receive = (id,n=1) => call(`select public.inventory_stock_move($1,'in',$2,'Receipt')`,[id,n])
    const unitRows = async id => (await call('select * from public.inventory_units where shelf_id=$1 order by unit_number',[id])).rows
    const count = async (table,id) => Number((await call(`select count(*) from public.${table} where id=$1`,[id])).rows[0].count)
    const source = await shelf('SOURCE'), archived = await shelf('OLD'), protectedShelf = await shelf('PROTECTED')
    await receive(source,3); await receive(archived); await receive(protectedShelf)
    const units = await unitRows(source), oldUnit = (await unitRows(archived))[0], protectedUnit = (await unitRows(protectedShelf))[0]
    const borrower = (await call(`insert into public.borrowers(name,identity_number) values('Student','TEST') returning id`)).rows[0].id
    const checkout = async id => {
      await call('select public.inventory_checkout($1,$2,current_date+14)',[id,borrower])
      return (await call('select id from public.transactions where unit_id=$1 and returned_at is null',[id])).rows[0].id
    }
    const completed = await checkout(units[0].id)
    await call(`select public.inventory_return($1,'good')`,[completed])
    // Populate the exact legacy state shown by the user: removed units and archived shelves.
    await call(`select public.inventory_delete_unit($1,'Old deletion')`,[units[1].id])
    await call(`select public.inventory_delete_unit($1,'Old deletion')`,[oldUnit.id])
    await call('select public.inventory_archive_shelf($1)',[archived])
    const protectedLoan = await checkout(protectedUnit.id)
    await call(`update public.shelves set status='archived' where id=$1`,[protectedShelf])
    await db.exec('reset role')
    await call(`insert into public.inventory_checks(shelf_id,performed_by) values($1,'Staff')`,[archived])
    await call(`insert into public.inventory_checks(shelf_id,performed_by) values($1,'Staff')`,[source])
    const migration = await file('inventory_permanent_delete.sql')
    await db.exec(migration)
    assert.equal(await count('inventory_units',units[1].id),0)
    assert.equal(await count('inventory_units',oldUnit.id),0)
    assert.equal(await count('shelves',archived),0)
    assert.equal(await count('inventory_units',protectedUnit.id),1)
    assert.equal((await call('select status from public.shelves where id=$1',[protectedShelf])).rows[0].status,'active')
    assert.deepEqual((await call('select shelf_id,shelf_id_snapshot,shelf_code from public.inventory_checks where shelf_id_snapshot=$1',[archived])).rows[0],{shelf_id:null,shelf_id_snapshot:archived,shelf_code:'OLD'})
    assert.equal((await call(`select to_regprocedure('public.inventory_archive_shelf(uuid)') as fn`)).rows[0].fn,null)
    await assert.rejects(call(`update public.shelves set status='archived' where id=$1`,[source]),/shelves_active_only/)
    await db.exec('set role authenticated')
    await assert.rejects(call('select public.inventory_delete_shelf($1)',[source]),/Move or delete all units/)
    await assert.rejects(call('delete from public.shelves where id=$1',[source]),/Move or delete all units/)
    await assert.rejects(call(`select public.inventory_delete_unit($1,'Still borrowed')`,[protectedUnit.id]),/Return borrowed/)
    await assert.rejects(call('delete from public.inventory_units where id=$1',[protectedUnit.id]),/Return borrowed/)
    await call(`select public.inventory_delete_unit($1,'Permanently remove returned unit')`,[units[0].id])
    assert.equal(await count('inventory_units',units[0].id),0)
    const history = (await call('select unit_id,unit_id_snapshot,checkout_shelf_code,checkout_unit_number,returned_at from public.transactions where id=$1',[completed])).rows[0]
    assert.equal(history.unit_id,null); assert.equal(history.unit_id_snapshot,units[0].id)
    assert.equal(history.checkout_shelf_code,'SOURCE'); assert.equal(history.checkout_unit_number,1); assert.ok(history.returned_at)
    const deletion = (await call(`select unit_id,unit_id_snapshot,unit_number,shelf_code,notes from public.stock_movements where unit_id_snapshot=$1 and reason='Deleted equipment'`,[units[0].id])).rows[0]
    assert.deepEqual(deletion,{unit_id:null,unit_id_snapshot:units[0].id,unit_number:1,shelf_code:'SOURCE',notes:'Permanently remove returned unit'})
    await call(`select public.inventory_delete_unit($1,'Remove highest number')`,[units[2].id])
    await receive(source)
    assert.equal((await unitRows(source))[0].unit_number,4)
    await call(`select public.inventory_delete_unit($1,'Empty shelf')`,[(await unitRows(source))[0].id])
    await call('select public.inventory_delete_shelf($1)',[source])
    assert.equal(await count('shelves',source),0)
    assert.equal((await unitRows(source)).length,0)
    const oldMovement = (await call('select shelf_id,shelf_code,unit_id_snapshot from public.stock_movements where shelf_id_snapshot=$1 limit 1',[source])).rows[0]
    assert.equal(oldMovement.shelf_id,null); assert.equal(oldMovement.shelf_code,'SOURCE'); assert.ok(oldMovement.unit_id_snapshot)
    await db.exec('reset role')
    assert.equal((await call('select shelf_id from public.inventory_checks where shelf_id_snapshot=$1',[source])).rows[0].shelf_id,null)
    await db.exec('set role authenticated')
    // A deleted shelf code becomes available for a new shelf rather than remaining reserved by an archive.
    const replacement = await shelf('SOURCE'); assert.notEqual(replacement,source)
    await call(`select public.inventory_return($1,'good')`,[protectedLoan])
    await call(`select public.inventory_delete_unit($1,'Returned')`,[protectedUnit.id])
    await call('select public.inventory_delete_shelf($1)',[protectedShelf])
    await assert.rejects(call('select public.inventory_delete_shelf($1)',[protectedShelf]),/already deleted/)
    await db.exec('reset role'); await db.exec(migration)
    assert.equal(await count('shelves',replacement),1)
    assert.equal((await call('select unit_id_snapshot from public.transactions where id=$1',[completed])).rows[0].unit_id_snapshot,units[0].id)
    // Deleting an emptied source shelf must not delete equipment transferred to another shelf.
    await db.exec('set role authenticated')
    const destination = await shelf('DESTINATION')
    await receive(replacement)
    const moved = (await unitRows(replacement))[0]
    await call(`select public.inventory_move_unit($1,$2,'Relocated')`,[moved.id,destination])
    await call('select public.inventory_delete_shelf($1)',[replacement])
    assert.equal((await call('select shelf_id from public.inventory_units where id=$1',[moved.id])).rows[0].shelf_id,destination)
    const transfer = (await call(`select shelf_id,shelf_code,unit_id from public.stock_movements where unit_id=$1 and reason='Transfer out'`,[moved.id])).rows[0]
    assert.deepEqual(transfer,{shelf_id:null,shelf_code:'SOURCE',unit_id:moved.id})
    await call(`select public.inventory_delete_unit($1,'Remove relocated unit')`,[moved.id])
    await call('select public.inventory_delete_shelf($1)',[destination])
    await db.exec('set role anon')
    await assert.rejects(call('select public.inventory_delete_shelf($1)',[replacement]),/permission denied/)
    await assert.rejects(call('delete from public.shelves where id=$1',[replacement]),/permission denied/)
    await db.exec(`reset role; set role authenticated; select set_config('test.uid','',false)`)
    await assert.rejects(call('select public.inventory_delete_shelf($1)',[replacement]),/Sign in/)
  } finally { await db.close() }
})
