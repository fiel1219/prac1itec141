import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {loadLaboratories} from '../src/lib/laboratories.js'

test('laboratories preserve existing inventory, scope shelves/history, enforce physical empty-only deletion, and rerun safely',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon;grant execute on all functions in schema auth to authenticated,anon;`)
    const file=name=>readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    for(const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql','inventory_consumable_quantities.sql','inventory_consumable_actions.sql','inventory_bulk_actions.sql'])await db.exec(await file(name))
    const auth=()=>db.exec(`set role authenticated;select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    await auth()
    const query=(sql,params=[])=>db.query(sql,params)
    const scalar=async(sql,params)=>(await query(sql,params)).rows[0].id
    const legacyShelf=await scalar(`select public.inventory_save_shelf_details(null,'A-01','Original shelf','Original description') as id`)
    const receive=(id,name,kind,n)=>query('select public.inventory_receive_categorized_items($1,$2,$3,$4,$2)',[id,name,kind,n])
    await receive(legacyShelf,'Monitor','equipment',2);await receive(legacyShelf,'Gloves','consumable',5)
    const oldShelf=(await query('select * from public.shelves where id=$1',[legacyShelf])).rows[0]
    const oldUnits=(await query('select * from public.inventory_units order by id')).rows
    const borrower=await scalar(`insert into public.borrowers(name,identity_number) values('Student','S-01') returning id`)
    await query('select public.inventory_checkout($1,$2,current_date+1)',[oldUnits.find(row=>row.inventory_kind==='equipment').id,borrower])
    await db.exec('reset role')
    const migration=await file('inventory_laboratories.sql');await db.exec(migration);await db.exec(migration)
    await auth()
    const science=await scalar(`select id from public.laboratories where name='Science Laboratory'`)
    const preserved=(await query('select * from public.shelves where id=$1',[legacyShelf])).rows[0]
    assert.equal(preserved.laboratory_id,science);assert.equal(preserved.qr_value,oldShelf.qr_value)
    assert.equal(preserved.description,oldShelf.description)
    assert.deepEqual((await query('select id from public.inventory_units order by id')).rows.map(row=>row.id),oldUnits.map(row=>row.id))
    assert.ok((await query('select * from public.stock_movements')).rows.every(row=>row.laboratory_id===science && row.laboratory_name==='Science Laboratory'))
    assert.equal((await query('select laboratory_id from public.transactions')).rows[0].laboratory_id,science)
    const lab=(id,name,description='')=>scalar('select public.inventory_save_laboratory($1,$2,$3) as id',[id,name,description])
    const chemistry=await lab(null,' Chemistry Laboratory ',' First floor ')
    await assert.rejects(lab(null,'chemistry laboratory'),/already exists/)
    await assert.rejects(lab(null,'   '),/laboratory name/)
    await assert.rejects(lab(null,'x'.repeat(121)),/laboratory name/)
    await assert.rejects(lab(null,'Another','x'.repeat(1001)),/description/)
    await assert.rejects(lab('99999999-9999-4999-8999-999999999999','Missing'),/not found/)
    await lab(chemistry,'Chemistry Lab','Room 101')
    const renamed=(await query('select * from public.laboratories where id=$1',[chemistry])).rows[0]
    assert.equal(renamed.name,'Chemistry Lab');assert.equal(renamed.description,'Room 101')
    const saveShelf=(labId,id,code,name='Shelf')=>scalar('select public.inventory_save_laboratory_shelf($1,$2,$3,$4,$5) as id',[labId,id,code,name,'Description'])
    const chemShelf=await saveShelf(chemistry,null,'A-01','Chemistry shelf')
    await assert.rejects(saveShelf(chemistry,null,'A-01'),/already used/)
    await assert.rejects(saveShelf(science,chemShelf,'B-01'),/not found in this laboratory/)
    await assert.rejects(query('update public.shelves set laboratory_id=$1 where id=$2',[science,chemShelf]),/cannot be reassigned/)
    await assert.rejects(scalar(`select public.inventory_save_shelf_details(null,'OLD','Old client','') as id`),/Choose a laboratory/)
    await assert.rejects(query('select public.inventory_delete_laboratory($1)',[chemistry]),/shelves before/)
    await assert.rejects(query('delete from public.laboratories where id=$1',[chemistry]),/shelves before/)
    await receive(chemShelf,'Gloves','consumable',10);await receive(chemShelf,'Monitor','equipment',1)
    const chemEquipment=await scalar(`select id from public.inventory_units where shelf_id=$1 and inventory_kind='equipment'`,[chemShelf])
    await query('select public.inventory_checkout($1,$2,current_date+1)',[chemEquipment,borrower])
    const loan=(await query('select * from public.transactions where unit_id=$1',[chemEquipment])).rows[0]
    assert.equal(loan.laboratory_id,chemistry);assert.equal(loan.laboratory_name,'Chemistry Lab')
    await query(`select public.inventory_return($1,'good')`,[loan.id])
    await lab(chemistry,'Renamed Chemistry','Room 102')
    await query(`select public.inventory_bulk_item_action($1,'delete',$2,$3::jsonb,null,'Disposed')`,[chemShelf,[chemEquipment],JSON.stringify([{item_name:'Gloves',expected_quantity:10}])])
    assert.ok((await query(`select laboratory_id,laboratory_name from public.stock_movements where shelf_id=$1 and reason like 'Deleted%'`,[chemShelf])).rows.every(row=>row.laboratory_id===chemistry && row.laboratory_name==='Renamed Chemistry'))
    await query('select public.inventory_delete_shelf($1)',[chemShelf])
    await query('select public.inventory_delete_laboratory($1)',[chemistry])
    assert.equal((await query('select id from public.laboratories where id=$1',[chemistry])).rows.length,0)
    const history=(await query('select * from public.transactions where id=$1',[loan.id])).rows[0]
    assert.equal(history.unit_id,null);assert.equal(history.laboratory_id,chemistry);assert.equal(history.laboratory_name,'Chemistry Lab')
    assert.ok((await query('select * from public.stock_movements where laboratory_id=$1',[chemistry])).rows.every(row=>row.shelf_id===null))
    assert.equal((await query('select id from public.shelves where laboratory_id=$1',[science])).rows.length,1)
    const loneLegacy=await scalar(`select public.inventory_save_shelf_details(null,'OLD','Compatible client','') as id`)
    assert.equal((await query('select laboratory_id from public.shelves where id=$1',[loneLegacy])).rows[0].laboratory_id,science)
    await query('select public.inventory_delete_shelf($1)',[loneLegacy])
    const oldLoan=(await query('select id from public.transactions where returned_at is null')).rows[0].id
    await query(`select public.inventory_return($1,'good')`,[oldLoan])
    const originalEquipment=(await query(`select id from public.inventory_units where shelf_id=$1 and inventory_kind='equipment'`,[legacyShelf])).rows.map(row=>row.id)
    await query(`select public.inventory_bulk_item_action($1,'delete',$2,$3::jsonb,null,'Cleanup')`,[legacyShelf,originalEquipment,JSON.stringify([{item_name:'Gloves',expected_quantity:5}])])
    await query('select public.inventory_delete_shelf($1)',[legacyShelf])
    await query('select public.inventory_delete_laboratory($1)',[science])
    await db.exec('reset role');await db.exec(migration);await auth()
    assert.equal((await query('select * from public.laboratories')).rows.length,0,'Rerunning never recreates deleted laboratories')
    assert.ok((await query('select laboratory_id from public.stock_movements')).rows.every(row=>row.laboratory_id),'History survives deleting the final lab')
    const fresh=await lab(null,'New Laboratory')
    assert.notEqual(fresh,science)
    await db.exec(`select set_config('test.uid','',false)`)
    await assert.rejects(lab(null,'Unauthenticated'),/Sign in/)
    await assert.rejects(query('select public.inventory_delete_laboratory($1)',[fresh]),/Sign in/)
    await db.exec('reset role;set role anon')
    await assert.rejects(lab(null,'Anonymous'),/permission denied/)
    await assert.rejects(query('select * from public.laboratories'),/permission denied/)
  }finally{await db.close()}
})

