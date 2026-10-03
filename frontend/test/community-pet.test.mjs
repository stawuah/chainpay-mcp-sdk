import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/pet/shared/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { createSharedClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) }; };
const snapshot = (revision, serverTime = revision) => ({ revision, serverTime, needs: { battery: 80, joy: 80, cleanliness: 80 } });
const json = body => new Response(JSON.stringify(body), { status: 200 });

test('uncertain command survives reload, keeps snapshot and retries same command/token', async () => {
  const storage = memory(), pendingStorage = memory(), commands = [];
  let fail = true;
  const fetcher = async (url, init) => {
    if (url.endsWith('/state')) return json(snapshot(2));
    if (url.endsWith('/visitors')) return json({ token: 'anonymous', expiresAt: 999 });
    commands.push({ body: init.body, bearer: init.headers.Authorization });
    if (fail) throw Error('response lost after commit');
    return json({ state: snapshot(1), outcome: 'accepted', replayed: true });
  };
  let client = createSharedClient({ base: 'https://example.test', storage, pendingStorage, fetcher, uuid: () => 'same-id', now: () => 1 });
  await client.refresh(); await client.act('charge');
  assert.equal(client.get().state.revision, 2);
  assert.equal(client.get().status, 'offline');
  await client.act('play'); assert.equal(commands.length, 1);
  client = createSharedClient({ base: 'https://example.test', storage, pendingStorage, fetcher });
  await client.refresh(); fail = false; await client.retry();
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(client.get().pending, null); assert.equal(client.get().status, 'ready');
  assert.equal(client.get().state.revision, 2, 'old replay must not rewind recent snapshot');
});

test('tabs share anonymous identity while retaining independent uncertain commands', async () => {
  const storage = memory(), pendingA = memory(), pendingB = memory();
  const sessions = [];
  const fetcher = async (url, init) => {
    if (url.endsWith('/visitors')) { sessions.push(1); return json({ token: 'shared', expiresAt: 999 }); }
    throw Error('offline');
  };
  const a = createSharedClient({ base: '', storage, pendingStorage: pendingA, fetcher, uuid: () => 'a', now: () => 1 });
  const b = createSharedClient({ base: '', storage, pendingStorage: pendingB, fetcher, uuid: () => 'b', now: () => 1 });
  await a.act('charge'); await b.act('polish');
  assert.equal(sessions.length, 1); assert.equal(a.get().pending.commandId, 'a'); assert.equal(b.get().pending.commandId, 'b');
  assert.notEqual(pendingA.getItem('chainpay.pet.community.pending'), pendingB.getItem('chainpay.pet.community.pending'));
});

test('full and cooldown never claim shared care; expired pending is rejected without remint/reapply', async () => {
  for (const outcome of ['full', 'cooldown']) {
    const fetcher = async url => url.endsWith('/visitors') ? json({ token: 't', expiresAt: 999 }) : json({ state: snapshot(1), outcome });
    const client = createSharedClient({ base: '', fetcher, uuid: () => 'id', now: () => 1 });
    await client.act('charge'); assert.doesNotMatch(client.get().message, /Saved/);
  }
  const pendingStorage = memory(); pendingStorage.setItem('chainpay.pet.community.pending', JSON.stringify({ commandId: 'old', token: 'expired', action: 'charge' }));
  const calls = [];
  const client = createSharedClient({ base: '', pendingStorage, fetcher: async url => { calls.push(url); return new Response('', { status: 401 }); } });
  await client.retry(); assert.deepEqual(calls, ['/v1/pet/act']); assert.equal(client.get().pending, null);
});

test('a skewed browser clock does not churn anonymous identity or bypass care cooldown', async()=>{
  const storage=memory();storage.setItem('chainpay.pet.community.session',JSON.stringify({token:'existing',expiresAt:10000}));
  const calls=[];
  const client=createSharedClient({base:'',storage,now:()=>Number.MAX_SAFE_INTEGER,uuid:()=> 'id',fetcher:async(url,init)=>{
    calls.push(url);if(url.endsWith('/state'))return json(snapshot(1,100));
    assert.equal(init.headers.Authorization,'Bearer existing');return json({state:snapshot(1,100),outcome:'cooldown'});
  }});
  await client.refresh();await client.act('charge');await client.act('charge');
  assert.equal(calls.filter(url=>url.endsWith('/visitors')).length,0);
});

test('simultaneous first-use tabs acquire one identity under the shared lock', async()=>{
  const storage=memory(), tokens=[], calls=[];
  let queue=Promise.resolve();
  const locks={request(_name,run){const result=queue.then(run);queue=result.catch(()=>{});return result;}};
  const fetcher=async(url,init)=>{
    calls.push(url);
    if(url.endsWith('/visitors')) { await new Promise(resolve=>setTimeout(resolve,10));return json({token:'one-identity',expiresAt:999}); }
    tokens.push(init.headers.Authorization);return json({state:snapshot(1),outcome:'accepted'});
  };
  const a=createSharedClient({base:'',storage,locks,fetcher,uuid:()=> 'a'});
  const b=createSharedClient({base:'',storage,locks,fetcher,uuid:()=> 'b'});
  await Promise.all([a.act('charge'),b.act('polish')]);
  assert.equal(calls.filter(url=>url.endsWith('/visitors')).length,1);
  assert.deepEqual(tokens,['Bearer one-identity','Bearer one-identity']);
});
test('429 is conclusive, retains connectivity and uses Retry-After; local result claims no shared effect',async()=>{
  const pendingStorage=memory();let reject=true;
  const client=createSharedClient({base:'',pendingStorage,uuid:()=> 'id',fetcher:async(url)=>{
    if(url.endsWith('/state'))return json(snapshot(2));
    if(url.endsWith('/visitors'))return json({token:'t',expiresAt:999});
    return reject?new Response('',{status:429,headers:{'Retry-After':'47'}}):json({state:snapshot(2),outcome:'local'});
  }});
  await client.refresh();await client.act('pat');
  assert.equal(client.get().pending,null);assert.equal(pendingStorage.getItem('chainpay.pet.community.pending'),null);
  assert.equal(client.get().status,'ready');assert.match(client.get().message,/47 seconds/);assert.doesNotMatch(client.get().message,/unconfirmed/);
  reject=false;await client.act('pat');assert.match(client.get().message,/No shared change was saved/);
});

test('rate-limited refresh retains confirmed state and gives Retry-After without a false outage',async()=>{
  for(const loaded of [true,false]) {
    let limited=!loaded;
    const client=createSharedClient({base:'',fetcher:async()=>limited?new Response('',{status:429,headers:{'Retry-After':'23'}}):json(snapshot(7))});
    if(loaded){await client.refresh();limited=true;}
    await client.refresh();
    assert.equal(client.get().status,loaded?'ready':'loading');
    assert.equal(client.get().state?.revision??null,loaded?7:null);
    assert.match(client.get().message,/23 seconds/);
    assert.match(client.get().message,loaded?/last confirmed/:/has not loaded yet/);
    assert.doesNotMatch(client.get().message,/offline|interrupt|connection/i);
    limited=false;await client.refresh();assert.equal(client.get().status,"ready");assert.equal(client.get().message,"");
  }
});
