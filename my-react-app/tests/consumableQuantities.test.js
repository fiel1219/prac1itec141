import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { stockQuantity,availableQuantity,shelfItems,inventorySummary,itemLabel } from '../src/lib/inventory.js'

test('quantity totals count consumable stock rather than database rows', () => {
  const shelf={code:'A',name:'Parts',inventory_units:[
    { inventory_kind:'equipment',unit_number:1,item_name:'Monitor',status:'available',condition:'good',quantity:1 },
    { inventory_kind:'consumable',unit_number:2,consumable_number:1,item_name:'Cable ties',status:'available',condition:'good',quantity:50 },
    { inventory_kind:'consumable',unit_number:3,consumable_number:1,item_name:'Cable ties',status:'available',condition:'damaged',quantity:4 },
    { inventory_kind:'consumable',unit_number:4,consumable_number:2,item_name:'Wipes',status:'available',condition:'good',quantity:0 },
  ]}
  assert.equal(stockQuantity(shelf),55);assert.equal(availableQuantity(shelf),51)
  const ties=shelfItems(shelf).find(item=>item.name==='Cable ties')
  assert.equal(ties.quantity,54);assert.equal(ties.available,50)
  const report=inventorySummary([shelf]).find(row=>row.item_type==='Cable ties')
  assert.equal(report.total,54);assert.equal(report.available,50);assert.equal(report.damaged,4)
  assert.equal(itemLabel(shelf.inventory_units[0],shelf),'Equipment 001')
  assert.equal(itemLabel(shelf.inventory_units[1],shelf),'Consumable 001')
})

test('consumable consolidation, receipts and issues keep one stock row, correct history and empty shelf deletion',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon;grant execute on all functions in schema auth to authenticated,anon;`)
    const file=name=>readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    for(const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql'])await db.exec(await file(name))
    const signIn=()=>db.exec(`set role authenticated;select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    const call=(sql,params)=>db.query(sql,params)
    await signIn()
    const shelf=(await call(`select public.inventory_save_shelf_details(null,'A','Parts','') as id`)).rows[0].id
    const receive=(kind,name,n,desc='')=>call('select public.inventory_receive_categorized_items($1,$2,$3,$4,$5)',[shelf,name,kind,n,desc])
    const issue=n=>call(`select public.inventory_item_category_stock_move($1,'out','Cable ties','consumable',$2,'Class','')`,[shelf,n])
    await receive('equipment','Monitor',1,'Permanent equipment')
    await receive('consumable','Cable ties',5,'Black ties')
    const equipment=(await call(`select * from public.inventory_units where shelf_id=$1 and inventory_kind='equipment'`,[shelf])).rows[0]
    const oldMovements=Number((await call('select count(*) as n from public.stock_movements')).rows[0].n)
    await db.exec('reset role')
    const migration=await file('inventory_consumable_quantities.sql')
    await db.exec(migration);await db.exec(migration);await signIn()
    const stock=async()=> (await call(`select * from public.inventory_units where shelf_id=$1 and inventory_kind='consumable' order by unit_number`,[shelf])).rows
    let rows=await stock();assert.equal(rows.length,1);assert.equal(rows[0].quantity,5);assert.equal(rows[0].consumable_number,1)
    assert.equal(Number((await call('select count(*) as n from public.stock_movements')).rows[0].n),oldMovements)
    assert.equal((await call('select id from public.inventory_units where id=$1',[equipment.id])).rows[0].id,equipment.id)
    const originalId=rows[0].id
    await receive('consumable','cable ties',50,'')
    rows=await stock();assert.equal(rows.length,1);assert.equal(rows[0].id,originalId);assert.equal(rows[0].quantity,55);assert.equal(rows[0].description,'Black ties')
    const receipt=(await call(`select quantity,reason from public.stock_movements where unit_id=$1 order by created_at desc,id desc`,[originalId])).rows.find(row=>row.quantity===50)
    assert.equal(receipt.reason,'Received stock')
    await issue(10);rows=await stock();assert.equal(rows[0].quantity,45);assert.equal(rows.length,1)
    assert.equal((await call(`select quantity from public.stock_movements where unit_id=$1 and reason='Issued consumables'`,[originalId])).rows[0].quantity,10)
    await assert.rejects(issue(46),/Not enough/)
    await assert.rejects(call(`select public.inventory_delete_shelf($1)`,[shelf]),/Move or delete/)
    await issue(45);rows=await stock();assert.equal(rows[0].quantity,0);assert.equal(rows[0].retired_at,null)
    await receive('consumable','Cable ties',2);rows=await stock();assert.equal(rows[0].id,originalId);assert.equal(rows[0].quantity,2)
    await issue(2)
    await call(`select public.inventory_delete_unit($1,'Disposed')`,[equipment.id])
    await call('select public.inventory_delete_shelf($1)',[shelf])
    assert.equal((await call('select count(*)::int as n from public.shelves where id=$1',[shelf])).rows[0].n,0)
    assert.equal((await call('select count(*)::int as n from public.inventory_units where shelf_id=$1',[shelf])).rows[0].n,0)
    const history=(await call(`select quantity,unit_id,unit_id_snapshot from public.stock_movements where reason='Issued consumables' order by quantity`)).rows
    assert.deepEqual(history.map(row=>row.quantity),[2,10,45]);assert.ok(history.every(row=>row.unit_id===null && row.unit_id_snapshot===originalId))
    // A fresh receipt of 50 creates one consumable record, while equipment remains per piece.
    const fresh=(await call(`select public.inventory_save_shelf_details(null,'NEW','New shelf','') as id`)).rows[0].id
    await call(`select public.inventory_receive_categorized_items($1,'Wipes','consumable',50,'Supplies')`,[fresh])
    await call(`select public.inventory_receive_categorized_items($1,'Microscope','equipment',3,'Equipment')`,[fresh])
    const freshRows=(await call('select * from public.inventory_units where shelf_id=$1 order by unit_number',[fresh])).rows
    assert.equal(freshRows.filter(row=>row.inventory_kind==='consumable').length,1)
    assert.equal(freshRows.filter(row=>row.inventory_kind==='equipment').length,3)
    assert.equal(freshRows[0].quantity,50)
    await assert.rejects(call(`update public.inventory_units set quantity=2 where id=$1`,[freshRows[1].id]),/inventory_quantity_check/)
    await assert.rejects(call(`delete from public.inventory_units where id=$1`,[freshRows[0].id]),/Issue remaining/)
    const borrower=(await call(`insert into public.borrowers(name,identity_number) values('Student','001') returning id`)).rows[0].id
    await assert.rejects(call('select public.inventory_checkout($1,$2,current_date+1)',[freshRows[0].id,borrower]),/Consumables/)
  }finally{await db.close()}
})