test('laboratory loading paginates, preserves legacy viewing for missing setup, and surfaces permission failures',async()=>{
  const calls=[]
  function client({missing,denied,partial}={}) {
    return { from(table) {
      let offset=0
      const request={select:()=>request,order:()=>request,range:(start)=>{offset=start;return request},limit:()=>request,
        then(resolve){calls.push({table,offset});return Promise.resolve(table==='laboratories'
          ? denied ? {error:{code:'42501',message:'Denied'}} : missing ? {error:{code:'42P01'}} : {data:offset===0?Array.from({length:500},(_,i)=>({id:String(i),name:'Lab '+i})):[{id:'last',name:'Last'}]}
          : partial ? {error:{code:'42703'}} : {data:[]}).then(resolve)} }
      return request
    } }
  }
  assert.equal((await loadLaboratories(client())).data.length,501)
  assert.ok(calls.some(call=>call.table==='laboratories'&&call.offset===500))
  for(const settings of [{missing:true},{partial:true}]) {
    const result=await loadLaboratories(client(settings))
    assert.equal(result.setupRequired,true);assert.equal(result.data[0].name,'Science Laboratory');assert.equal(result.error,null)
  }
  const failure=await loadLaboratories(client({denied:true}))
  assert.equal(failure.error.code,'42501');assert.equal(failure.data,null)
})
