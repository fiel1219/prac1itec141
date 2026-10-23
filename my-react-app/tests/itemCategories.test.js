import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { shelfItems, inventorySummary } from '../src/lib/inventory.js'
import { inventoryItemCategoriesRequired } from '../src/lib/inventoryData.js'

test('same-name equipment and consumables remain separate in counts and reports', () => {
  const shelf = { code:'A',name:'Mixed',inventory_units:[
    { item_name:'Cable',inventory_kind:'equipment',status:'available',condition:'good' },
    { item_name:'Cable',inventory_kind:'consumable',status:'available',condition:'good' },
    { item_name:'cable',inventory_kind:'consumable',status:'available',condition:'damaged' },
  ] }
  assert.deepEqual(shelfItems(shelf).map(item => [item.key,item.units.length,item.available]),[['equipment:cable',1,1],['consumable:cable',2,1]])
  assert.deepEqual(inventorySummary([shelf]).map(row => [row.category,row.total]),[['Equipment',1],['Consumables',2]])
})

test('item category setup checks both item category and shelf description', async () => {
  const check = failure => inventoryItemCategoriesRequired({ from: table => ({ select: column => ({ limit: async () => ({ error:failure(table,column) }) }) }) })
  assert.deepEqual(await check(() => null),{ required:false,error:null })
  for(const missing of ['inventory_kind','description']) assert.deepEqual(await check((table,column) => column===missing ? {code:'42703'} : null),{required:true,error:null})
  const denied = { code:'42501' }
  assert.deepEqual(await check(() => denied),{ required:false,error:denied })
})

