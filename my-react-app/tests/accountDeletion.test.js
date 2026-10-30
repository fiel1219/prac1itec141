import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('account deletion is admin-only, atomic, protects admins, revokes access and preserves inventory history', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('email',current_setting('test.email',true))$$;
      grant usage on schema public,auth to anon,authenticated;
      create table auth.users(id uuid primary key default gen_random_uuid(),email text unique);
      create table auth.identities(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);
      create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);`)
    const file = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;', ''))
    for (const name of ['user_accounts.sql','inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql','inventory_permanent_delete.sql','inventory_shelf_items.sql','inventory_item_descriptions.sql','inventory_item_categories.sql','inventory_consumable_quantities.sql','inventory_consumable_actions.sql','inventory_bulk_actions.sql','inventory_laboratories.sql','user_laboratories.sql','inventory_checks.sql','security_hardening.sql','account_deletion.sql']) await db.exec(await file(name))
    const migration = await file('account_deletion.sql')
    await db.exec(migration) // Rerunning is safe.
    const query = (sql, args = []) => db.query(sql, args)
    const scalar = async (sql, args = []) => (await query(sql, args)).rows[0].id
    const profiles = {}, logins = {}
    for (const [name, role, status] of [['system','Admin','active'],['operator','Operator','active'],['disabled','Admin','disabled'],['other','Operator','active']]) {
      profiles[name] = await scalar(`insert into user_accounts(full_name,email,role,status) values($1,$2,$3,$4) returning id`, [name,`${name}@example.test`,role,status])
      logins[name] = await scalar(`insert into auth.users(email) values($1) returning id`, [`${name}@example.test`])
      await query('insert into auth.identities(user_id) values($1)', [logins[name]])
      await query('insert into auth.sessions(user_id) values($1)', [logins[name]])
    }
    const login = async name => {
      await db.exec('reset role; set role authenticated')
      await query(`select set_config('test.uid',$1,false),set_config('test.email',$2,false)`, [logins[name],`${name}@example.test`])
    }
    const remove = (name, email = `${name}@example.test`) => query('select inventory_delete_user_account($1,$2)', [profiles[name],email])
    const lab = await scalar('select id from laboratories limit 1')
    await login('system')
    await query(`select inventory_save_user_assignments($1,'Operator',$2::jsonb)`, [profiles.operator,JSON.stringify([{laboratory_id:lab,role:'Laboratory Admin'}])])
    await assert.rejects(remove('system'), /at least one active System Admin/)
    await assert.rejects(remove('operator','wrong@example.test'), /email to confirm/)
    await assert.rejects(remove('operator',null), /email to confirm/)
    await assert.rejects(query('select inventory_delete_user_account(gen_random_uuid(),$1)', ['unknown@example.test']), /User not found/)
    await assert.rejects(query('delete from user_accounts where id=$1', [profiles.operator]), /permission denied/)
    await assert.rejects(query('delete from auth.users where id=$1', [logins.operator]), /permission denied/)

    await login('operator') // Even a Laboratory Admin cannot delete accounts.
    await assert.rejects(remove('other'), /Only a System Admin/)
    const shelf = await scalar(`select inventory_save_laboratory_shelf($1,null,'A-01','Storage','') as id`, [lab])
    await query(`select inventory_receive_categorized_items($1,'Monitor','equipment',1,'')`, [shelf])
    const unit = (await query('select * from inventory_units where shelf_id=$1', [shelf])).rows[0]
    await query(`select inventory_save_shelf_check($1,$2,$3::jsonb,'Routine check')`, [lab,shelf,JSON.stringify([{unit_id:unit.id,condition:'good',expected_status:unit.status,expected_condition:unit.condition,expected_quantity:1}])])
    const borrower = await scalar(`insert into borrowers(name,identity_number) values('Student','S-01') returning id`)
    await query('select inventory_checkout($1,$2,current_date+1)', [unit.id,borrower])
    const history = {}
    for (const table of ['shelves','inventory_units','borrowers','transactions','stock_movements','inventory_checks']) history[table] = (await query(`select * from ${table} order by id`)).rows
    await login('disabled'); await assert.rejects(remove('operator'), /Only a System Admin/)
    await db.exec('reset role; set role anon')
    await assert.rejects(remove('operator'), /permission denied/)

    await db.exec('reset role')
    await query(`insert into user_accounts(full_name,email,role) values('Duplicate','OPERATOR@example.test','Operator')`)
    await login('system'); await assert.rejects(remove('operator'), /duplicate profiles/)
    await db.exec(`reset role; delete from user_accounts where email='OPERATOR@example.test'`)
    await query(`insert into auth.users(email) values('OPERATOR@example.test')`)
    await login('system'); await assert.rejects(remove('operator'), /Multiple sign-in accounts/)
    await db.exec(`reset role; delete from auth.users where email='OPERATOR@example.test'`)
    await query(`insert into account_approvals(full_name,email,status) values('operator','operator@example.test','approved')`)
    await db.exec(`create function public.fail_account_delete() returns trigger language plpgsql as $$begin raise exception 'Simulated write failure'; end$$;
      create trigger fail_account_delete before delete on user_accounts for each row execute function public.fail_account_delete();`)
    await login('system')
    await assert.rejects(remove('operator'), /Simulated write failure/)
    await db.exec('reset role')
    assert.equal((await query('select * from auth.users where id=$1', [logins.operator])).rows.length, 1)
    assert.equal((await query('select * from auth.identities where user_id=$1', [logins.operator])).rows.length, 1)
    assert.equal((await query('select * from auth.sessions where user_id=$1', [logins.operator])).rows.length, 1)
    assert.equal((await query('select * from laboratory_memberships where user_id=$1', [profiles.operator])).rows.length, 1)
    assert.equal((await query(`select * from account_approvals where email='operator@example.test'`)).rows.length, 1)
    await db.exec('drop trigger fail_account_delete on user_accounts')

    // A dependent object must block the entire operation, including the profile.
    await db.exec('create table owned_records(owner_id uuid references auth.users(id))')
    await query('insert into owned_records values($1)', [logins.operator])
    await login('system'); await assert.rejects(remove('operator'), /dependent records/)
    await db.exec('reset role; drop table owned_records')
    await login('system'); await remove('operator','  OPERATOR@example.test  ')
    await db.exec('reset role')
    for (const table of ['auth.users','auth.identities','auth.sessions']) {
      assert.equal((await query(`select * from ${table} where ${table === 'auth.users' ? 'id' : 'user_id'}=$1`, [logins.operator])).rows.length, 0)
    }
    assert.equal((await query('select * from user_accounts where id=$1', [profiles.operator])).rows.length, 0)
    assert.equal((await query('select * from laboratory_memberships where user_id=$1', [profiles.operator])).rows.length, 0)
    assert.equal((await query(`select * from account_approvals where email='operator@example.test'`)).rows.length, 0)
    for (const table of Object.keys(history)) assert.deepEqual((await query(`select * from ${table} order by id`)).rows, history[table])
    // A previously issued JWT still cannot access data after the profile is gone.
    await login('operator')
    for (const table of ['shelves','inventory_units','borrowers','transactions','stock_movements','inventory_checks']) assert.equal((await query(`select * from ${table}`)).rows.length, 0)
    await assert.rejects(remove('other'), /Only a System Admin/)

    await login('system'); await remove('disabled') // A disabled admin is deletable.
    await db.exec('reset role')
    profiles.orphan = await scalar(`insert into user_accounts(full_name,email,role) values('Orphan','orphan@example.test','Operator') returning id`)
    profiles.second = await scalar(`insert into user_accounts(full_name,email,role) values('Second','second@example.test','Admin') returning id`)
    await login('system'); await assert.rejects(remove('system'), /own signed-in account/)
    await remove('second'); await remove('orphan')
    await assert.rejects(remove('orphan'), /User not found/)
    await assert.rejects(remove('system'), /at least one active System Admin/)
    await db.exec('reset role')
    assert.equal((await query(`select * from user_accounts where role='Admin' and status='active'`)).rows.length, 1)
    assert.equal((await query('select * from auth.users where id=$1', [logins.other])).rows.length, 1)
  } finally { await db.close() }
})
