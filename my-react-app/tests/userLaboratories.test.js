import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { assignedLaboratories, resolveAssignedLaboratory, filterUsers, loadUserLaboratories, userRoleLabel } from '../src/lib/userLaboratories.js'

test('System Admins access all laboratories while other active users require valid assignments', () => {
  const laboratories=[{id:'science',name:'Science'},{id:'computer',name:'Computer'},{id:'chemistry',name:'Chemistry'}]
  const memberships=[
    {user_id:'u',laboratory_id:'computer',role:'Laboratory Admin'},
    {user_id:'u',laboratory_id:'chemistry',role:'Laboratory Operator'},
    {user_id:'someone-else',laboratory_id:'science',role:'Laboratory Operator'},
  ]
  const user={id:'u',status:'active',role:'Operator'}
  const accessible=assignedLaboratories(laboratories,user,memberships)
  assert.deepEqual(accessible.map(lab=>lab.id),['computer','chemistry'])
  assert.equal(resolveAssignedLaboratory(accessible,'science'),'computer')
  assert.equal(resolveAssignedLaboratory(accessible,'chemistry'),'chemistry')
  assert.equal(resolveAssignedLaboratory(accessible,''),'computer')
  assert.equal(resolveAssignedLaboratory([],'science'),'')
  assert.deepEqual(assignedLaboratories(laboratories,{...user,role:'Admin'},[]),laboratories)
  assert.deepEqual(assignedLaboratories(laboratories,{...user,role:'Admin'},memberships),laboratories)
  assert.deepEqual(assignedLaboratories(laboratories,{...user,role:'Admin',status:'disabled'},memberships),[])
  assert.deepEqual(assignedLaboratories(laboratories,user,[]),[])
  assert.deepEqual(assignedLaboratories(laboratories,{...user,status:'disabled'},memberships),[])
  assert.deepEqual(assignedLaboratories(laboratories,null,memberships),[])
  assert.deepEqual(assignedLaboratories(laboratories,user,[{user_id:'u',laboratory_id:'science',role:'Unknown'}]),[])
  assert.deepEqual(assignedLaboratories(laboratories,user,memberships.slice(1)).map(lab=>lab.id),['chemistry'])
})

test('user filters preserve all accounts and match laboratory and role on the same assignment', () => {
  const users = [{ id:'a', full_name:'Maria', email:'maria@example.test', role:'Operator',status:'active' }, { id:'b', full_name:'John', email:'john@example.test', role:'Admin',status:'active' }, { id:'c', full_name:'Ana', email:'ana@example.test', role:'Operator',status:'active' }]
  const memberships = [{ user_id:'a', laboratory_id:'computer', role:'Laboratory Admin' }, { user_id:'a', laboratory_id:'chemistry', role:'Laboratory Operator' }]
  const filter = (search='', role='All', lab='') => filterUsers(users, memberships, search, role, lab)
  assert.deepEqual(filter('MARIA').map(row => row.id), ['a'])
  assert.equal(filter().length, 3) // Clearing search restores the original data.
  assert.equal(users.length, 3)
  assert.equal(filter('', 'Laboratory Admin', 'chemistry').length, 0)
  assert.deepEqual(filter('', 'Laboratory Operator', 'chemistry').map(row => row.id), ['a'])
  assert.deepEqual(filter('', 'System Admin').map(row => row.id), ['b'])
  assert.deepEqual(filter('', 'System Admin', 'chemistry').map(row => row.id), ['b'])
  assert.deepEqual(filter('', 'All', 'chemistry').map(row => row.id), ['a','b'])
  assert.deepEqual(filter('', 'Unassigned').map(row => row.id), ['c'])
  assert.equal(userRoleLabel(users[0], memberships, 'computer'), 'Laboratory Admin')
  assert.equal(userRoleLabel(users[0], memberships, 'chemistry'), 'Laboratory Operator')
  assert.equal(userRoleLabel(users[1], memberships, 'chemistry'), 'System Admin')
  assert.equal(userRoleLabel(users[2], memberships, 'computer'), 'No laboratory assignment')
})

test('membership loading paginates, scopes the signed-in user and distinguishes missing setup from access failures', async () => {
  let ranges = [], scoped = []
  const client = result => ({ from(table) {
    assert.equal(table, 'laboratory_memberships')
    return { select() { return this }, order() { return this }, eq(column, value) { scoped.push([column, value]); return this }, range(start, end) { ranges.push([start, end]); return Promise.resolve(result(start)) } }
  } })
  const rows = Array.from({length:501}, (_, id) => ({user_id:'u', laboratory_id:String(id), role:'Laboratory Admin'}))
  const loaded = await loadUserLaboratories(client(start => ({data:rows.slice(start, start+500)})), 'u')
  assert.equal(loaded.data.length, 501)
  assert.deepEqual(ranges, [[0,499],[500,999]])
  assert.deepEqual(scoped, [['user_id','u'],['user_id','u']])
  assert.equal((await loadUserLaboratories(client(() => ({error:{code:'42P01'}})))).setupRequired, true)
  const error = {code:'42501', message:'Permission denied'}
  assert.equal((await loadUserLaboratories(client(() => ({error})))).error, error)
})

