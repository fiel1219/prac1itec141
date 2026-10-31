import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { checkSubmission, countedQuantity, inspectionItems, inspectionResultText, isInspectionReviewed } from '../src/lib/inventoryChecks.js'

test('equipment requires condition findings while consumables require explicit, valid quantity findings', () => {
  const equipment = { id:'e', inventory_kind:'equipment', check_quantity:1 }
  const stock = { id:'s', inventory_kind:'consumable', check_quantity:50 }
  assert.equal(isInspectionReviewed(equipment,{condition:'damaged'}),true)
  assert.equal(isInspectionReviewed(equipment,{count_result:'matches'}),false)
  assert.equal(isInspectionReviewed(stock,{condition:'good'}),false)
  assert.equal(isInspectionReviewed(stock,{count_result:'matches'}),true)
  assert.equal(isInspectionReviewed(stock,{count_result:'different',actual_quantity:'40'}),true)
  assert.equal(isInspectionReviewed(stock,{count_result:'different',actual_quantity:0}),true)
  assert.equal(isInspectionReviewed(stock,{count_result:'different',actual_quantity:55}),true)
  for (const actual_quantity of ['',null,-1,1.5,2147483648,'abc',50]) {
    assert.equal(isInspectionReviewed(stock,{count_result:'different',actual_quantity}),false)
  }
  const emptyStock = { ...stock, check_quantity:0 }
  assert.equal(isInspectionReviewed(emptyStock,{count_result:'matches'}),true)
  assert.equal(isInspectionReviewed(emptyStock,{count_result:'different',actual_quantity:3}),true)
  assert.equal(countedQuantity(stock,{count_result:'matches',actual_quantity:40}),50)
  const submission = checkSubmission([equipment,stock], {e:{condition:'good'},s:{count_result:'different',actual_quantity:'40',notes:' Counted twice '}})
  assert.equal(submission[1].actual_quantity,40)
  assert.equal(submission[1].expected_quantity,50)
  assert.equal(submission[1].expected_inventory_kind,'consumable')
  assert.equal(submission[1].notes,'Counted twice')
  assert.equal(submission[0].actual_quantity,undefined)
})

test('inspection history distinguishes count differences from equipment and legacy condition findings', () => {
  assert.equal(inspectionResultText({inventory_kind:'consumable',count_result:'different',expected_quantity:50,actual_quantity:40}), 'Recorded 50 · Counted 40 · 10 short')
  assert.equal(inspectionResultText({inventory_kind:'consumable',count_result:'different',expected_quantity:10,actual_quantity:15}), 'Recorded 10 · Counted 15 · 5 extra')
  assert.equal(inspectionResultText({inventory_kind:'consumable',count_result:'matches',expected_quantity:0,actual_quantity:0}), 'Recorded 0 · Counted 0 · Matches record')
  assert.equal(inspectionResultText({inventory_kind:'consumable',condition:'damaged',quantity:50}), 'Damaged · quantity 50')
  assert.equal(inspectionResultText({inventory_kind:'equipment',condition:'good',quantity:1}), 'Good · quantity 1')
  assert.match(inspectionResultText({skipped:true,previous_status:'borrowed',quantity:1}), /Skipped \(borrowed\)/)
})

