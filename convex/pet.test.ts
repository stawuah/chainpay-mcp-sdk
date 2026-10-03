import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from './schema';
import { internal } from './_generated/api';
import { advanceWorld, applyCare, AWAKE, chooseFavorite, DAY, HOUR, initialWorld, NAP, petState } from '../shared/pet';
const modules=import.meta.glob(['./**/*.ts','!./**/*.test.ts']);
const tokenHash='a'.repeat(64),peerHash='b'.repeat(64);
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const setup=()=> { const t=convexTest(schema,modules); return {t,call:(operation:string,args:Record<string,unknown>={})=>t.mutation(internal.storage.execute,{role:'backend',operation,args})}; };
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100*DAY);vi.stubEnv('CHAINPAY_SHARED_PET','on');});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('community pet simulation',()=>{
 it('integrates naps, 24h and seven-day absence without browser ticks',()=>{
  const w=initialWorld(0);
  expect(petState(w,AWAKE+NAP/2).sleeping).toBe(true);
  expect(advanceWorld(w,AWAKE+NAP).needs.battery).toBeCloseTo(80-4-.3/6);
  const one=advanceWorld(w,DAY), stepped=advanceWorld(advanceWorld(w,3*HOUR),DAY);
  expect(one.needs.battery).toBeCloseTo(stepped.needs.battery);
  expect(advanceWorld(w,7*DAY).needs).toEqual({battery:10,joy:10,cleanliness:10});
  expect(advanceWorld(w,36500*DAY).needs.battery).toBe(10);
 });
 it('retains low-power hysteresis until all needs recover and gently wakes',()=>{
  let w=advanceWorld(initialWorld(0),7*DAY);expect(w.lowPower).toBe(true);
  w=applyCare(w,'charge',7*DAY);expect(w.lowPower).toBe(true);
  w=applyCare(w,'play',7*DAY);expect(w.lowPower).toBe(true);
  w=applyCare(w,'polish',7*DAY);expect(w.lowPower).toBe(false);
  const wake=applyCare(initialWorld(0),'wake',AWAKE+1);expect(petState(wake,AWAKE+1).sleeping).toBe(false);
  expect(wake.napAnchor).toBe(2*AWAKE+1);
 });
 it('keeps rollback snapshots and wake timing consistent with persisted server time',()=>{
  const w=advanceWorld(initialWorld(0),AWAKE+1);
  expect(petState(w,AWAKE-1)).toEqual(petState(w,AWAKE+1));
  const awake=applyCare(w,'wake',AWAKE-1);
  expect(awake.napAnchor).toBe(2*AWAKE+1);
  expect(petState(awake,0).serverTime).toBe(AWAKE+1);
  expect(petState(awake,0).sleeping).toBe(false);
 });
 it('uses exact nap boundaries across repeated cycles',()=>{
  const w=initialWorld(0), cycle=AWAKE+NAP;
  for(const offset of [0,cycle,100*cycle]) {
    expect(petState(w,AWAKE+offset-1).sleeping).toBe(false);
    expect(petState(w,AWAKE+offset).napUntil).toBe(AWAKE+offset+NAP);
    expect(petState(w,AWAKE+offset+NAP-1).sleeping).toBe(true);
    const end=petState(w,AWAKE+offset+NAP);
    expect(end.sleeping).toBe(false);expect(end.napUntil).toBeNull();
    expect(end.nextNapAt).toBe(AWAKE+offset+cycle);
  }
 });
 it('requires separate days and retains favorite on ties',()=>{
  expect(chooseFavorite({ball:{count:500,days:1},collect:{count:2,days:2},polish:{count:2,days:2}},'polish')).toBe('polish');
 });
});
describe('atomic pet storage',()=>{
 it('projects repeated state polls without writes and applies elapsed time when care arrives',async()=>{
  const {t,call}=setup();await call('pet.visitors',{tokenHash,peerHash});await call('pet.state');
  const stored=()=>t.run(ctx=>ctx.db.query('pet_world').withIndex('by_key',q=>q.eq('key','community')).unique());
  const initial=await stored();
  vi.advanceTimersByTime(HOUR);
  expect((await call('pet.state')).needs.battery).toBe(79);
  expect(await stored()).toEqual(initial);
  vi.advanceTimersByTime(HOUR);
  expect((await call('pet.state')).needs.joy).toBe(77);
  expect(await stored()).toEqual(initial);
  const care=await call('pet.act',{tokenHash,commandId:id(1),action:'charge'});
  expect(care.state.needs).toEqual({battery:100,joy:77,cleanliness:78.5});
  expect((await stored())?.world.lastUpdated).toBe(100*DAY+2*HOUR);
  const afterCare=await stored();
  vi.advanceTimersByTime(HOUR);await call('pet.state');expect(await stored()).toEqual(afterCare);
 });

 it('deduplicates concurrent care and rejects changed replay intent',async()=>{
  const {t,call}=setup();await call('pet.visitors',{tokenHash,peerHash});
  const args={tokenHash,commandId:id(1),action:'charge'};
  const results=await Promise.all([call('pet.act',args),call('pet.act',args)]);
  expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);expect(results[0].state.needs.battery).toBe(100);
  expect(await t.run(ctx=>ctx.db.query('pet_commands').collect())).toHaveLength(1);
  await expect(call('pet.act',{...args,action:'play'})).rejects.toThrow(/another action/);
  expect((await call('pet.act',{...args,commandId:id(2)})).outcome).toBe('cooldown');
  vi.advanceTimersByTime(30_000);
  // Decay makes a little meaningful room again; never trust client-provided needs/time.
  await expect(call('pet.act',{...args,now:0,needs:{battery:0}})).rejects.toThrow(/Unexpected/);
 });
 it.each(['play','ball','game'] as const)('shares the joy cooldown after %s across all play intents',async first=>{
  const {t,call}=setup();await call('pet.visitors',{tokenHash,peerHash});
  const accepted=await call('pet.act',{tokenHash,commandId:id(1),action:first});
  expect(accepted.outcome).toBe('accepted');expect(accepted.state.needs.joy).toBe(100);
  vi.advanceTimersByTime(29_000);
  for(const [i,action] of ['play','ball','game'].entries()) {
    const rejected=await call('pet.act',{tokenHash,commandId:id(2+i),action});
    expect(rejected.outcome).toBe('cooldown');expect(rejected.state.needs.joy).toBeCloseTo(100-29_000/HOUR*1.5);
  }
  const counts=(await call('pet.memories')).aggregates[0].counts;
  expect(counts).toEqual({[first]:1});
  expect(await t.run(ctx=>ctx.db.query('pet_contributions').collect())).toHaveLength(1);
  expect((await t.run(ctx=>ctx.db.query('pet_activity_days').collect()))[0].count).toBe(1);
  vi.advanceTimersByTime(1_000);
  const next=await call('pet.act',{tokenHash,commandId:id(10),action:'ball'});
  expect(next.outcome).toBe('accepted');expect(next.state.needs.joy).toBe(100);
  expect(Object.values((await call('pet.memories')).aggregates[0].counts).reduce((a:any,b:any)=>a+b,0)).toBe(2);
  expect(await t.run(ctx=>ctx.db.query('pet_contributions').collect())).toHaveLength(1);
 });
 it('applies concurrent visitors atomically, reports full and remembers real recovery',async()=>{
  const {t,call}=setup();const token2='c'.repeat(64);
  await call('pet.visitors',{tokenHash,peerHash});await call('pet.visitors',{tokenHash:token2,peerHash});
  const results=await Promise.all([call('pet.act',{tokenHash,commandId:id(1),action:'charge'}),call('pet.act',{tokenHash:token2,commandId:id(1),action:'charge'})]);
  expect(results.map(r=>r.outcome).sort()).toEqual(['accepted','full']);
  vi.advanceTimersByTime(7*DAY);expect((await call('pet.state')).lowPower).toBe(true);
  for(const [i,action] of ['charge','play','polish'].entries()) await call('pet.act',{tokenHash,commandId:id(10+i),action});
  expect((await call('pet.state')).lowPower).toBe(false);
  expect((await call('pet.memories')).memories.filter((m:any)=>m.kind==='recovery')).toHaveLength(1);
  expect(await t.run(ctx=>ctx.db.query('pet_world').collect())).toHaveLength(1);
 });
 it('counts at most one visitor/activity/day, evaluates preceding seven days once daily',async()=>{
  const {t,call}=setup();await call('pet.visitors',{tokenHash,peerHash});
  await call('pet.act',{tokenHash,commandId:id(1),action:'collect'});
  vi.advanceTimersByTime(31_000);await call('pet.act',{tokenHash,commandId:id(2),action:'collect'});
  expect(await t.run(ctx=>ctx.db.query('pet_contributions').collect())).toHaveLength(1);
  vi.setSystemTime(101*DAY);await call('pet.act',{tokenHash,commandId:id(3),action:'collect'});
  expect((await call('pet.state')).favorite).toBeNull();
  vi.setSystemTime(102*DAY);expect((await call('pet.state')).favorite).toBe('collect');
  const memories=await call('pet.memories');expect(memories.memories.filter((m:any)=>m.kind==='favorite')).toHaveLength(1);
  await call('pet.state');expect((await call('pet.memories')).memories).toEqual(memories.memories);
 });
 it('records real pat/game/coin/secret firsts, props, aggregates and lossless pagination',async()=>{
  const {call}=setup();await call('pet.visitors',{tokenHash,peerHash});
  for(const [i,action] of ['pat','game','coin','secret','collect'].entries()) await call('pet.act',{tokenHash,commandId:id(i),action});
  const state=await call('pet.state');expect(state.props).toEqual(['blue-star','shiny-washer']);
  let before: number|undefined, ids:string[]=[];
  do {const page=await call('pet.memories',{limit:2,...(before?{before}:{})});ids.push(...page.memories.map((m:any)=>m.id));before=page.nextBefore??undefined;} while(before);
  expect(new Set(ids).size).toBe(5);expect(ids).toHaveLength(5);
  expect((await call('pet.memories')).aggregates[0].counts.pat).toBe(1);
 });
 it('rejects expired retries even after bounded cleanup',async()=>{
  const {t,call}=setup();await call('pet.visitors',{tokenHash,peerHash});const args={tokenHash,commandId:id(1),action:'pat'};
  await call('pet.act',args);vi.advanceTimersByTime(31*DAY);await t.mutation(internal.pet.cleanup,{});
  await expect(call('pet.act',args)).rejects.toThrow(/expired/);
 });
 it('allows shared-network visitors across bursts while enforcing the daily peer ceiling',async()=>{
  const {call}=setup();
  for(let batch=0;batch<10;batch++) {
    for(let i=0;i<20;i++) await call('pet.visitors',{tokenHash:(batch*20+i).toString(16).padStart(64,'0'),peerHash});
    if(batch===0) await expect(call('pet.visitors',{tokenHash:'d'.repeat(64),peerHash})).rejects.toThrow(/moment/);
    vi.advanceTimersByTime(60_000);
  }
  await expect(call('pet.visitors',{tokenHash,peerHash})).rejects.toThrow(/moment/);
  // Other trusted peers have separate NAT budgets, subject to the global cap.
  await expect(call('pet.visitors',{tokenHash,peerHash:'c'.repeat(64)})).resolves.toHaveProperty('expiresAt');
  vi.advanceTimersByTime(DAY);
  await expect(call('pet.visitors',{tokenHash:'d'.repeat(64),peerHash})).resolves.toHaveProperty('expiresAt');
 });
 it('enforces role, feature flag, creation and action abuse boundaries',async()=>{
  const {t,call}=setup();await expect(t.mutation(internal.storage.execute,{role:'mcp',operation:'pet.state',args:{}})).rejects.toThrow(/not allowed/);
  vi.stubEnv('CHAINPAY_SHARED_PET','off');await expect(call('pet.state')).rejects.toThrow(/unavailable/);vi.stubEnv('CHAINPAY_SHARED_PET','on');
  for(let i=0;i<20;i++) await call('pet.visitors',{tokenHash:i.toString(16).padStart(64,'0'),peerHash});
  await expect(call('pet.visitors',{tokenHash,peerHash})).rejects.toThrow(/moment/);
  const token='0'.repeat(64);
  for(let i=0;i<60;i++) await call('pet.act',{tokenHash:token,commandId:id(i),action:'pat'});
  await expect(call('pet.act',{tokenHash:token,commandId:id(61),action:'pat'})).rejects.toThrow(/moment/);
 });
});

