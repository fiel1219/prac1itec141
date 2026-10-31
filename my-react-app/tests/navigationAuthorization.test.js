import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('role upgrades enforce checks, daily operations and inventory management without changing laboratory scope', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('email',current_setting('test.email',true))$$;
      grant usage on schema public,auth to anon,authenticated;
      create table auth.users(id uuid primary key default gen_random_uuid(),email text unique,raw_user_meta_data jsonb);`)
    const file = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;', ''))
    for (const name of ['user_accounts.sql','inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql','inventory_consumable_quantities.sql','inventory_consumable_actions.sql','inventory_bulk_actions.sql','inventory_laboratories.sql','user_laboratories.sql','inventory_checks.sql','security_hardening.sql','account_deletion.sql','system_admin_laboratory_access.sql','inventory_check_quantities.sql','atomic_registration.sql']) await db.exec(await file(name))
    const query = (sql, args = []) => db.query(sql, args)
    const scalar = async (sql, args = []) => (await query(sql, args)).rows[0].id
    const users = {}
    for (const [name, role, status] of [['system','Admin','active'],['staff','Operator','active'],['unassigned','Operator','active'],['disabled','Operator','disabled']]) {
      users[name] = await scalar('insert into user_accounts(full_name,email,role,status) values($1,$2,$3,$4) returning id', [name,`${name}@example.test`,role,status])
    }
    const login = async name => {
      await db.exec('reset role; set role authenticated')
      await query("select set_config('test.uid',$1,false),set_config('test.email',$2,false)", [users[name],`${name}@example.test`])
    }
    const science = await scalar('select id from laboratories limit 1')
    await login('system')
    const computer = await scalar("select inventory_save_laboratory(null,'Computer','') as id")
    await query('select inventory_save_user_assignments($1,$2,$3::jsonb)', [users.staff,'Operator',JSON.stringify([
      {laboratory_id:science,role:'Laboratory Admin'}, {laboratory_id:computer,role:'Laboratory Operator'},
    ])])
    const scienceShelf = await scalar("select inventory_save_laboratory_shelf($1,null,'S-01','Science shelf','') as id", [science])
    const computerShelf = await scalar("select inventory_save_laboratory_shelf($1,null,'C-01','Computer shelf','') as id", [computer])
    for (const shelf of [scienceShelf, computerShelf]) {
      await query("select inventory_receive_categorized_items($1,'Monitor','equipment',2,'')", [shelf])
      await query("select inventory_receive_categorized_items($1,'Gloves','consumable',10,'')", [shelf])
    }
    const unitAt = shelf => scalar("select id from inventory_units where shelf_id=$1 and inventory_kind='equipment' order by unit_number limit 1", [shelf])
    const scienceUnit = await unitAt(scienceShelf), computerUnit = await unitAt(computerShelf)
    const borrower = await scalar("insert into borrowers(name,identity_number) values('Student','S-001') returning id")
    // Seed an open science loan using the old permissions, then upgrade.
    await query('select inventory_checkout($1,$2,current_date+1)', [scienceUnit,borrower])
    const scienceLoan = await scalar('select id from transactions where unit_id=$1', [scienceUnit])
    await db.exec('reset role')
    const counts = async () => (await query('select (select count(*) from inventory_units) as units,(select count(*) from transactions) as loans,(select count(*) from laboratory_memberships) as memberships')).rows
    const before = await counts()
    const migration = await file('role_navigation_access.sql')
    await db.exec(migration); await db.exec(migration)
    assert.deepEqual(await counts(), before)
    const canCheck = async lab => (await query('select inventory_can_check_laboratory($1) as allowed',[lab])).rows[0].allowed
    const canOperate = async lab => (await query('select inventory_can_operate_laboratory($1) as allowed',[lab])).rows[0].allowed
    const issue = (shelf, rpc = 'inventory_item_category_stock_move') => rpc === 'inventory_item_category_stock_move'
      ? query("select inventory_item_category_stock_move($1,'out','Gloves','consumable',2,'Class supplies')", [shelf])
      : query("select inventory_item_stock_move($1,'out','Gloves',2,'Class supplies')", [shelf])
    const check = async (lab, shelf) => {
      const units = (await query("select * from inventory_units where shelf_id=$1 and retired_at is null and status in ('available','under_maintenance') order by unit_number", [shelf])).rows
      return query('select inventory_save_categorized_shelf_check($1,$2,$3::jsonb,$4)', [lab,shelf,JSON.stringify(units.map(unit => ({
        unit_id:unit.id,expected_status:unit.status,expected_condition:unit.condition,expected_quantity:unit.quantity,
        expected_inventory_kind:unit.inventory_kind,...(unit.inventory_kind === 'consumable' ? {count_result:'matches',actual_quantity:unit.quantity} : {condition:'good'}),
      }))), 'Role check'])
    }

    await login('system')
    assert.equal((await query('select * from laboratories')).rows.length, 2)
    assert.equal((await query('select * from shelves')).rows.length, 2)
    assert.equal((await query('select * from transactions')).rows.length, 1)
    for (const lab of [science, computer]) { assert.equal(await canCheck(lab), false); assert.equal(await canOperate(lab), false) }
    await assert.rejects(check(science,scienceShelf), /Only assigned/)
    await assert.rejects(query('select inventory_checkout($1,$2,current_date+1)',[computerUnit,borrower]), /row-level security|permission/)
    await assert.rejects(query("select inventory_return($1,'good')",[scienceLoan]), /not found|permission/)
    await assert.rejects(issue(scienceShelf), /Laboratory Operator/)
    // Common inventory management and report reads remain available.
    await query("select inventory_receive_categorized_items($1,'Gloves','consumable',1,'')",[scienceShelf])
    assert.equal((await query('select * from inventory_units')).rows.length, 6)
    assert.equal((await query('select * from stock_movements')).rows.length > 0, true)

    await login('staff')
    assert.equal(await canCheck(science), true); assert.equal(await canOperate(science), false)
    assert.equal(await canCheck(computer), false); assert.equal(await canOperate(computer), true)
    await check(science,scienceShelf)
    assert.equal((await query('select * from inventory_checks')).rows.length, 1)
    await assert.rejects(check(computer,computerShelf), /Only assigned/)
    await assert.rejects(issue(scienceShelf), /Laboratory Operator/)
    await assert.rejects(issue(scienceShelf,'inventory_item_stock_move'), /Laboratory Operator/)
    await assert.rejects(query("select inventory_return($1,'good')",[scienceLoan]), /not found|permission/)
    await query('select inventory_checkout($1,$2,current_date+1)',[computerUnit,borrower])
    const computerLoan = await scalar('select id from transactions where unit_id=$1',[computerUnit])
    await issue(computerShelf)
    await query("select inventory_return($1,'good')",[computerLoan])
    assert.ok((await query('select returned_at from transactions where id=$1',[computerLoan])).rows[0].returned_at)
    assert.equal((await query("select quantity from inventory_units where shelf_id=$1 and item_name='Gloves'",[computerShelf])).rows[0].quantity, 8)
    assert.equal((await query('select * from transactions')).rows.length, 2) // Both assigned laboratories' records are readable.

    // Returning through a shelf or direct item-status update follows the same rule.
    await db.exec('reset role')
    await query('update transactions set returned_at=now() where id=$1',[scienceLoan])
    await login('system')
    await assert.rejects(query("select inventory_reconcile_return($1,'good','Physically returned')",[scienceUnit]), /Laboratory Operator/)
    await assert.rejects(query("update inventory_units set status='available' where id=$1",[scienceUnit]), /Laboratory Operator/)
    await login('staff')
    await assert.rejects(query("select inventory_reconcile_return($1,'good','Physically returned')",[scienceUnit]), /Laboratory Operator/)
    // Changing the science role to Operator grants daily operations and removes checks.
    await db.exec('reset role')
    await query("update laboratory_memberships set role='Laboratory Operator' where user_id=$1 and laboratory_id=$2",[users.staff,science])
    await login('staff')
    assert.equal(await canCheck(science), false); assert.equal(await canOperate(science), true)
    assert.equal((await query('select * from inventory_checks')).rows.length, 0)
    await query("select inventory_reconcile_return($1,'good','Physically returned')",[scienceUnit])
    // Deleting already-returned equipment is still a common inventory operation.
    await login('system')
    await query("select inventory_delete_unit($1,'Replaced equipment')",[computerUnit])
    assert.equal((await query('select * from transactions')).rows.length, 2)

    for (const name of ['unassigned','disabled']) {
      await login(name)
      assert.equal(await canCheck(science),false); assert.equal(await canOperate(science),false)
      await assert.rejects(issue(scienceShelf), /Laboratory Operator|matching laboratory role/)
      assert.equal((await query('select * from shelves')).rows.length,0)
    }
    // Upgrade to management-only inventory writes, with daily backup for Lab Admins.
    await login('system')
    const emptyShelf = await scalar("select inventory_save_laboratory_shelf($1,null,'C-EMPTY','Empty shelf','') as id",[computer])
    const foreignLab = await scalar("select inventory_save_laboratory(null,'Unassigned lab','') as id")
    const foreignShelf = await scalar("select inventory_save_laboratory_shelf($1,null,'F-01','Foreign shelf','') as id",[foreignLab])
    await query("select inventory_receive_categorized_items($1,'Monitor','equipment',1,'')",[foreignShelf])
    await query("select inventory_receive_categorized_items($1,'Gloves','consumable',10,'')",[foreignShelf])
    const foreignUnit = await unitAt(foreignShelf)
    await db.exec('reset role')
    await query("update laboratory_memberships set role='Laboratory Admin' where user_id=$1 and laboratory_id=$2",[users.staff,science])
    const beforeManagementUpgrade = await counts()
    const managementUpgrade = await file('inventory_management_access.sql')
    await db.exec(managementUpgrade); await db.exec(managementUpgrade)
    assert.deepEqual(await counts(),beforeManagementUpgrade)
    const canManage = async lab => (await query('select inventory_can_manage_laboratory($1) as allowed',[lab])).rows[0].allowed
    const snapshot = async () => {
      await db.exec('reset role')
      return (await query("select jsonb_build_object('shelves',(select jsonb_agg(s order by id) from shelves s),'units',(select jsonb_agg(u order by id) from inventory_units u),'movements',(select jsonb_agg(m order by id) from stock_movements m)) as data")).rows[0].data
    }
    await login('staff')
    assert.equal(await canManage(science),true); assert.equal(await canOperate(science),true); assert.equal(await canCheck(science),true)
    assert.equal(await canManage(computer),false); assert.equal(await canOperate(computer),true); assert.equal(await canCheck(computer),false)
    assert.equal(await canManage(foreignLab),false); assert.equal(await canOperate(foreignLab),false)
    await assert.rejects(query('select inventory_checkout($1,$2,current_date+1)',[foreignUnit,borrower]),/daily operations/)
    await assert.rejects(issue(foreignShelf),/daily operations/)
    const remainingComputerUnit = await unitAt(computerShelf)
    const priorInventory = await snapshot()
    await login('staff')
    // Direct writes cannot bypass the operator's read-only inventory access.
    assert.equal((await query("update shelves set name='Changed' where id=$1 returning id",[computerShelf])).rows.length,0)
    assert.equal((await query('delete from shelves where id=$1 returning id',[emptyShelf])).rows.length,0)
    assert.equal((await query("update inventory_units set condition='damaged' where id=$1 returning id",[remainingComputerUnit])).rows.length,0)
    assert.equal((await query('delete from inventory_units where id=$1 returning id',[remainingComputerUnit])).rows.length,0)
    await assert.rejects(query("insert into inventory_units(shelf_id,unit_number,item_name,inventory_kind) values($1,999,'Injected','equipment')",[computerShelf]),/row-level security/)
    await assert.rejects(query('update transactions set expected_return_at=current_date+2 where id=$1',[scienceLoan]),/permission denied/)
    // Single, bulk, receipt and shelf RPCs also refuse management in the Operator lab.
    for (const [sql,args] of [
      ["select inventory_receive_categorized_items($1,'Gloves','consumable',1,'')",[computerShelf]],
      ["select inventory_update_unit($1,'under_maintenance','damaged','Operator edit')",[remainingComputerUnit]],
      ["select inventory_save_laboratory_shelf($1,null,'C-NEW','Injected shelf','')",[computer]],
      ['select inventory_delete_shelf($1)',[emptyShelf]],
      ["select inventory_delete_unit($1,'Operator delete')",[remainingComputerUnit]],
      ["select inventory_move_unit($1,$2,'Operator move')",[remainingComputerUnit,emptyShelf]],
      ["select inventory_delete_consumable($1,'Gloves','Operator delete',8)",[computerShelf]],
      ["select inventory_move_consumable($1,'Gloves',$2,'Operator move',8)",[computerShelf,emptyShelf]],
      ["select inventory_bulk_item_action($1,'delete',$2::uuid[],'[]'::jsonb,null,'Operator bulk delete')",[computerShelf,[remainingComputerUnit]]],
      ["select inventory_move_unit($1,$2,'Manage role is required at both ends')",[scienceUnit,emptyShelf]],
    ]) await assert.rejects(query(sql,args),/manage|permission|shelf|found|update|exist/i)
    assert.deepEqual(await snapshot(),priorInventory)
    await login('staff')
    // Read-only inventory still supports complete borrowing, return and issue flows.
    await query('select inventory_checkout($1,$2,current_date+1)',[remainingComputerUnit,borrower])
    const operatorLoan = await scalar('select id from transactions where unit_id=$1',[remainingComputerUnit])
    await query("select inventory_return($1,'damaged')",[operatorLoan])
    assert.equal((await query('select status from inventory_units where id=$1',[remainingComputerUnit])).rows[0].status,'under_maintenance')
    await issue(computerShelf)
    assert.equal((await query("select quantity from inventory_units where shelf_id=$1 and item_name='Gloves'",[computerShelf])).rows[0].quantity,6)
    await issue(computerShelf,'inventory_item_stock_move')
    assert.equal((await query("select quantity from inventory_units where shelf_id=$1 and item_name='Gloves'",[computerShelf])).rows[0].quantity,4)
    await assert.rejects(query("select inventory_item_category_stock_move($1,'out','Monitor','equipment',1,'Bypass deletion')",[computerShelf]),/Only consumables/)
    // Laboratory Admins can manage their own laboratory and cover daily operations.
    await query("select inventory_receive_categorized_items($1,'Slides','consumable',3,'')",[scienceShelf])
    await query('select inventory_checkout($1,$2,current_date+1)',[scienceUnit,borrower])
    const adminLoan = await scalar('select id from transactions where unit_id=$1 and returned_at is null',[scienceUnit])
    await query("select inventory_return($1,'good')",[adminLoan])
    await check(science,scienceShelf)
    await query("select inventory_item_category_stock_move($1,'out','Slides','consumable',1,'Class supplies')",[scienceShelf])
    // System Admins retain management in every lab, with no daily-operation bypass.
    await login('system')
    assert.equal(await canManage(computer),true); assert.equal(await canOperate(computer),false)
    await query("select inventory_receive_categorized_items($1,'Wipes','consumable',2,'')",[computerShelf])
    await query("select inventory_update_unit($1,'available','good','Repaired')",[remainingComputerUnit])
    await query("select inventory_move_unit($1,$2,'System transfer')",[remainingComputerUnit,emptyShelf])
    await query("select inventory_delete_unit($1,'Replaced')",[remainingComputerUnit])
    await query('select inventory_delete_shelf($1)',[emptyShelf])
    await assert.rejects(issue(computerShelf),/daily operations/)
    await assert.rejects(query('select inventory_checkout($1,$2,current_date+1)',[scienceUnit,borrower]),/daily operations/)
    for (const name of ['unassigned','disabled']) {
      await login(name)
      assert.equal(await canManage(science),false); assert.equal(await canOperate(science),false)
      await assert.rejects(query('select inventory_checkout($1,$2,current_date+1)',[scienceUnit,borrower]),/daily operations/)
    }
    await db.exec('reset role; set role anon')
    await assert.rejects(query('select inventory_can_operate_laboratory($1)',[science]), /permission denied/)
  } finally { await db.close() }
})
