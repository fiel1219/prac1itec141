import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { loadTransactions } from '../src/lib/inventoryData.js'

test('Returns loads old active loans even when history exceeds the API page limit', async () => {
  const records = Array.from({ length: 1501 }, (_, index) => ({ id: index, returned_at: index === 1500 ? null : '2026-01-01' }))
  const client = { from() {
    let activeOnly = false, start = 0, end = 499
    const query = { select: () => query, order: () => query,
      range(from,to) { start=from; end=to; return query },
      is() { activeOnly=true; return query },
      then(resolve,reject) { return Promise.resolve({ data: records.filter(row => !activeOnly || row.returned_at === null).slice(start,end+1), error:null }).then(resolve,reject) },
    }; return query
  } }
  assert.equal((await loadTransactions(client)).data.length, 1501)
  assert.deepEqual((await loadTransactions(client,true)).data, [records[1500]])
})

test('return repair preserves real loans and lets confirmed returned units be removed', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"email":"operator@example.test"}'::jsonb $$;
      grant usage on schema public,auth to authenticated,anon; grant execute on all functions in schema auth to authenticated,anon;`)
    const file = name => readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8')
    await db.exec((await file('schema.sql')).replace('create extension if not exists pgcrypto;', ''))
    for (const name of ['inventoscan_features.sql','inventory_qr.sql','inventory_unit_actions.sql','inventory_return_repair.sql']) await db.exec(await file(name))
    await db.exec(await file('inventory_return_repair.sql'))
    // Fresh sample data must have exactly the open loans its borrowed statuses describe.
    await db.exec(await file('seed.sql'))
    assert.equal(Number((await db.query(`select count(*) from public.inventory_units u where u.status='borrowed'
      and not exists(select 1 from public.transactions t where t.unit_id=u.id and t.returned_at is null)`)).rows[0].count), 0)
    await db.exec(`set role authenticated; select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)`)
    const call = (sql,params) => db.query(sql,params)
    const shelf = (await call(`select public.inventory_save_qr_shelf(null,'TEST','Test shelf','Equipment',0,'equipment') as id`)).rows[0].id
    await call(`select public.inventory_stock_move($1,'in',4,'Received')`,[shelf])
    const units = (await call('select * from public.inventory_units where shelf_id=$1 order by unit_number',[shelf])).rows
    const borrower = (await call(`insert into public.borrowers(name,identity_number) values('Test student','TEST') returning id`)).rows[0].id
    const state = async id => (await call('select status,condition,retired_at from public.inventory_units where id=$1',[id])).rows[0]
    const openLoan = async id => {
      await call('select public.inventory_checkout($1,$2,current_date+14)',[id,borrower])
      return (await call('select id from public.transactions where unit_id=$1 and returned_at is null',[id])).rows[0].id
    }
    const reconcile = (id, condition='good', reason='Equipment physically returned and inspected') => call('select public.inventory_reconcile_return($1,$2,$3)',[id,condition,reason])
    // Reproduce old sample stock with a borrowed flag and no loan at all.
    await call(`update public.inventory_units set status='borrowed' where id=$1`,[units[0].id])
    await assert.rejects(reconcile(units[0].id,'good',''), /reason/)
    await reconcile(units[0].id)
    assert.equal((await state(units[0].id)).status,'available')
    assert.equal(Number((await call('select count(*) from public.transactions where unit_id=$1',[units[0].id])).rows[0].count),0)
    assert.match((await call(`select notes from public.stock_movements where unit_id=$1 and reason='Return'`,[units[0].id])).rows[0].notes, /Confirmed physical return/)
    await call(`select public.inventory_delete_unit($1,'Returned unit cleared from shelf')`,[units[0].id])
    assert.ok((await state(units[0].id)).retired_at)
    // A completed loan with a stale borrowed status can be reconciled without rewriting history.
    const loan = await openLoan(units[1].id)
    await assert.rejects(reconcile(units[1].id), /active loan/)
    await call(`select public.inventory_return($1,'good')`,[loan])
    const returnedAt = (await call('select returned_at from public.transactions where id=$1',[loan])).rows[0].returned_at
    await call(`update public.inventory_units set status='borrowed' where id=$1`,[units[1].id])
    await reconcile(units[1].id,'damaged')
    assert.equal((await state(units[1].id)).status,'under_maintenance')
    assert.equal((await state(units[1].id)).condition,'damaged')
    assert.deepEqual((await call('select returned_at from public.transactions where id=$1',[loan])).rows[0].returned_at, returnedAt)
    // Duplicate legacy open loans must all close before the unit becomes available.
    const first = await openLoan(units[2].id)
    const second = (await call(`insert into public.transactions(unit_id,borrower_id,expected_return_at) values($1,$2,current_date+14) returning id`,[units[2].id,borrower])).rows[0].id
    await call(`select public.inventory_return($1,'good')`,[first])
    assert.equal((await state(units[2].id)).status,'borrowed')
    await assert.rejects(reconcile(units[2].id), /active loan/)
    await assert.rejects(call(`select public.inventory_delete_unit($1,'Still on loan')`,[units[2].id]), /Return borrowed/)
    await call(`select public.inventory_return($1,'good')`,[second])
    assert.equal((await state(units[2].id)).status,'available')
    // Return failures must leave the loan open, rather than partially saving a return.
    const blocked = await openLoan(units[3].id)
    await db.exec('reset role; drop policy "inventory manage units" on public.inventory_units; set role authenticated')
    await assert.rejects(call(`select public.inventory_return($1,'good')`,[blocked]), /not found|permissions/i)
    assert.equal((await call('select returned_at from public.transactions where id=$1',[blocked])).rows[0].returned_at,null)
    assert.equal((await state(units[3].id)).status,'borrowed')
    await db.exec('reset role; set role anon')
    await assert.rejects(reconcile(units[3].id), /permission denied/)
  } finally { await db.close() }
})
