import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'

test('mixed bulk moves and deletes are atomic, preserve unselected stock and history, and enforce permissions',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon;grant execute on all functions in schema auth to authenticated,anon;`)
    const file=name=>readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    for(const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql','inventory_consumable_quantities.sql','inventory_consumable_actions.sql'])await db.exec(await file(name))
    const migration=await file('inventory_bulk_actions.sql');await db.exec(migration);await db.exec(migration)
    await db.exec(`set role authenticated;select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    const query=(sql,params)=>db.query(sql,params)
    const shelf=async code=>(await query(`select public.inventory_save_shelf_details(null,$1,$1,'') as id`,[code])).rows[0].id
    const source=await shelf('SOURCE'),destination=await shelf('DEST')
    const receive=(id,name,kind,n)=>query(`select public.inventory_receive_categorized_items($1,$2,$3,$4,'Description')`,[id,name,kind,n])
    await receive(source,'Gloves','equipment',3)
    await receive(source,'Gloves','consumable',50);await receive(source,'Cable ties','consumable',100)
    await receive(source,'Zero catalog','consumable',1)
    await query(`select public.inventory_item_category_stock_move($1,'out','Zero catalog','consumable',1,'Used','')`,[source])
    await receive(destination,'Gloves','consumable',20)
    const rows=async sql=>(await query(sql)).rows
    const equipment=(await query(`select * from public.inventory_units where shelf_id=$1 and inventory_kind='equipment' order by unit_number`,[source])).rows
    const ids=equipment.slice(0,2).map(item=>item.id)
    const selection=[{item_name:'Gloves',expected_quantity:50},{item_name:'Cable ties',expected_quantity:100},{item_name:'Zero catalog',expected_quantity:0}]
    const run=(action,equipmentIds=ids,consumables=selection,from=source,to=destination,reason='Reorganize')=>query(
      'select public.inventory_bulk_item_action($1,$2,$3,$4::jsonb,$5,$6)',[from,action,equipmentIds,JSON.stringify(consumables),to,reason])
    const snapshot=async()=>({units:await rows('select * from public.inventory_units order by id'),
      shelves:await rows('select * from public.shelves order by id'),history:await rows('select * from public.stock_movements order by id')})
    const before=await snapshot()
    await assert.rejects(run('move',ids,[{item_name:'Cable ties',expected_quantity:100},{item_name:'Gloves',expected_quantity:49}]),/quantity changed/)
    assert.deepEqual(await snapshot(),before,'A late consumable failure rolls back earlier equipment and consumable moves, numbering and history')
    await assert.rejects(run('delete',ids,[{item_name:'Cable ties',expected_quantity:100},{item_name:'Missing',expected_quantity:1}]),/not found/)
    assert.deepEqual(await snapshot(),before,'A late delete failure restores earlier physical deletions and history')
    await assert.rejects(run('delete',ids,selection,source,destination,'   '),/deletion reason/)
    await assert.rejects(run('archive'),/Choose Move or Delete/)
    await assert.rejects(run('move',[],[]),/Select at least one/)
    await assert.rejects(run('move',[ids[0],ids[0]],[]),/only once/)
    await assert.rejects(run('move',[],[selection[0],{item_name:' gloves ',expected_quantity:50}]),/only once/)
    await assert.rejects(run('move',[],[{item_name:'Gloves'}]),/whole-number quantity/)
    await assert.rejects(run('move',[],[{item_name:'Gloves',expected_quantity:-1}]),/whole-number quantity/)
    await assert.rejects(run('move',[],{}),/valid consumable selection/)
    await assert.rejects(run('move',ids,selection,source,source),/different destination/)
    await assert.rejects(run('move',ids,selection,source,'99999999-9999-4999-8999-999999999999'),/destination shelf not found/)
    await assert.rejects(run('move',ids,[],destination,source),/changed shelves or was deleted/)
    const consumableId=(await query(`select id from public.inventory_units where shelf_id=$1 and inventory_kind='consumable' limit 1`,[source])).rows[0].id
    await assert.rejects(run('delete',[consumableId],[]),/changed shelves or was deleted/)
    await query(`update public.inventory_units set status='borrowed' where id=$1`,[ids[0]])
    await assert.rejects(run('move'),/Return borrowed/);await assert.rejects(run('delete'),/Return borrowed/)
    await query(`update public.inventory_units set status='available' where id=$1`,[ids[0]])

    await db.exec(`reset role;create policy test_keep_cables on public.inventory_units as restrictive for delete to authenticated using(item_name<>'Cable ties');set role authenticated`)
    const protectedSnapshot=await snapshot()
    await assert.rejects(run('delete'),/Check inventory permissions/)
    assert.deepEqual(await snapshot(),protectedSnapshot,'A silent RLS delete rejection rolls back the entire batch')
    await db.exec('reset role;drop policy test_keep_cables on public.inventory_units;set role authenticated')

    await run('move')
    const remainingSource=(await query('select * from public.inventory_units where shelf_id=$1',[source])).rows
    assert.deepEqual(remainingSource.map(item=>item.id),[equipment[2].id],'Unselected equipment stays on its shelf')
    const moved=(await query('select * from public.inventory_units where id=any($1)',[ids])).rows
    assert.equal(moved.length,2);assert.ok(moved.every(item=>item.shelf_id===destination && item.inventory_kind==='equipment'))
    const destinationStock=(await query(`select item_name,quantity from public.inventory_units where shelf_id=$1 and inventory_kind='consumable' order by item_name`,[destination])).rows
    assert.deepEqual(destinationStock,[{item_name:'Cable ties',quantity:100},{item_name:'Gloves',quantity:70},{item_name:'Zero catalog',quantity:0}])
    const transfers=await rows(`select direction,sum(quantity)::int as quantity from public.stock_movements where reason in ('Transfer in','Transfer out') group by direction order by direction`)
    assert.deepEqual(transfers,[{direction:'in',quantity:152},{direction:'out',quantity:152}])
    const deleteSelection=[{item_name:'Gloves',expected_quantity:70},{item_name:'Zero catalog',expected_quantity:0}]
    await run('delete',[ids[0]],deleteSelection,destination,null,'Disposed')
    assert.equal((await query('select id from public.inventory_units where id=$1',[ids[0]])).rows.length,0)
    assert.equal((await query('select id from public.inventory_units where id=$1',[ids[1]])).rows.length,1)
    const kept=(await query(`select item_name,quantity from public.inventory_units where shelf_id=$1 and inventory_kind='consumable'`,[destination])).rows
    assert.deepEqual(kept,[{item_name:'Cable ties',quantity:100}])
    const deletedHistory=await rows(`select reason,quantity,unit_id,unit_id_snapshot,notes from public.stock_movements where reason in ('Deleted equipment','Deleted consumable') order by reason`)
    assert.equal(deletedHistory.length,2)
    assert.deepEqual(deletedHistory.map(item=>item.quantity),[70,1])
    assert.ok(deletedHistory.every(item=>item.unit_id===null && item.unit_id_snapshot && item.notes==='Disposed'))
    await run('delete',[ids[1]],[{item_name:'Cable ties',expected_quantity:100}],destination,null,'Cleanup')
    await query('select public.inventory_delete_shelf($1)',[destination])
    assert.equal((await query('select id from public.shelves where id=$1',[destination])).rows.length,0)
    await db.exec(`select set_config('test.uid','',false)`)
    await assert.rejects(run('delete',[equipment[2].id],[]),/Sign in/)
    await db.exec('reset role;set role anon')
    await assert.rejects(run('delete',[equipment[2].id],[]),/permission denied/)
  }finally{await db.close()}
})
