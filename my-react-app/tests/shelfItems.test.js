import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { itemName, shelfItems, inventorySummary } from '../src/lib/inventory.js'
import { inventoryItemNamesRequired } from '../src/lib/inventoryData.js'

test('mixed-item counts, reports, and legacy labels keep item identity', () => {
  const shelf = { code:'A',name:'Parts',item_type:'Legacy',inventory_units:[
    { item_name:'Keyboard',status:'available',condition:'good' },
    { item_name:'keyboard',status:'borrowed',condition:'good' },
    { item_name:'Mouse',status:'available',condition:'damaged' },
    { item_name:'Mouse',status:'available',condition:'good',retired_at:'2026-01-01' },
  ] }
  assert.deepEqual(shelfItems(shelf).map(item => [item.name,item.units.length,item.available]),[['Keyboard',2,1],['Mouse',1,0]])
  assert.deepEqual(inventorySummary([shelf]).map(row => [row.item_type,row.total,row.borrowed]),[['Keyboard',2,1],['Mouse',1,0]])
  assert.equal(itemName({},shelf),'Legacy')
  assert.equal(inventorySummary([{ code:'EMPTY',name:'Empty' }])[0].total,0)
})

test('item setup checks distinguish absent columns from permission failures', async () => {
  const check = error => inventoryItemNamesRequired({ from: () => ({ select: () => ({ limit: async () => ({ error }) }) }) })
  assert.deepEqual(await check(null),{ required:false,error:null })
  assert.deepEqual(await check({ code:'42703' }),{ required:true,error:null })
  const denied = { code:'42501',message:'Denied' }
  assert.deepEqual(await check(denied),{ required:false,error:denied })
})

test('mixed shelves preserve names through receipts, targeted issues, transfers, loans, and deletion', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon; grant execute on all functions in schema auth to authenticated,anon;`)
    const file = name => readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    for(const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql']) await db.exec(await file(name))
    const signIn = () => db.exec(`set role authenticated; select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    await signIn()
    const call = (sql,params) => db.query(sql,params)
    const shelf = async (code,type='Equipment',kind='equipment') => (await call(`select public.inventory_save_qr_shelf(null,$1,$1,$2,0,$3) as id`,[code,type,kind])).rows[0].id
    const legacy = await shelf('LEGACY','Microscope')
    await call(`select public.inventory_stock_move($1,'in',2,'Legacy receipt')`,[legacy])
    const legacyUnits = (await call('select * from public.inventory_units where shelf_id=$1 order by unit_number',[legacy])).rows
    const borrower = (await call(`insert into public.borrowers(name,identity_number) values('Student','123') returning id`)).rows[0].id
    await call('select public.inventory_checkout($1,$2,current_date+1)',[legacyUnits[0].id,borrower])
    await db.exec('reset role')
    const migration = await file('inventory_shelf_items.sql')
    await db.exec(migration); await db.exec(migration)
    await signIn()
    assert.deepEqual((await call('select id,item_name,status from public.inventory_units where shelf_id=$1 order by unit_number',[legacy])).rows,
      legacyUnits.map((unit,i) => ({ id:unit.id,item_name:'Microscope',status:i===0?'borrowed':'available' })))
    assert.equal((await call('select checkout_item_name from public.transactions where unit_id=$1',[legacyUnits[0].id])).rows[0].checkout_item_name,'Microscope')
    const mixed = await shelf('PARTS'), supplies = await shelf('SUPPLIES','Consumables','consumable')
    const stock = (id,direction,name,n,notes='Delivery') => call('select public.inventory_item_stock_move($1,$2,$3,$4,$5)',[id,direction,name,n,notes])
    await stock(mixed,'in','Keyboard',2); await stock(mixed,'in','Mouse',3); await stock(mixed,'in',' keyboard ',1)
    const rows = async id => (await call('select * from public.inventory_units where shelf_id=$1 and retired_at is null order by unit_number',[id])).rows
    let units = await rows(mixed)
    assert.deepEqual(units.map(unit => unit.item_name),['Keyboard','Keyboard','Mouse','Mouse','Mouse','Keyboard'])
    assert.deepEqual(units.map(unit => unit.unit_number),[1,2,3,4,5,6])
    await assert.rejects(call(`select public.inventory_stock_move($1,'out',1,'Issue')`,[mixed]),/Choose an item/)
    await assert.rejects(stock(mixed,'in','',1),/item name/)
    await assert.rejects(stock(mixed,'in','Mouse',0),/quantity/)
    await assert.rejects(stock(mixed,'in','Mouse',1001),/quantity/)
    await assert.rejects(stock(mixed,'out','Mouse',4),/Not enough available/)
    await assert.rejects(stock(mixed,'out','Mouse',1,''),/reason/)
    const moved = units.find(unit => unit.item_name==='Mouse')
    await call(`select public.inventory_move_unit($1,$2,'Reorganize')`,[moved.id,legacy])
    const movedRow = (await call('select * from public.inventory_units where id=$1',[moved.id])).rows[0]
    assert.equal(movedRow.item_name,'Mouse'); assert.equal(movedRow.id,moved.id); assert.equal(movedRow.shelf_id,legacy)
    await assert.rejects(call(`select public.inventory_move_unit($1,$2,'Move')`,[moved.id,supplies]),/equipment shelves/)
    assert.equal((await call(`select item_type from public.stock_movements where unit_id=$1 and reason='Transfer out'`,[moved.id])).rows[0].item_type,'Mouse')
    await stock(mixed,'out','Mouse',1,'Removed damaged packaging')
    units = await rows(mixed)
    assert.equal(units.filter(unit => unit.item_name==='Keyboard').length,3)
    assert.equal(units.filter(unit => unit.item_name==='Mouse').length,1)
    const keyboard = units[0]
    await call('select public.inventory_checkout($1,$2,current_date+1)',[keyboard.id,borrower])
    await assert.rejects(call(`select public.inventory_move_unit($1,$2,'Move')`,[keyboard.id,legacy]),/Return borrowed/)
    const loan = (await call('select id,checkout_item_name from public.transactions where unit_id=$1',[keyboard.id])).rows[0]
    assert.equal(loan.checkout_item_name,'Keyboard')
    await call(`select public.inventory_return($1,'good')`,[loan.id])
    await call(`select public.inventory_delete_unit($1,'Disposed')`,[keyboard.id])
    assert.equal((await call('select count(*)::int as n from public.inventory_units where id=$1',[keyboard.id])).rows[0].n,0)
    const history = (await call('select unit_id,checkout_item_name from public.transactions where id=$1',[loan.id])).rows[0]
    assert.equal(history.unit_id,null); assert.equal(history.checkout_item_name,'Keyboard')
    assert.equal((await call(`select item_type from public.stock_movements where unit_id_snapshot=$1 and reason='Deleted equipment'`,[keyboard.id])).rows[0].item_type,'Keyboard')
    await stock(supplies,'in','Gloves',2); await stock(supplies,'in','Wipes',3)
    await stock(supplies,'out','Wipes',2,'Issued to class')
    const remaining = await rows(supplies)
    assert.deepEqual(remaining.map(unit => unit.item_name),['Gloves','Gloves','Wipes'])
    await db.exec(`select set_config('test.uid','',false)`)
    await assert.rejects(stock(mixed,'in','Mouse',1),/Sign in/)
    await db.exec('reset role; set role anon')
    await assert.rejects(stock(mixed,'in','Mouse',1),/permission denied/)
  } finally { await db.close() }
})
