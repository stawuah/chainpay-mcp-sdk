import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
const bundle = await build({entryPoints:[new URL('../src/pet/store.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['react']});
const source=bundle.outputFiles[0].text;
test('legacy tabs serialize care, sync saves, and never overwrite progress through local animation', async()=>{
  const data=new Map(),events=[],queue={value:Promise.resolve()};
  const storage={getItem:k=>data.get(k)??null,setItem(k,v){data.set(k,v);events.forEach(fn=>fn({key:k}));}};
  const locks={request(_key,run){const next=queue.value.then(run);queue.value=next.catch(()=>{});return next;}};
  const tab=()=>{const context=vm.createContext({module:{exports:{}},require:()=>({useSyncExternalStore:()=>{}}),Date,Set,Promise,navigator:{locks},window:{localStorage:storage,addEventListener:(_event,fn)=>events.push(fn),setInterval:()=>1,clearInterval:()=>{}}});vm.runInContext(source,context);return context.module.exports.petStore;};
  const a=tab(),b=tab();
  const results=await Promise.all([a.act('feed'),b.act('feed')]);
  assert.equal(results.filter(r=>r.ok).length,1,'cooldown checked under shared Web Lock');
  await Promise.all([a.note('coins'),b.note('games')]);
  const saved=JSON.parse(data.get('chainpay.pet.bond.v1'));assert.equal(saved.today.coins,1);assert.equal(saved.today.games,1);
  const before=JSON.stringify([...data]);a.react('happy');b.say('hello');assert.equal(JSON.stringify([...data]),before,'local reactions never rewrite saved state');
});

test('blocked storage retains in-memory care and notes across successive actions', async()=>{
  const context=vm.createContext({module:{exports:{}},require:()=>({useSyncExternalStore:()=>{}}),Date,Set,Promise,navigator:{},window:{localStorage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}},addEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{}}});
  vm.runInContext(source,context);const store=context.module.exports.petStore;
  const born=store.get().snapshot.bornAt;
  assert.equal((await store.act('feed')).ok,true);
  assert.equal((await store.act('feed')).ok,false,'in-memory cooldown survives inaccessible storage');
  await store.note('coins');await store.note('games');
  assert.equal(store.get().bond.today.coins,1);assert.equal(store.get().bond.today.games,1);assert.equal(store.get().snapshot.bornAt,born);
});
test('first visit persists birth even before care',async()=>{
  const data=new Map();
  const context=vm.createContext({module:{exports:{}},require:()=>({useSyncExternalStore:()=>{}}),Date,Set,Promise,navigator:{},window:{localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},addEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{}}});
  vm.runInContext(source,context);const store=context.module.exports.petStore;await store.visit();
  assert.equal(JSON.parse(data.get('chainpay.pet.v1')).bornAt,store.get().snapshot.bornAt);
});
test('passive low-power decay is persisted before day rollover and survives reload',async()=>{
  let now=new Date(2026,9,3,23,59,0).getTime(),tick;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const data=new Map();
  data.set('chainpay.pet.v1',JSON.stringify({needs:{battery:14,joy:70,clean:80},at:now-60000,bornAt:now-60000,lowPower:false,lastAction:{},grumpyUntil:0}));
  const make=()=>{const context=vm.createContext({module:{exports:{}},require:()=>({useSyncExternalStore:()=>{}}),Date:Clock,Set,Promise,navigator:{},window:{localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},addEventListener:()=>{},setInterval(fn){tick=fn;return 1;},clearInterval:()=>{}}});vm.runInContext(source,context);return context.module.exports.petStore;};
  const store=make();store.subscribe(()=>{});await tick();
  assert.equal(JSON.parse(data.get('chainpay.pet.bond.v1')).today.lowPower,true);
  now+=120000;await tick();
  const restored=make();assert.equal(restored.get().bond.diary.length,1);assert.match(restored.get().bond.diary[0].text,/ran low on power/);
  const before=data.get('chainpay.pet.bond.v1');restored.react('happy');assert.equal(data.get('chainpay.pet.bond.v1'),before);
});
