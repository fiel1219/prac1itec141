import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

test('demo seed creates confirmed identities, hashed passwords, and app roles; reruns safely', async () => {
  const db = new PGlite({ extensions: { pgcrypto } })
  try {
    await db.exec(`
      create schema auth;
      create table auth.users (
        instance_id uuid, id uuid primary key, aud text, role text, email text unique,
        encrypted_password text, email_confirmed_at timestamptz,
        raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz,
        confirmation_token text, recovery_token text, email_change_token_new text,
        email_change text, email_change_token_current text, reauthentication_token text
      );
      create table auth.identities (
        id uuid primary key, user_id uuid references auth.users(id), provider_id text,
        identity_data jsonb, provider text, created_at timestamptz, updated_at timestamptz,
        unique(provider_id,provider)
      );
      create type public.user_role as enum ('Admin','Operator');
      create table public.user_accounts (
        id uuid primary key default gen_random_uuid(), full_name text, email text unique,
        role public.user_role, status text
      );
    `)
    const sql = await readFile(new URL('../supabase/demo_accounts.sql', import.meta.url), 'utf8')
    await db.exec(sql)
    const first = (await db.query('select id from auth.users order by email')).rows
    await db.exec(sql)
    assert.deepEqual((await db.query('select id from auth.users order by email')).rows, first)
    assert.equal((await db.query('select * from auth.identities')).rows.length, 2)
    const accounts = (await db.query(`select u.email,u.email_confirmed_at,a.role,a.status,
      u.encrypted_password = extensions.crypt(case a.role when 'Admin' then 'InventoAdmin2026!' else 'InventoOperator2026!' end,u.encrypted_password) as valid_password
      from auth.users u join public.user_accounts a on a.email=u.email order by u.email`)).rows
    assert.deepEqual(accounts.map(account => account.role), ['Admin','Operator'])
    for (const account of accounts) {
      assert.ok(account.email_confirmed_at)
      assert.equal(account.status, 'active')
      assert.equal(account.valid_password, true)
    }
    const source = await readFile(new URL('../src/AuthGate.jsx', import.meta.url), 'utf8')
    for (const account of accounts) assert.ok(source.includes(account.email))
    assert.ok(source.includes('InventoAdmin2026!') && source.includes('InventoOperator2026!'))
    await db.exec(`update auth.users set raw_user_meta_data='{}' where email='demo.admin@inventoscan.test'`)
    await assert.rejects(db.exec(sql), /non-demo user/)
    await db.exec('rollback')
    assert.equal((await db.query('select * from auth.users')).rows.length, 2)
  } finally { await db.close() }
})