test('categorized checks preserve consumable stock, audit shortages and excesses, update equipment, and enforce permissions and atomicity', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('email',current_setting('test.email',true))$$;
      grant usage on schema public,auth to anon,authenticated;`)
    const file = name => readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    for (const name of ['user_accounts.sql','inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql','inventory_consumable_quantities.sql','inventory_consumable_actions.sql','inventory_bulk_actions.sql','inventory_laboratories.sql','user_laboratories.sql','inventory_checks.sql','security_hardening.sql','system_admin_laboratory_access.sql']) await db.exec(await file(name))
    const query = (sql,args=[]) => db.query(sql,args)
    const scalar = async (sql,args=[]) => (await query(sql,args)).rows[0].id
    const ids = {}
    for (const name of ['system','admin','operator','other','disabled']) ids[name] = await scalar(`insert into user_accounts(full_name,email,role,status) values($1,$2,$3,$4) returning id`,[name,`${name}@example.test`,['system','disabled'].includes(name)?'Admin':'Operator',name==='disabled'?'disabled':'active'])
    const login = async name => {
      await db.exec('reset role;set role authenticated')
      await query(`select set_config('test.uid',$1,false),set_config('test.email',$2,false)`,[ids[name],`${name}@example.test`])
    }
    const lab = await scalar('select id from laboratories limit 1')
    await login('system')
    const otherLab = await scalar(`select inventory_save_laboratory(null,'Chemistry','') as id`)
    for (const name of ['admin','operator','other']) await query(`select inventory_save_user_assignments($1,'Operator',$2::jsonb)`,[ids[name],JSON.stringify([{laboratory_id:name==='other'?otherLab:lab,role:name==='admin'?'Laboratory Admin':'Laboratory Operator'}])])
    const shelf = await scalar(`select inventory_save_laboratory_shelf($1,null,'A-01','Mixed shelf','') as id`,[lab])
    const foreignShelf = await scalar(`select inventory_save_laboratory_shelf($1,null,'B-01','Foreign shelf','') as id`,[otherLab])
    await query(`select inventory_receive_categorized_items($1,'Monitor','equipment',4,'')`,[shelf])
    for (const [name,quantity] of [['Cable ties',50],['Gloves',20],['Wipes',1]]) await query(`select inventory_receive_categorized_items($1,$2,'consumable',$3,'')`,[shelf,name,quantity])
    await query(`select inventory_item_category_stock_move($1,'out','Wipes','consumable',1,'Used')`,[shelf])
    await query(`select inventory_receive_categorized_items($1,'Foreign supplies','consumable',2,'')`,[foreignShelf])
    const equipment = (await query(`select * from inventory_units where shelf_id=$1 and inventory_kind='equipment' order by unit_number`,[shelf])).rows
    await query(`select inventory_update_unit($1,'under_maintenance','damaged','')`,[equipment[1].id])
    await query(`select inventory_update_unit($1,'missing','good','')`,[equipment[3].id])
    const ties = await scalar(`select id from inventory_units where shelf_id=$1 and item_name='Cable ties'`,[shelf])
    await query(`select inventory_update_unit($1,'under_maintenance','damaged','')`,[ties])
    const borrower = await scalar(`insert into borrowers(name,identity_number) values('Student','S-01') returning id`)
    await query('select inventory_checkout($1,$2,current_date+1)',[equipment[2].id,borrower])
    await db.exec('reset role')
    const legacy = await scalar(`insert into inventory_checks(shelf_id,performed_by,item_results) values($1,'Previous reviewer',$2::jsonb) returning id`,[shelf,JSON.stringify([{unit_id:ties,item_name:'Cable ties',inventory_kind:'consumable',quantity:50,condition:'damaged'}])])
    const migration = await file('inventory_check_quantities.sql')
    await db.exec(migration);await db.exec(migration)
    assert.equal((await query('select quantity_discrepancies from inventory_checks where id=$1',[legacy])).rows[0].quantity_discrepancies,0)
    const snapshot = async () => (await query('select * from inventory_units where shelf_id=$1 order by id',[shelf])).rows
    const payload = async () => {
      const items = inspectionItems({inventory_units:await snapshot()})
      const findings = Object.fromEntries(items.map(item=>[item.id,item.inventory_kind==='consumable'
        ? item.item_name==='Cable ties' ? {count_result:'different',actual_quantity:40,notes:'Ten short'}
          : item.item_name==='Gloves' ? {count_result:'different',actual_quantity:25} : {count_result:'matches'}
        : {condition:item.id===equipment[0].id?'damaged':'good'}]))
      return checkSubmission(items,findings)
    }
    await login('admin')
    const initial = await payload(), before = await snapshot()
    const stockBefore = before.filter(item=>item.inventory_kind==='consumable')
    const movementBefore = (await query('select * from stock_movements where unit_id in(select id from inventory_units where inventory_kind=\'consumable\') order by id')).rows
    const save = (items=initial,selectedLab=lab,selectedShelf=shelf) => scalar(`select inventory_save_categorized_shelf_check($1,$2,$3::jsonb,'Weekly check') as id`,[selectedLab,selectedShelf,JSON.stringify(items)])
    const alterItem = (id,patch) => initial.map(item=>item.unit_id===id?{...item,...patch}:item)
    assert.equal(initial.length,5) // Includes the zero-stock consumable; skips borrowed/missing equipment.
    for (const actual_quantity of [null,-1,1.5,2147483648]) await assert.rejects(save(alterItem(ties,{actual_quantity})),/whole-number actual quantity/)
    await assert.rejects(save(alterItem(ties,{count_result:'matches'})),/must agree/)
    await assert.rejects(save(alterItem(ties,{actual_quantity:50})),/must agree/)
    await assert.rejects(save(alterItem(ties,{count_result:''})),/every consumable/)
    await assert.rejects(save(alterItem(ties,{expected_quantity:51})),/item changed/)
    await assert.rejects(save(alterItem(ties,{expected_inventory_kind:'equipment'})),/item changed/)
    await assert.rejects(save(alterItem(equipment[0].id,{condition:'different'})),/every equipment/)
    await assert.rejects(save(initial.slice(1)),/not reviewed/)
    await assert.rejects(save([...initial,initial[0]]),/only once/)
    await assert.rejects(save(initial.map(item=>item.unit_id===equipment[0].id?{...item,unit_id:equipment[2].id}:item)),/item changed/)
    await assert.rejects(save(initial,lab,foreignShelf),/Shelf not found/)
    assert.deepEqual(await snapshot(),before)
    assert.equal((await query('select * from inventory_checks')).rows.length,1)
    const checkId = await save()
    const after = await snapshot()
    assert.deepEqual(after.filter(item=>item.inventory_kind==='consumable'),stockBefore)
    assert.deepEqual((await query('select * from stock_movements where unit_id in(select id from inventory_units where inventory_kind=\'consumable\') order by id')).rows,movementBefore)
    assert.equal(after.find(item=>item.id===equipment[0].id).status,'under_maintenance')
    assert.equal(after.find(item=>item.id===equipment[1].id).status,'available')
    assert.equal(after.find(item=>item.id===equipment[2].id).status,'borrowed')
    const check = (await query('select * from inventory_checks where id=$1',[checkId])).rows[0]
    assert.equal(check.result,'issues_found');assert.equal(check.quantity_discrepancies,2)
    assert.equal(check.expected_units,74);assert.equal(check.present_units,67)
    assert.equal(check.skipped_units,2);assert.equal(check.damaged_units,1)
    assert.equal(check.performed_by_user_id,ids.admin)
    const short = check.item_results.find(item=>item.unit_id===ties)
    assert.equal(short.expected_quantity,50);assert.equal(short.actual_quantity,40);assert.equal(short.quantity_difference,-10)
    assert.equal(short.condition,'damaged');assert.equal(short.previous_status,'under_maintenance')
    assert.equal(check.item_results.find(item=>item.item_name==='Gloves').quantity_difference,5)
    assert.equal(check.item_results.find(item=>item.item_name==='Wipes').actual_quantity,0)
    assert.equal(check.item_results.filter(item=>item.skipped).length,2)

    await login('other');await assert.rejects(save(),/Only assigned/)
    await login('disabled');await assert.rejects(save(),/Only assigned/)
    await db.exec('reset role;set role anon');await assert.rejects(save(),/permission denied/)
    await login('system') // No membership required; a different laboratory can be inspected.
    const foreignItems = inspectionItems({inventory_units:(await query('select * from inventory_units where shelf_id=$1',[foreignShelf])).rows})
    const foreignCheck = await save(checkSubmission(foreignItems,{[foreignItems[0].id]:{count_result:'different',actual_quantity:1}}),otherLab,foreignShelf)
    assert.equal((await query('select performed_by_user_id from inventory_checks where id=$1',[foreignCheck])).rows[0].performed_by_user_id,ids.system)
    assert.equal((await query('select quantity from inventory_units where id=$1',[foreignItems[0].id])).rows[0].quantity,2)
    await login('operator')
    const fresh = await payload()
    await query(`select inventory_receive_categorized_items($1,'Gloves','consumable',1,'')`,[shelf])
    await assert.rejects(save(fresh),/item changed/)

    // A failure at the final history write must roll back earlier equipment updates.
    await db.exec(`reset role;create function public.reject_categorized_check() returns trigger language plpgsql as $$begin raise exception 'Audit write failed';end$$;
      create trigger reject_categorized_check before insert on inventory_checks for each row execute function public.reject_categorized_check();`)
    await login('operator')
    const rollbackBefore = await snapshot()
    const rollbackPayload = (await payload()).map(item=>item.unit_id===equipment[0].id?{...item,condition:'good'}:item)
    await assert.rejects(save(rollbackPayload),/Audit write failed/)
    assert.deepEqual(await snapshot(),rollbackBefore)
    await db.exec('reset role;drop trigger reject_categorized_check on inventory_checks')
    await login('operator')
    const matchingItems = inspectionItems({inventory_units:await snapshot()})
    const matching = checkSubmission(matchingItems,Object.fromEntries(matchingItems.map(item=>[item.id,item.inventory_kind==='consumable'?{count_result:'matches'}:{condition:item.condition}])))
    const matchingCheck = await save(matching)
    const matched = (await query('select * from inventory_checks where id=$1',[matchingCheck])).rows[0]
    assert.equal(matched.quantity_discrepancies,0);assert.equal(matched.skipped_units,2)
    assert.equal(matched.item_results.find(item=>item.item_name==='Cable ties').condition,'damaged')
    await db.exec('reset role');await query('delete from laboratory_memberships where user_id=$1',[ids.operator])
    await login('operator');await assert.rejects(save(matching),/Only assigned/)
  } finally { await db.close() }
})
