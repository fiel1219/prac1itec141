import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPagedRows } from '../src/lib/queryData.js'
import { loadInventorySetup, loadShelfInventory } from '../src/lib/inventoryData.js'
import { localDateValue } from '../src/lib/dates.js'

test('large lists load every page with deterministic ordering and never expose partial failures',async()=>{
  const rows=Array.from({length:1201},(_,id)=>({id})),calls=[]
  let fail=false
  const client={from(){const query={select(){return query},order(column){calls.push(column);return query},eq(column,value){assert.equal(column,'status');assert.equal(value,'pending');return query},range(start,end){return Promise.resolve(fail&&start>0?{error:{message:'Offline'}}:{data:rows.slice(start,end+1)})}};return query}}
  const options={orders:[['created_at'],['id']],filters:[['status','pending']]}
  assert.equal((await loadPagedRows(client,'account_approvals',options)).data.length,1201)
  assert.deepEqual(calls,['created_at','id','created_at','id','created_at','id'])
  fail=true;const failure=await loadPagedRows(client,'account_approvals',options)
  assert.equal(failure.data,null);assert.equal(failure.error.message,'Offline')
})

test('schema checks share in-flight requests and cache only fully successful setup',async()=>{
  let queries=0,error=null
  const client={from(){return {select(){return this},limit(){queries++;return Promise.resolve({data:[],error})}}}}
  const results=await Promise.all([loadInventorySetup(client,0),loadInventorySetup(client,0),loadInventorySetup(client,0)])
  assert.equal(queries,10);assert.equal(results[0].migrationRequired,false)
  await loadInventorySetup(client,1000);assert.equal(queries,10)
  await loadInventorySetup(client,300001);assert.equal(queries,20)
  error={code:'42703',message:'Missing column'}
  await loadInventorySetup(client,600002);const before=queries
  await loadInventorySetup(client,600003);assert.equal(queries,before+10)
  error={code:'42501',message:'Denied'}
  const denied=await loadInventorySetup(client,600004);assert.equal(denied.error.message,'Denied')
  error=null;assert.equal((await loadInventorySetup(client,600005)).migrationRequired,false)
})

test('shelf inventory groups units once, ignores retired units, and uses stable shelf ordering',async()=>{
  const orders=[]
  const client={from(table){let metadata=false;const query={select(columns){metadata=columns!=='*';return query},eq(){return query},order(column){orders.push([table,column]);return query},limit(){return Promise.resolve({data:[]})},range(){return Promise.resolve({data:metadata?[]:table==='shelves'?[{id:'s',code:'A-01'}]:[{id:'u',shelf_id:'s',unit_number:1},{id:'old',shelf_id:'s',unit_number:2,retired_at:'2026-01-01'}]})}};return query}}
  const inventory=await loadShelfInventory(client)
  assert.deepEqual(inventory.data[0].inventory_units.map(unit=>unit.id),['u'])
  assert.deepEqual(orders.filter(([table])=>table==='shelves'),[['shelves','code'],['shelves','id']])
})

test('date input values use local calendar fields rather than UTC conversion',()=>{
  const date=new Date(2026,9,24,0,15)
  date.toISOString=()=>{throw new Error('Do not convert calendar dates to UTC')}
  assert.equal(localDateValue(date),'2026-10-24')
})
