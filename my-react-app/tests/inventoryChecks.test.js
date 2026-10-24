import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { canCheckInventory, checkSubmission, inspectionItems, loadInventoryChecks } from '../src/lib/inventoryChecks.js'

test('inventory check visibility requires an active membership in the selected laboratory', () => {
  const memberships = [{user_id:'u', laboratory_id:'science', role:'Laboratory Admin'}]
  assert.equal(canCheckInventory({id:'u',status:'active',role:'Operator'}, memberships, 'science'), true)
  assert.equal(canCheckInventory({id:'u',status:'active',role:'Operator'}, [{...memberships[0],role:'Laboratory Operator'}], 'science'), true)
  assert.equal(canCheckInventory({id:'u',status:'active',role:'Admin'}, [], 'science'), false)
  assert.equal(canCheckInventory({id:'u',status:'disabled'}, memberships, 'science'), false)
  assert.equal(canCheckInventory({id:'u',status:'active'}, memberships, 'chemistry'), false)
  assert.equal(canCheckInventory(null, memberships, 'science'), false)
  assert.equal(canCheckInventory({id:'u',status:'active'}, memberships, null), false)
})

test('inspection rows include borrowed and missing stock as skipped and require explicit findings', () => {
  const shelf = {inventory_units:[
    {id:'good',unit_number:1,item_name:'Monitor',inventory_kind:'equipment',quantity:1,status:'available',condition:'good'},
    {id:'loan',unit_number:2,item_name:'Monitor',inventory_kind:'equipment',quantity:1,status:'borrowed',condition:'good'},
    {id:'missing',unit_number:3,item_name:'Monitor',inventory_kind:'equipment',quantity:1,status:'missing',condition:'good'},
    {id:'stock',unit_number:4,item_name:'Gloves',inventory_kind:'consumable',quantity:12,status:'under_maintenance',condition:'damaged'},
    {id:'zero',unit_number:5,item_name:'Gloves',inventory_kind:'consumable',quantity:0,status:'available',condition:'good'},
    {id:'removed',unit_number:6,item_name:'Old',retired_at:'2026-01-01'},
  ]}
  const items = inspectionItems(shelf)
  assert.equal(items.length,5)
  assert.deepEqual(items.filter(item=>!item.skip_reason).map(item=>item.id).sort(), ['good','stock'])
  const payload=checkSubmission(items,{good:{condition:'damaged',notes:' cracked '}})
  assert.equal(payload.find(item=>item.unit_id==='good').notes,'cracked')
  assert.equal(payload.find(item=>item.unit_id==='stock').expected_quantity,12)
  assert.equal(payload.find(item=>item.unit_id==='stock').condition,'')
})

test('check history scopes laboratory and shelf, and handles missing migrations separately from access errors', async () => {
  const filters=[]
  const client=result=>({from(table){
    assert.equal(table,'inventory_checks')
    return {select(){return this},eq(...args){filters.push(args);return this},order(){return this},limit(count){assert.equal(count,10);return Promise.resolve(result)}}
  }})
  await loadInventoryChecks(client({data:[]}), 'lab','shelf')
  assert.deepEqual(filters,[['laboratory_id','lab'],['shelf_id_snapshot','shelf']])
  assert.equal((await loadInventoryChecks(client({error:{code:'42703'}}),'lab')).setupRequired,true)
  const error={code:'42501',message:'Denied'}
  assert.equal((await loadInventoryChecks(client({error}),'lab')).error,error)
})