test('shelf metadata and item categories support mixed receipts, loans, transfers and issues without changing old IDs', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon; grant execute on all functions in schema auth to authenticated,anon;`)
    const file = name => readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    for(const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql']) await db.exec(await file(name))
    const signIn = () => db.exec(`set role authenticated; select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    const call = (sql,params) => db.query(sql,params)
    await signIn()
    const legacyShelf = async (code,kind) => (await call(`select public.inventory_save_qr_shelf(null,$1,$1,'Old items',0,$2) as id`,[code,kind])).rows[0].id
    const equipmentShelf = await legacyShelf('OLD-E','equipment'), suppliesShelf = await legacyShelf('OLD-C','consumable')
    await call(`select public.inventory_receive_items($1,'Monitor',1,'Old equipment')`,[equipmentShelf])
    await call(`select public.inventory_receive_items($1,'Wipes',2,'Old supplies')`,[suppliesShelf])
    const oldUnits = (await call('select * from public.inventory_units order by id')).rows
    const borrower = (await call(`insert into public.borrowers(name,identity_number) values('Student','ABC') returning id`)).rows[0].id
    const oldEquipment = oldUnits.find(unit => unit.shelf_id===equipmentShelf)
    await call('select public.inventory_checkout($1,$2,current_date+1)',[oldEquipment.id,borrower])
    await db.exec('reset role')
    const migration = await file('inventory_item_categories.sql')
    await db.exec(migration);await db.exec(migration)
    await signIn()
    const upgraded = (await call('select * from public.inventory_units order by id')).rows
    assert.deepEqual(upgraded.map(unit => unit.id),oldUnits.map(unit => unit.id))
    assert.ok(upgraded.every(unit => unit.inventory_kind===(unit.shelf_id===equipmentShelf?'equipment':'consumable')))
    assert.equal(upgraded.find(unit => unit.id===oldEquipment.id).status,'borrowed')
    const mixed = (await call(`select public.inventory_save_shelf_details(null,'MIXED','Computer Parts','  Main laboratory\nFirst floor  ') as id`)).rows[0].id
    const shelf = async () => (await call('select * from public.shelves where id=$1',[mixed])).rows[0]
    const initial = await shelf();assert.equal(initial.description,'Main laboratory\nFirst floor')
    const receive = (name,kind,n,description='') => call('select public.inventory_receive_categorized_items($1,$2,$3,$4,$5)',[mixed,name,kind,n,description])
    await receive('Cable','equipment',2,'Reusable cable');await receive('Cable','consumable',3,'Disposable ties')
    const rows = async id => (await call('select * from public.inventory_units where shelf_id=$1 and retired_at is null order by unit_number',[id])).rows
    let units = await rows(mixed)
    assert.deepEqual(units.map(unit => unit.inventory_kind),['equipment','equipment','consumable','consumable','consumable'])
    assert.deepEqual(units.map(unit => unit.unit_number),[1,2,3,4,5])
    assert.equal(units[0].description,'Reusable cable');assert.equal(units[2].description,'Disposable ties')
    await assert.rejects(receive('Bad','invalid',1),/Choose equipment or consumables/)
    await assert.rejects(receive('Cable','equipment',0),/quantity/)
    await assert.rejects(receive('Cable','equipment',1,'x'.repeat(1001)),/description/)
    await assert.rejects(call(`select public.inventory_item_stock_move($1,'out','Cable',1,'Issue')`,[mixed]),/Choose an item category/)
    await assert.rejects(call(`select public.inventory_stock_move($1,'out',1,'Issue')`,[mixed]),/Choose an item category/)
    const consumable = units[2],equipment = units[0]
    await assert.rejects(call('select public.inventory_checkout($1,$2,current_date+1)',[consumable.id,borrower]),/Consumables/)
    await assert.rejects(call(`insert into public.transactions(unit_id,borrower_id,expected_return_at) values($1,$2,current_date+1)`,[consumable.id,borrower]),/Consumables/)
    await assert.rejects(call(`select public.inventory_move_unit($1,$2,'Relocate')`,[consumable.id,equipmentShelf]),/stock-out/)
    await assert.rejects(call(`select public.inventory_delete_unit($1,'Disposed')`,[consumable.id]),/stock-out/)
    await assert.rejects(call(`update public.inventory_units set inventory_kind='equipment' where id=$1`,[consumable.id]),/cannot be changed/)
    const issue = n => call(`select public.inventory_item_category_stock_move($1,'out','Cable','consumable',$2,'Class','')`,[mixed,n])
    await assert.rejects(issue(4),/Not enough/)
    await issue(2)
    units = await rows(mixed)
    assert.equal(units.filter(unit => unit.inventory_kind==='equipment').length,2)
    assert.equal(units.filter(unit => unit.inventory_kind==='consumable').length,1)
    await call(`select public.inventory_move_unit($1,$2,'Relocate')`,[equipment.id,suppliesShelf])
    const moved = (await call('select * from public.inventory_units where id=$1',[equipment.id])).rows[0]
    assert.equal(moved.inventory_kind,'equipment');assert.equal(moved.description,'Reusable cable')
    // A legacy consumable shelf can now contain borrowable equipment.
    await call('select public.inventory_checkout($1,$2,current_date+1)',[equipment.id,borrower])
    await assert.rejects(call(`select public.inventory_delete_unit($1,'Disposed')`,[equipment.id]),/Return borrowed/)
    const loan = (await call('select id from public.transactions where unit_id=$1 and returned_at is null',[equipment.id])).rows[0].id
    await call(`select public.inventory_return($1,'good')`,[loan])
    await call(`select public.inventory_delete_unit($1,'Disposed')`,[equipment.id])
    const snapshots = (await call('select inventory_kind from public.stock_movements where unit_id_snapshot=$1',[equipment.id])).rows
    assert.ok(snapshots.length>1 && snapshots.every(row => row.inventory_kind==='equipment'))
    await call(`select public.inventory_save_shelf_details($1,'MIXED','Renamed','Updated shelf description')`,[mixed])
    assert.equal((await shelf()).qr_value,initial.qr_value)
    assert.equal((await shelf()).description,'Updated shelf description')
    assert.equal((await rows(mixed)).length,2)
    await assert.rejects(call(`select public.inventory_save_shelf_details(null,'X','X',$1)`,['x'.repeat(1001)]),/description/)
    await db.exec('reset role');await db.exec(migration);await signIn()
    assert.equal((await call('select inventory_kind from public.inventory_units where id=$1',[oldEquipment.id])).rows[0].inventory_kind,'equipment')
    await db.exec(`select set_config('test.uid','',false)`)
    await assert.rejects(receive('New','equipment',1),/Sign in/)
    await db.exec('reset role;set role anon')
    await assert.rejects(receive('New','equipment',1),/permission denied/)
  } finally { await db.close() }
})
