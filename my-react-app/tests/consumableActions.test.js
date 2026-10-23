import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'

test('consumable moves and permanent deletions handle full quantities, stock states, stale requests and independent history',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon;grant execute on all functions in schema auth to authenticated,anon;`)
    const file=name=>readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    for(const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql','inventory_consumable_quantities.sql'])await db.exec(await file(name))
    const migration=await file('inventory_consumable_actions.sql');await db.exec(migration);await db.exec(migration)
    await db.exec(`set role authenticated;select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    const call=(sql,params)=>db.query(sql,params)
    const shelf=async code=>(await call(`select public.inventory_save_shelf_details(null,$1,$1,'') as id`,[code])).rows[0].id
    const source=await shelf('SOURCE'),empty=await shelf('EMPTY'),destination=await shelf('DEST')
    const receive=(id,kind,n)=>call(`select public.inventory_receive_categorized_items($1,'Gloves',$2,$3,'Description')`,[id,kind,n])
    await receive(source,'equipment',1);await receive(source,'consumable',50);await receive(destination,'consumable',20)
    const row=async id=>(await call('select * from public.inventory_units where id=$1',[id])).rows[0]
    const stock=async id=>(await call(`select * from public.inventory_units where shelf_id=$1 and inventory_kind='consumable' order by unit_number`,[id])).rows
    const original=(await stock(source))[0],existing=(await stock(destination))[0]
    const damaged=(await call(`insert into public.inventory_units(shelf_id,unit_number,item_name,inventory_kind,quantity,consumable_number,status,condition,description)
      values($1,3,'Gloves','consumable',5,1,'under_maintenance','damaged','Damaged stock') returning *`,[source])).rows[0]
    const move=(from,to,expected)=>call(`select public.inventory_move_consumable($1,'Gloves',$2,'Reorganize',$3)`,[from,to,expected])
    const remove=(id,expected,reason='Disposed')=>call(`select public.inventory_delete_consumable($1,'Gloves',$2,$3)`,[id,reason,expected])
    await assert.rejects(move(source,source,55),/different destination/)
    await assert.rejects(move(source,'99999999-9999-4999-8999-999999999999',55),/Both shelves must be active/)
    await assert.rejects(move(source,empty,54),/quantity changed/)
    assert.equal((await stock(source)).length,2)
    await call(`update public.inventory_units set status='borrowed' where id=$1`,[original.id])
    await assert.rejects(move(source,empty,55),/Return outstanding/)
    await assert.rejects(remove(source,55),/Return outstanding/)
    await call(`update public.inventory_units set status='available' where id=$1`,[original.id])
    const receiptsBefore=Number((await call(`select count(*) as n from public.stock_movements where reason='Received stock'`)).rows[0].n)
    await move(source,empty,55)
    assert.equal((await stock(source)).length,0)
    assert.equal((await row(original.id)).shelf_id,empty)
    assert.equal((await row(damaged.id)).shelf_id,empty)
    assert.equal((await row(original.id)).quantity,50)
    assert.equal((await row(damaged.id)).quantity,5)
    assert.equal((await row(damaged.id)).condition,'damaged')
    await move(empty,destination,55)
    assert.equal(await row(original.id),undefined)
    assert.equal((await row(existing.id)).quantity,70)
    assert.equal((await row(damaged.id)).shelf_id,destination)
    assert.equal((await stock(destination)).length,2)
    const transfers=(await call(`select direction,sum(quantity)::int as n,count(*)::int as records from public.stock_movements where reason in ('Transfer in','Transfer out') group by direction order by direction`)).rows
    assert.deepEqual(transfers,[{direction:'in',n:110,records:4},{direction:'out',n:110,records:4}])
    assert.equal(Number((await call(`select count(*) as n from public.stock_movements where reason='Received stock'`)).rows[0].n),receiptsBefore)
    const oldHistory=(await call('select unit_id,unit_id_snapshot,item_type,item_description from public.stock_movements where unit_id_snapshot=$1',[original.id])).rows
    assert.ok(oldHistory.every(history=>history.unit_id===null && history.unit_id_snapshot===original.id && history.item_type==='Gloves'))
    assert.ok(oldHistory.some(history=>history.item_description==='Description'))
    await receive(destination,'consumable',5)
    assert.equal((await row(existing.id)).quantity,75)
    assert.equal(Number((await call(`select count(*) as n from public.stock_movements where reason='Received stock'`)).rows[0].n),receiptsBefore+1)
    await assert.rejects(remove(destination,80,''),/deletion reason/)
    await assert.rejects(remove(destination,79),/quantity changed/)
    await remove(destination,80,'Expired stock')
    assert.equal((await stock(destination)).length,0)
    assert.equal(await row(existing.id),undefined);assert.equal(await row(damaged.id),undefined)
    const deleted=(await call(`select quantity,unit_id,unit_id_snapshot,notes from public.stock_movements where reason='Deleted consumable' order by quantity`)).rows
    assert.deepEqual(deleted.map(history=>history.quantity),[5,75])
    assert.ok(deleted.every(history=>history.unit_id===null && history.notes==='Expired stock'))
    assert.equal((await call(`select count(*)::int as n from public.inventory_units where shelf_id=$1 and inventory_kind='equipment'`,[source])).rows[0].n,1)
    await call('select public.inventory_delete_shelf($1)',[empty])
    const zero=await shelf('ZERO');await receive(zero,'consumable',1)
    await call(`select public.inventory_item_category_stock_move($1,'out','Gloves','consumable',1,'Used','')`,[zero])
    await remove(zero,0)
    assert.equal((await stock(zero)).length,0)
    await db.exec(`select set_config('test.uid','',false)`)
    await assert.rejects(move(source,destination,1),/Sign in/)
    await assert.rejects(remove(source,1),/Sign in/)
    await db.exec('reset role;set role anon')
    await assert.rejects(move(source,destination,1),/permission denied/)
    await assert.rejects(remove(source,1),/permission denied/)
  }finally{await db.close()}
})