test('shelf checks enforce laboratory roles, save all results atomically, preserve quantities and history, and reject stale reviews', async () => {
  const db=new PGlite()
  const ids={system:'11111111-1111-4111-8111-111111111111',admin:'22222222-2222-4222-8222-222222222222',operator:'33333333-3333-4333-8333-333333333333',other:'44444444-4444-4444-8444-444444444444',disabled:'55555555-5555-4555-8555-555555555555'}
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select jsonb_build_object('email',current_setting('test.email',true)) $$;
      grant usage on schema public,auth to authenticated,anon;`)
    const file=name=>readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    await db.exec(`create type public.user_role as enum('Admin','Operator');
      create table public.user_accounts(id uuid primary key,full_name text,email text unique,role public.user_role,status public.account_status);
      alter table public.user_accounts enable row level security;
      grant select,insert,update,delete on public.user_accounts to authenticated;
      create policy prototype on public.user_accounts for all to authenticated using(true) with check(true);`)
    for(const [name,id] of Object.entries(ids)) await db.query(`insert into user_accounts values($1,$2,$3,$4,$5)`,[id,name,`${name}@example.test`,name==='system'?'Admin':'Operator',name==='disabled'?'disabled':'active'])
    for(const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql','inventory_consumable_quantities.sql','inventory_consumable_actions.sql','inventory_bulk_actions.sql','inventory_laboratories.sql','user_laboratories.sql','inventory_checks.sql']) await db.exec(await file(name))
    const login=async name=>{await db.exec('reset role;set role authenticated');await db.query(`select set_config('test.uid',$1,false),set_config('test.email',$2,false)`,[ids[name],`${name}@example.test`])}
    const query=(sql,args=[])=>db.query(sql,args)
    const scalar=async(sql,args=[])=>(await query(sql,args)).rows[0].id
    const science=await scalar(`select id from laboratories limit 1`)
    await login('system')
    const chemistry=await scalar(`select inventory_save_laboratory(null,'Chemistry','') as id`)
    for(const name of ['admin','operator','other','disabled'])await query('select inventory_save_user_assignments($1,$2,$3::jsonb)',[ids[name],'Operator',JSON.stringify([{laboratory_id:name==='other'?chemistry:science,role:name==='admin'?'Laboratory Admin':'Laboratory Operator'}])])
    const shelf=await scalar(`select inventory_save_laboratory_shelf($1,null,'A-01','Inspection shelf','') as id`,[science])
    const foreignShelf=await scalar(`select inventory_save_laboratory_shelf($1,null,'A-01','Other shelf','') as id`,[chemistry])
    await query(`select inventory_receive_categorized_items($1,'Microscope','equipment',4,'')`,[shelf])
    await query(`select inventory_receive_categorized_items($1,'Gloves','consumable',6,'')`,[shelf])
    const equipment=(await query(`select * from inventory_units where shelf_id=$1 and inventory_kind='equipment' order by unit_number`,[shelf])).rows
    await query(`select inventory_update_unit($1,'under_maintenance','damaged','')`,[equipment[1].id])
    await query(`select inventory_update_unit($1,'missing','good','')`,[equipment[3].id])
    const borrower=await scalar(`insert into borrowers(name,identity_number) values('Student','S-001') returning id`)
    await query('select inventory_checkout($1,$2,current_date+1)',[equipment[2].id,borrower])
    await db.exec('reset role')
    await query(`insert into inventory_units(shelf_id,unit_number,item_name,inventory_kind,quantity,status,condition,consumable_number)
      values($1,6,'Gloves','consumable',4,'under_maintenance','damaged',1)`,[shelf])
    const snapshot=async()=>(await query('select * from inventory_units where shelf_id=$1 order by unit_number',[shelf])).rows
    const payload=async()=>{
      const rows=inspectionItems({inventory_units:await snapshot()})
      const findings=Object.fromEntries(rows.map(row=>[row.id,{condition:row.id===equipment[0].id?'damaged':'good',notes:'Inspected physically'}]))
      return checkSubmission(rows,findings)
    }
    await login('operator')
    const initial=await payload()
    const save=(lab=science,selectedShelf=shelf,items=initial)=>scalar('select inventory_save_shelf_check($1,$2,$3::jsonb,$4) as id',[lab,selectedShelf,JSON.stringify(items),'Weekly inspection'])
    await assert.rejects(save(science,foreignShelf),/Shelf not found/)
    await assert.rejects(save(science,shelf,initial.slice(1)),/not reviewed/)
    await assert.rejects(save(science,shelf,[...initial,initial[0]]),/only once/)
    await assert.rejects(save(science,shelf,initial.map((row,index)=>index===0?{...row,condition:''}:row)),/Good or Damaged/)
    const borrowedPayload=[...initial.slice(1),{unit_id:equipment[2].id,condition:'damaged',expected_status:'borrowed',expected_condition:'good',expected_quantity:1}]
    await assert.rejects(save(science,shelf,borrowedPayload),/changed|borrowed/)
    for(const name of ['system','other','disabled']){await login(name);await assert.rejects(save(),/Only assigned/)}
    await login('admin')
    const checkId=await save()
    const after=await snapshot()
    assert.equal(after.find(row=>row.id===equipment[0].id).status,'under_maintenance')
    assert.equal(after.find(row=>row.id===equipment[1].id).status,'available')
    assert.equal(after.find(row=>row.id===equipment[2].id).status,'borrowed')
    assert.equal(after.find(row=>row.id===equipment[3].id).status,'missing')
    const consumables=after.filter(row=>row.inventory_kind==='consumable')
    assert.equal(consumables.length,1);assert.equal(consumables[0].quantity,10);assert.equal(consumables[0].condition,'good')
    const check=(await query('select * from inventory_checks where id=$1',[checkId])).rows[0]
    assert.equal(check.performed_by_user_id,ids.admin);assert.equal(check.laboratory_id,science)
    assert.equal(check.expected_units,14);assert.equal(check.present_units,12);assert.equal(check.damaged_units,1);assert.equal(check.skipped_units,2)
    assert.equal(check.item_results.length,6)
    assert.equal(check.item_results.filter(row=>row.skipped).length,2)
    assert.equal((await query(`select * from stock_movements where reason='Inventory check'`)).rows.length,1)
    await assert.rejects(query(`insert into inventory_checks(shelf_id,performed_by) values($1,'Fake')`,[shelf]),/permission denied/)
    await assert.rejects(query(`update inventory_checks set damaged_units=0 where id=$1`,[checkId]),/permission denied/)
    await login('other');assert.equal((await query('select * from inventory_checks')).rows.length,0)
    await login('system');assert.equal((await query('select * from inventory_checks')).rows.length,0)
    await login('operator')
    const stale=await payload()
    await query(`select inventory_receive_categorized_items($1,'Gloves','consumable',1,'')`,[shelf])
    await assert.rejects(save(science,shelf,stale),/item changed/)
    assert.equal((await query('select * from inventory_checks')).rows.length,1)
    assert.equal((await snapshot()).find(row=>row.id===equipment[0].id).condition,'damaged')
    await query(`select inventory_delete_unit($1,'Disposed after inspection')`,[equipment[1].id])
    assert.ok((await query('select item_results from inventory_checks where id=$1',[checkId])).rows[0].item_results.some(row=>row.unit_id===equipment[1].id))
    const revised=await payload();await save(science,shelf,revised)
    await db.exec('reset role');await db.exec(await file('inventory_checks.sql'))
    assert.equal((await query('select * from inventory_checks')).rows.length,2)
    await query('delete from laboratory_memberships where user_id=$1',[ids.operator])
    await login('operator');await assert.rejects(save(science,shelf,revised),/Only assigned/)
    assert.equal((await query('select * from inventory_checks')).rows.length,0)
    await db.exec('reset role;set role anon')
    await assert.rejects(save(),/permission denied/)
    await assert.rejects(query('select * from inventory_checks'),/permission denied/)
  } finally {await db.close()}
})
