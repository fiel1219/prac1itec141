import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8')
function worker({offline=false,cacheFailure=false,cachedAsset=false}={}){
  const listeners={},deleted=[]
  const cache={match:async request=>request==='/index.html'?new Response('<html>App shell</html>'):cachedAsset?new Response('cached script'):undefined,
    put:async()=>{if(cacheFailure)throw Error('Cache full')}}
  vm.runInNewContext(source,{URL,Response,fetch:async()=>{if(offline)throw Error('Offline');return new Response('network script')},
    caches:{open:async()=>cache,keys:async()=>['inventoscan-shell-v2','inventoscan-shell-v3','another-app-cache'],delete:async name=>deleted.push(name)},
    self:{location:{origin:'https://app.test'},clients:{claim(){}},addEventListener:(name,handler)=>{listeners[name]=handler}}})
  return {deleted,activate:async()=>{let pending;listeners.activate({waitUntil:promise=>{pending=promise}});await pending},
    fetch:request=>{let response;listeners.fetch({request,respondWith:promise=>{response=promise}});return response}}
}
test('offline assets never receive HTML and navigation can use the cached app shell',async()=>{
  const offline=worker({offline:true})
  const asset={method:'GET',url:'https://app.test/assets/app.js',destination:'script',mode:'cors'}
  assert.equal((await offline.fetch(asset)).type,'error')
  assert.equal(await (await offline.fetch({...asset,mode:'navigate',destination:'document'})).text(),'<html>App shell</html>')
  assert.equal(await (await worker({offline:true,cachedAsset:true}).fetch(asset)).text(),'cached script')
})
test('cache write failures preserve successful network responses and cleanup respects other apps',async()=>{
  const instance=worker({cacheFailure:true})
  const response=await instance.fetch({method:'GET',url:'https://app.test/assets/app.js',destination:'script',mode:'cors'})
  assert.equal(await response.text(),'network script')
  await instance.activate();assert.deepEqual(instance.deleted,['inventoscan-shell-v2'])
  assert.equal(instance.fetch({method:'GET',url:'https://database.test/rest/v1/shelves'}),undefined)
})
