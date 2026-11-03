import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../src/paypal/client.ts',import.meta.url),'utf8');
const {apiOrigin,checkoutUrl,money,exportReceipt,client}=await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64')}`);
test('PayPal config has no live or existing deployment fallback',()=>{
  for(const value of [undefined,'https://chainpay-relay.vercel.app','https://www.chainpayai.app','http://remote.example','https://name:secret@example.com','https://example.com/api']) assert.throws(()=>apiOrigin(value));
  assert.equal(apiOrigin('http://localhost:8081'),'http://localhost:8081');
  assert.equal(apiOrigin('https://isolated.example'),'https://isolated.example');
  for(const value of ['https://www.paypal.com/checkout','https://www.sandbox.paypal.com.evil.test/','javascript:alert(1)']) assert.throws(()=>checkoutUrl(value));
});
test('exact strings and unknown cost survive display and CSV export',()=>{
  assert.equal(money('9007199254740993.01'),'$9007199254740993.01');
  assert.equal(money(null),'Not established');
  assert.throws(()=>money('1e3'));
  const csv=exportReceipt({id:'task',currency:'USD',gross:'12.00',captured:true,refund:'4.00',refund_confirmed:false,net:'12.00'});
  assert.ok(csv.includes('"12.00","true","0.00","12.00"'));
});
test('client refuses redirects and never sends existing site cookies',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(url,options)=>{assert.equal(url,'https://isolated.example/v1/paypal/tasks');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,'Bearer scoped-grant');return new Response('{"tasks":[]}',{status:200});};
    assert.deepEqual(await client('https://isolated.example','scoped-grant')('/tasks'),{tasks:[]});
  } finally {globalThis.fetch=original;}
});

test('excluded production hosts reject trailing DNS dots',()=>{
  for(const host of ['chainpayai.app','www.chainpayai.app','a.b.chainpayai.app','chainpay-relay.vercel.app']) for(const suffix of ['', '.']) assert.throws(()=>apiOrigin(`https://${host}${suffix}`));
});

test('mutating transport failures and unreadable successes preserve uncertainty, explicit rejection does not',async()=>{
 const original=globalThis.fetch;
 try {
  for(const response of [()=>{throw new TypeError('fetch failed');},()=>new Response('{}',{status:503}),()=>new Response('{}',{status:409}),()=>new Response('broken json',{status:200})]) {
   globalThis.fetch=async()=>response();
   await assert.rejects(client('https://isolated.example','scoped-grant')('/tasks','POST',{request_id:'same'}),e=>e.constructor.name==='PayPalRequestUncertainError');
  }
  globalThis.fetch=async()=>Response.json({error:'Quote expired'},{status:422});
  await assert.rejects(client('https://isolated.example','scoped-grant')('/tasks','POST',{request_id:'same'}),e=>e.constructor.name==='Error' && e.message==='Quote expired');
 }finally{globalThis.fetch=original;}
});