describe('authenticated pet HTTP gateway',()=>{
 const backend='backend-'.repeat(8),mcp='mcp-'.repeat(16),migration='migration-'.repeat(8);
 function httpSetup() {
  vi.stubEnv('CHAINPAY_CONVEX_BACKEND_SECRET',backend);
  vi.stubEnv('CHAINPAY_CONVEX_MCP_SECRET',mcp);
  vi.stubEnv('CHAINPAY_CONVEX_MIGRATION_SECRET',migration);
  const {t}=setup();
  return (token:string,operation:string,args:Record<string,unknown>={})=>t.fetch('/internal/storage/v1',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({operation,args})});
 }
 it('dispatches only backend credentials and returns no private identifiers',async()=>{
  const request=httpSetup();
  for(const token of ['',tokenHash,'untrusted']) {
    const r=await request(token,'pet.state');expect(r.status).toBe(401);expect((await r.json()).error.code).toBe('unauthorized');
  }
  for(const token of [mcp,migration]) {const r=await request(token,'pet.state');expect(r.status).toBe(403);expect((await r.json()).error.code).toBe('forbidden');}
  const created=await request(backend,'pet.visitors',{tokenHash,peerHash});expect(created.status).toBe(200);expect((await created.json()).value.expiresAt).toBe(130*DAY);
  const response=await request(backend,'pet.act',{tokenHash,commandId:id(1),action:'pat'});
  expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body=await response.json();expect(body.value.outcome).toBe('accepted');expect(body.value.state.recentMemories[0].kind).toBe('first');
  expect(JSON.stringify(body)).not.toContain(tokenHash);expect(JSON.stringify(body)).not.toContain(peerHash);
 });
 it('enforces feature and maintenance flags at the HTTP boundary',async()=>{
  const request=httpSetup();vi.stubEnv('CHAINPAY_SHARED_PET','off');
  const off=await request(backend,'pet.state');expect(off.status).toBe(503);expect((await off.json()).error.code).toBe('unavailable');
  vi.stubEnv('CHAINPAY_SHARED_PET','on');vi.stubEnv('CHAINPAY_MAINTENANCE','true');
  const paused=await request(backend,'pet.visitors',{tokenHash,peerHash});expect(paused.status).toBe(503);expect((await paused.json()).error.code).toBe('maintenance');
 });
 it.each([
  {name:'minute',window:60_000,offset:1_500,key:'visitors-burst',count:20,expected:59},
  {name:'day',window:DAY,offset:1_500,key:'visitors',count:200,expected:86_399},
  {name:'last millisecond',window:60_000,offset:59_999,key:'visitors-burst',count:20,expected:1},
 ])('reports the actual $name bucket reset safely over HTTP',async ({window,offset,key,count,expected})=>{
  vi.stubEnv('CHAINPAY_CONVEX_BACKEND_SECRET',backend);
  const {t}=setup();vi.setSystemTime(100*DAY+offset);const now=Date.now();
  await t.run(ctx=>ctx.db.insert('rate_limits',{key:`pet:${key}:${peerHash}:${Math.floor(now/window)}`,count,expires:now+window}));
  const request=()=>t.fetch('/internal/storage/v1',{method:'POST',headers:{Authorization:`Bearer ${backend}`},body:JSON.stringify({operation:'pet.visitors',args:{tokenHash,peerHash}})});
  const limited=await request();expect(limited.status).toBe(429);
  expect((await limited.json()).error).toEqual({code:'rate_limited',message:'Please give the community pet a moment',retryAfterSeconds:expected});
  vi.setSystemTime((Math.floor(now/window)+1)*window);
  expect((await request()).status).toBe(200);
 });
 it('maps invalid, expired, conflict and rate-limited commands to valid HTTP errors',async()=>{
  const request=httpSetup();
  const invalid=await request(backend,'pet.act',{tokenHash,commandId:id(1),action:'pat',now:0});expect(invalid.status).toBe(400);expect((await invalid.json()).error.code).toBe('invalid_argument');
  const unauthorized=await request(backend,'pet.act',{tokenHash,commandId:id(1),action:'pat'});expect(unauthorized.status).toBe(401);expect((await unauthorized.json()).error.code).toBe('unauthorized');
  await request(backend,'pet.visitors',{tokenHash,peerHash});
  await request(backend,'pet.act',{tokenHash,commandId:id(1),action:'pat'});
  const conflict=await request(backend,'pet.act',{tokenHash,commandId:id(1),action:'charge'});expect(conflict.status).toBe(409);expect((await conflict.json()).error.code).toBe('conflict');
  for(let i=0;i<19;i++) await request(backend,'pet.visitors',{tokenHash:i.toString(16).padStart(64,'0'),peerHash});
  const limited=await request(backend,'pet.visitors',{tokenHash:'f'.repeat(64),peerHash});expect(limited.status).toBe(429);expect((await limited.json()).error.code).toBe('rate_limited');
  vi.advanceTimersByTime(30*DAY);
  const expired=await request(backend,'pet.act',{tokenHash,commandId:id(1),action:'pat'});expect(expired.status).toBe(401);expect((await expired.json()).error.code).toBe('unauthorized');
 });
});
