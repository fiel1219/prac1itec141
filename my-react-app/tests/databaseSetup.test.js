import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const file=name=>readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')

test('canonical setup supports registration and approvals without obsolete tables or seeded accounts', async()=>{
  const db=new PGlite()
  try{
    await db.exec('create role anon;create role authenticated;')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;',''))
    const setup=await file('user_accounts.sql')
    await db.exec(setup);await db.exec(setup)
    for(const name of ['admin_accounts','operator_accounts','activity_logs'])assert.equal((await db.query('select to_regclass($1) as name',[`public.${name}`])).rows[0].name,null)
    assert.equal((await db.query('select * from public.user_accounts')).rows.length,0)
    await db.exec(`set role anon;
      insert into public.account_approvals(full_name,email,requested_role) values('Student','student@example.test','Operator');
      reset role;`)
    assert.equal((await db.query('select requested_role from public.account_approvals')).rows[0].requested_role,'Operator')
    await db.exec(await file('seed.sql'))
    assert.ok((await db.query('select * from public.shelves')).rows.length>0)
    assert.ok((await db.query('select * from public.transactions')).rows.length>0)
    const saved=(await db.query('select count(*) as count from public.inventory_units')).rows[0].count
    await db.exec(await file('cleanup_legacy_tables.sql'))
    assert.equal((await db.query('select count(*) as count from public.inventory_units')).rows[0].count,saved)
  }finally{await db.close()}
})

test('legacy cleanup removes empty tables, keeps populated/dependent ones, and preserves existing approval roles',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create role anon;create role authenticated;
      create type public.account_status as enum('active','disabled');
      create type public.user_role as enum('Admin','Operator');
      create table public.account_approvals(id uuid primary key default gen_random_uuid(),full_name text,email text unique,
        assigned_role public.user_role,status text default 'pending',reviewed_by text,reviewed_at timestamptz,created_at timestamptz default now());
      insert into public.account_approvals(full_name,email,assigned_role) values('Pending admin','pending@example.test','Admin');
      create table public.admin_accounts(id integer);
      create view public.legacy_admin_view as select * from public.admin_accounts;
      create table public.operator_accounts(id integer);
      insert into public.operator_accounts values(1);
      create table public.activity_logs(id integer);`)
    const setup=await file('user_accounts.sql'),cleanup=await file('cleanup_legacy_tables.sql')
    await db.exec(setup)
    assert.equal((await db.query('select requested_role from public.account_approvals')).rows[0].requested_role,'Admin')
    await db.exec(`update public.account_approvals set requested_role='Operator'`)
    await db.exec(setup)
    assert.equal((await db.query('select requested_role from public.account_approvals')).rows[0].requested_role,'Operator')
    await db.exec(cleanup);await db.exec(cleanup)
    assert.equal((await db.query(`select to_regclass('public.activity_logs') as name`)).rows[0].name,null)
    assert.equal((await db.query(`select to_regclass('public.admin_accounts') as name`)).rows[0].name,'admin_accounts')
    assert.equal((await db.query('select * from public.operator_accounts')).rows[0].id,1)
    await db.exec('drop view public.legacy_admin_view');await db.exec(cleanup)
    assert.equal((await db.query(`select to_regclass('public.admin_accounts') as name`)).rows[0].name,null)
    assert.equal((await db.query('select * from public.operator_accounts')).rows[0].id,1)
    await db.exec(`drop table public.account_approvals;
      create table public.account_approvals(id uuid primary key default gen_random_uuid(),full_name text,email text unique,
        reviewed_role public.user_role,status text default 'pending',reviewed_by text,reviewed_at timestamptz,created_at timestamptz default now());
      insert into public.account_approvals(full_name,email,reviewed_role) values('Reviewed admin','reviewed@example.test','Admin');`)
    await db.exec(setup)
    assert.equal((await db.query('select requested_role from public.account_approvals')).rows[0].requested_role,'Admin')
  }finally{await db.close()}
})