test('laboratory assignments save atomically, enforce system administration and protect the last active System Admin', async () => {
  const db = new PGlite()
  const admin = '11111111-1111-4111-8111-111111111111', operator = '22222222-2222-4222-8222-222222222222'
  const lab1 = '33333333-3333-4333-8333-333333333333', lab2 = '44444444-4444-4444-8444-444444444444'
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select jsonb_build_object('email',current_setting('test.email',true)) $$;
      grant usage on schema public,auth to anon,authenticated;
      create type public.user_role as enum ('Admin','Operator');
      create table public.user_accounts(id uuid primary key, full_name text, email text unique, role public.user_role, status text default 'active');
      create table public.laboratories(id uuid primary key, name text);
      alter table public.user_accounts enable row level security;
      grant select,insert,update,delete on public.user_accounts to authenticated;
      grant select on public.laboratories to authenticated;
      create policy prototype on public.user_accounts for all to authenticated using(true) with check(true);
      insert into public.user_accounts values ('${admin}','System','admin@example.test','Admin','active'), ('${operator}','Operator','operator@example.test','Operator','active');
      insert into public.laboratories values ('${lab1}','Computer Lab 1'), ('${lab2}','Chemistry');`)
    const sql = await readFile(new URL('../supabase/user_laboratories.sql', import.meta.url),'utf8')
    await db.exec(sql); await db.exec(sql)
    const login = async (id, email) => {
      await db.exec('reset role; set role authenticated')
      await db.query(`select set_config('test.uid',$1,false),set_config('test.email',$2,false)`,[id,email])
    }
    const save = (id, systemRole, assignments) => db.query('select public.inventory_save_user_assignments($1,$2,$3::jsonb)', [id,systemRole,JSON.stringify(assignments)])
    const first = {laboratory_id:lab1, role:'Laboratory Admin'}, second = {laboratory_id:lab2, role:'Laboratory Operator'}
    await login(admin,'admin@example.test')
    await save(operator, 'Operator', [first,second])
    assert.equal((await db.query('select * from laboratory_memberships')).rows.length, 2)
    await assert.rejects(save(operator, 'Admin', [first,first]), /only once/)
    await assert.rejects(save(operator, 'Admin', [{laboratory_id:lab1,role:'Admin'}]), /valid laboratory role/)
    await assert.rejects(save(operator, 'Admin', [{laboratory_id:admin,role:'Laboratory Admin'}]), /Laboratory not found/)
    assert.equal((await db.query('select role from user_accounts where id=$1',[operator])).rows[0].role, 'Operator')
    assert.equal((await db.query('select * from laboratory_memberships')).rows.length, 2)
    await assert.rejects(save(admin, 'Operator', []), /at least one active System Admin/)
    await login(operator, 'operator@example.test')
    assert.equal((await db.query('select * from laboratory_memberships')).rows.length, 2)
    await assert.rejects(save(operator, 'Admin', [first]), /Only a System Admin/)
    await assert.rejects(db.query(`update user_accounts set role='Admin' where id=$1`,[operator]), /permission denied/)
    await assert.rejects(db.query('delete from user_accounts where id=$1',[admin]), /permission denied/)
    await assert.rejects(db.query(`insert into user_accounts(id,email,role) values(gen_random_uuid(),'attacker@example.test','Admin')`), /row-level security/)
    await assert.rejects(db.query('delete from laboratory_memberships where user_id=$1',[operator]), /permission denied/)
    await db.exec(`reset role; insert into user_accounts values ('55555555-5555-4555-8555-555555555555','Other','other@example.test','Operator','active')`)
    await login('55555555-5555-4555-8555-555555555555', 'other@example.test')
    assert.equal((await db.query('select * from laboratory_memberships')).rows.length, 0)
    await login(admin,'admin@example.test')
    await save(operator,'Admin',[second])
    await save(admin,'Operator',[first]) // A second System Admin makes demotion safe.
    await assert.rejects(save(operator,'Operator',[]), /Only a System Admin/)
    await login(operator,'operator@example.test')
    await save(admin,'Operator',[]) // Removing an assignment really deletes it.
    assert.equal((await db.query('select * from laboratory_memberships where user_id=$1',[admin])).rows.length, 0)
    await db.exec('reset role'); await db.exec(sql)
    assert.equal((await db.query('select * from laboratory_memberships')).rows.length, 1)
    await db.exec('set role anon')
    await assert.rejects(save(operator,'Admin',[]), /permission denied/)
  } finally { await db.close() }
})
