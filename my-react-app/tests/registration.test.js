import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { registerAccount } from '../src/lib/registration.js'

test('signup waits for atomic registration and sends normalized identity metadata', async () => {
  const calls = []
  const client = {
    rpc: async name => { calls.push(name); return { data: true } },
    auth: {
      signUp: async input => { calls.push(input); return { data: { session: {} } } },
      signOut: async () => { calls.push('signOut'); return {} },
    },
  }
  const input = { fullName: ' Test User ', email: ' Test@Example.test ', password: 'example-password' }
  await registerAccount(client, input)
  assert.deepEqual(calls, ['inventory_registration_ready', {
    email: 'test@example.test', password: input.password, options: { data: { full_name: 'Test User' } },
  }, 'signOut'])
  for (const setupResult of [{ data: false }, { error: { code: 'PGRST202' } }, { error: new Error('Network unavailable') }]) {
    client.rpc = async () => setupResult
    client.auth.signUp = () => assert.fail('An unready backend must not create an Auth user')
    await assert.rejects(registerAccount(client, input), /system update|Network unavailable/)
  }
})

test('signup failures remain retryable and confirmation-required signup needs no browser approval insert', async () => {
  let fail = true, attempts = 0
  const client = {
    rpc: async () => ({ data: true }),
    auth: {
      signUp: async () => { attempts++; return fail ? { error: new Error('Database error saving new user') } : { data: { session: null } } },
      signOut: () => assert.fail('There is no session to sign out'),
    },
    from: () => assert.fail('Registration must not separately write an approval request'),
  }
  const input = { fullName: 'Test User', email: 'test@example.test', password: 'example-password' }
  await assert.rejects(registerAccount(client, input), /Database error/)
  fail = false
  await registerAccount(client, input)
  assert.equal(attempts, 2)
})

test('Auth registration is atomic, repairs orphan requests, preserves reviewed accounts and prevents role injection', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin;
      create schema auth;
      create type public.account_status as enum ('active', 'disabled');
      create table auth.users(id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb);
      grant usage on schema auth to supabase_auth_admin;
      grant insert, select on auth.users to supabase_auth_admin;`)
    const file = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8')
    await db.exec(await file('user_accounts.sql'))
    await db.exec(`insert into user_accounts(full_name,email,role) values('Admin','admin@example.test','Admin');
      insert into account_approvals(full_name,email,status,requested_role) values
        ('Reviewed','reviewed@example.test','rejected','Admin'),('Existing','PENDING@example.test','pending','Operator');
      insert into auth.users(email,raw_user_meta_data) values
        ('orphan@example.test','{"full_name":"Recovered User"}'),('nameless@example.test','{}'),
        ('admin@example.test','{}'),('reviewed@example.test','{}'),('pending@example.test','{}'),(null,'{}');`)
    const migration = await file('atomic_registration.sql')
    await db.exec(migration)
    const rows = async (sql, args = []) => (await db.query(sql, args)).rows
    assert.equal((await rows('select * from account_approvals')).length, 4)
    assert.equal((await rows("select full_name from account_approvals where email='orphan@example.test'"))[0].full_name, 'Recovered User')
    assert.equal((await rows("select full_name from account_approvals where email='nameless@example.test'"))[0].full_name, 'nameless@example.test')
    assert.equal((await rows("select status from account_approvals where email='reviewed@example.test'"))[0].status, 'rejected')
    assert.equal((await rows("select role from user_accounts where email='admin@example.test'"))[0].role, 'Admin')
    await db.exec(migration)
    assert.equal((await rows('select * from account_approvals')).length, 4)
    await db.exec('set role anon')
    assert.equal((await rows('select inventory_registration_ready() as ready'))[0].ready, true)
    await assert.rejects(db.exec("insert into account_approvals(full_name,email) values('Forged','forged@example.test')"), /permission denied/)
    await assert.rejects(db.exec("select inventory_create_registration_request('forged@example.test','Forged')"), /permission denied/)
    await db.exec('reset role; set role authenticated')
    await assert.rejects(db.exec("insert into account_approvals(full_name,email) values('Forged','forged@example.test')"), /permission denied/)
    await db.exec('reset role; set role supabase_auth_admin')
    await db.exec(`insert into auth.users(email,raw_user_meta_data) values('NEW@example.test','{"full_name":" New User ","role":"Admin","status":"approved"}')`)
    await db.exec('reset role')
    const request = (await rows("select * from account_approvals where email='new@example.test'"))[0]
    assert.equal(request.full_name, 'New User')
    assert.equal(request.requested_role, 'Operator')
    assert.equal(request.status, 'pending')
    assert.equal((await rows("select * from user_accounts where email='new@example.test'")).length, 0)
    // A failed approval write rolls back the Auth user too, making retry safe.
    await db.exec(`create function public.fail_registration() returns trigger language plpgsql as $$begin raise exception 'Request save failed'; end$$;
      create trigger fail_registration before insert on account_approvals for each row execute function public.fail_registration();
      set role supabase_auth_admin;`)
    await assert.rejects(db.exec("insert into auth.users(email) values('retry@example.test')"), /Request save failed/)
    await db.exec('reset role')
    assert.equal((await rows("select * from auth.users where email='retry@example.test'")).length, 0)
    assert.equal((await rows("select * from account_approvals where email='retry@example.test'")).length, 0)
    await db.exec('drop trigger fail_registration on account_approvals; set role supabase_auth_admin')
    await db.exec("insert into auth.users(email) values('retry@example.test')")
    await db.exec('reset role')
    assert.equal((await rows("select * from auth.users where email='retry@example.test'")).length, 1)
    assert.equal((await rows("select * from account_approvals where email='retry@example.test'")).length, 1)
    await db.exec('alter table auth.users disable trigger inventoscan_registration_request; set role anon')
    assert.equal((await rows('select inventory_registration_ready() as ready'))[0].ready, false)
  } finally { await db.close() }
})
