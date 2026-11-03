import test from 'node:test';
import assert from 'node:assert/strict';
import {PayPalAgentClient} from '../dist/paypal.js';
const config={enabled:true,apiOrigin:'https://paypal-api.example',workspaceOrigin:'https://paypal-ui.example',token:'a'.repeat(64)};
test('agent client requires isolated explicit configuration and exposes no money approvals',()=>{
  assert.throws(()=>new PayPalAgentClient({...config,enabled:false}));
  assert.throws(()=>new PayPalAgentClient({...config,apiOrigin:'https://chainpay-relay.vercel.app'}));
  assert.throws(()=>new PayPalAgentClient({...config,token:'shared-service-token'}));
  const client=new PayPalAgentClient(config);
  for(const method of ['capture','refund','checkout','approve']) assert.equal(client[method],undefined);
});
test('quote retry key survives transport and approval capabilities are omitted',async()=>{
  const previous=globalThis.fetch;
  try {
    globalThis.fetch=async(url,init)=>{
      assert.equal(url,'https://paypal-api.example/v1/paypal/tasks');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
      assert.equal(JSON.parse(init.body).request_id,'request-id-stays-same');
      return Response.json({id:'b'.repeat(32),gross:'12.00',quote_digest:'private-approval',share_token:'private-share'});
    };
    const result=await new PayPalAgentClient(config).quote('request-id-stays-same',[{name:'doc',text:'input'}]);
    assert.equal(result.gross,'12.00');assert.equal(result.quote_digest,undefined);assert.equal(result.share_token,undefined);
    assert.equal(result.review_url,`https://paypal-ui.example/paypal/?task=${'b'.repeat(32)}`);
  } finally {globalThis.fetch=previous;}
});
test('buyer/merchant credentials cannot be used as an agent grant',async()=>{
  const previous=globalThis.fetch;
  try {globalThis.fetch=async()=>Response.json({role:'buyer'});await assert.rejects(new PayPalAgentClient(config).requireAgent(),/agent-role/);} finally {globalThis.fetch=previous;}
});

test('service choice and requirements survive quote retries without payment authority',async()=>{
  const previous=globalThis.fetch;
  try {
    globalThis.fetch=async(url,init)=>{
      const body=JSON.parse(init.body);
      assert.equal(body.service_id,'requirements-check-v1');
      assert.equal(body.requirements,'Delivery in five days');
      assert.equal(body.request_id,'service-request-stable');
      assert.equal(body.amount,undefined);
      return Response.json({id:'b'.repeat(32),gross:'4.00',quote_digest:'private'});
    };
    const result=await new PayPalAgentClient(config).quote('service-request-stable',[{name:'doc',text:'source'}],{id:'requirements-check-v1',requirements:'Delivery in five days'});
    assert.equal(result.quote_digest,undefined);
  } finally {globalThis.fetch=previous;}
});

test('excluded production hosts reject trailing DNS dots',()=>{
  for(const host of ['chainpayai.app','www.chainpayai.app','a.b.chainpayai.app','chainpay-relay.vercel.app']) for(const suffix of ['', '.']) assert.throws(()=>new PayPalAgentClient({...config,apiOrigin:`https://${host}${suffix}`}));
});

test('allowance uses only the original server quote and an approved delegation',async()=>{
 const old=globalThis.fetch;const calls=[];
 try{globalThis.fetch=async(url,init)=>{calls.push({url,body:init.body&&JSON.parse(init.body)});return Response.json(url.endsWith('/session')?{role:'agent'}:init.method==='POST'?{id:'a'.repeat(32),funded:true,captured:false}:{quote_digest:'original-digest'});};
 const client=new PayPalAgentClient(config);const result=await client.consumeAllowance('a'.repeat(32),'b'.repeat(32),'c'.repeat(32));
 assert.equal(result.captured,false);assert.equal(result.funded,true);assert.deepEqual(calls.at(-1).body,{subscription_id:'b'.repeat(32),delegation_id:'c'.repeat(32),digest:'original-digest'});
 for(const method of ['subscribe','cancelSubscription','increaseLimits','refundSubscription'])assert.equal(client[method],undefined);
 }finally{globalThis.fetch=old;}
});

test('resolution reads private revision history without merchant approval digests',async()=>{
 const previous=globalThis.fetch;try{
 globalThis.fetch=async()=>Response.json({units:[{index:0,revision:2,output_hash:"current-hash",buyer_review:"challenge",result:"private result"}],resolution:[{intent:{action:'challenge'}}],revisions:[[{revision:0}]],refunds:[{digest:'merchant-approval',amount:'4.00'}]});
 const result=await new PayPalAgentClient(config).resolution('a'.repeat(32));
 assert.deepEqual(result.units,[{index:0,revision:2,output_hash:"current-hash",buyer_review:"challenge"}]);assert.equal(result.resolution[0].intent.action,'challenge');assert.equal(result.refunds[0].digest,undefined);assert.match(result.approval,/never waives/);
 }finally{globalThis.fetch=previous;}
});

test('allowance list never carries the vault block to the agent',async()=>{
 const previous=globalThis.fetch;try{
 globalThis.fetch=async(url)=>{assert.equal(url,'https://paypal-api.example/v1/paypal/allowances');return Response.json({allowances:[{id:'grocery-week',status:'Active',remaining_cents:'3000',vault:{source:'paypal',status:'ready',approval_url:'https://www.sandbox.paypal.com/x'}}]});};
 const result=await new PayPalAgentClient(config).findAllowance();
 assert.equal(result.allowances[0].remaining_cents,'3000');assert.equal(result.allowances[0].vault,undefined);
 assert.ok(!JSON.stringify(result).includes('sandbox.paypal.com'));
 }finally{globalThis.fetch=previous;}
});

test('catalog search encodes the query and quote sends validated lines only',async()=>{
 const previous=globalThis.fetch;const calls=[];try{
 globalThis.fetch=async(url,init)=>{calls.push({url,method:init.method,body:init.body&&JSON.parse(init.body)});return Response.json({merchants:[],policy:{allowed:true}});};
 const client=new PayPalAgentClient(config);
 await client.searchCatalog('oat milk');assert.equal(calls.at(-1).url,'https://paypal-api.example/v1/paypal/catalog?q=oat%20milk');
 await client.searchCatalog();assert.equal(calls.at(-1).url,'https://paypal-api.example/v1/paypal/catalog');
 await client.quotePurchase({merchant:'grocer',items:[{id:'oat-milk',qty:2}],allowance_id:'a'.repeat(32)});
 assert.equal(calls.at(-1).url,'https://paypal-api.example/v1/paypal/purchases/quote');
 assert.deepEqual(calls.at(-1).body,{merchant:'grocer',items:[{id:'oat-milk',qty:2}],allowance_id:'a'.repeat(32)});
 for(const bad of [{merchant:'Grocer',items:[{id:'oat-milk',qty:1}]},{merchant:'grocer',items:[]},{merchant:'grocer',items:[{id:'oat-milk',qty:0}]},{merchant:'grocer',items:[{id:'oat-milk',qty:11}]},{merchant:'grocer',items:[{id:'oat-milk',qty:1.5}]},{merchant:'grocer',items:[{id:'oat-milk',qty:1,unit_cents:'1'}]},{merchant:'grocer',items:Array.from({length:11},()=>({id:'oat-milk',qty:1}))}]) await assert.rejects(client.quotePurchase(bad));
 assert.equal(calls.length,3);
 }finally{globalThis.fetch=previous;}
});

test('purchase keeps the request id, derives its kind from the receipt and strips vault',async()=>{
 const previous=globalThis.fetch;const bodies=[];
 const answers=[
  {id:'b'.repeat(32),captured:true,quote_digest:'private',purchase:{approval:null,policy:{allowed:true,rule:'allowance-rules-v1'}}},
  {id:'c'.repeat(32),quote_digest:'private',purchase:{approval:'requested',policy:{allowed:true}}},
  {id:'d'.repeat(32),purchase:{approval:null,policy:{allowed:false,reason_code:'per_purchase_cap'}}},
  // A retry after the buyer's approval re-check failed: the rules denied it and the policy says why.
  {id:'e'.repeat(32),purchase:{approval:'denied',approved_by:'rules',policy:{allowed:false,reason_code:'allowance_not_active'}}},
 ];
 try{
 globalThis.fetch=async(url,init)=>{assert.equal(url,'https://paypal-api.example/v1/paypal/purchases');bodies.push(JSON.parse(init.body));return Response.json(answers[bodies.length-1]);};
 const client=new PayPalAgentClient(config);
 const paid=await client.purchase('purchase-request-stays-same','a'.repeat(32),'grocer',[{id:'oat-milk',qty:2}],'agent_pays');
 assert.equal(paid.kind,'receipt');assert.equal(paid.reason_code,undefined);assert.equal(paid.receipt.quote_digest,undefined);
 assert.equal(paid.review_url,`https://paypal-ui.example/paypal/?task=${'b'.repeat(32)}`);
 assert.deepEqual(bodies[0],{request_id:'purchase-request-stays-same',allowance_id:'a'.repeat(32),merchant:'grocer',items:[{id:'oat-milk',qty:2}],mode:'agent_pays'});
 const asked=await client.purchase('purchase-request-stays-same','a'.repeat(32),'grocer',[{id:'oat-milk',qty:2}],'ask_first');
 assert.equal(asked.kind,'approval_requested');assert.equal(bodies[1].request_id,'purchase-request-stays-same');assert.equal(bodies[1].mode,'ask_first');
 const refused=await client.purchase('purchase-request-stays-same','a'.repeat(32),'grocer',[{id:'oat-milk',qty:2}],'agent_pays');
 assert.equal(refused.kind,'refused');assert.equal(refused.reason_code,'per_purchase_cap');
 const rechecked=await client.purchase('purchase-request-stays-same','a'.repeat(32),'grocer',[{id:'oat-milk',qty:2}],'ask_first');
 assert.equal(rechecked.kind,'refused');assert.equal(rechecked.reason_code,'allowance_not_active');
 await assert.rejects(client.purchase('short','a'.repeat(32),'grocer',[{id:'oat-milk',qty:1}],'agent_pays'));
 await assert.rejects(client.purchase('purchase-request-stays-same','','grocer',[{id:'oat-milk',qty:1}],'agent_pays'));
 await assert.rejects(client.purchase('purchase-request-stays-same','a'.repeat(32),'grocer',[{id:'oat-milk',qty:1}],'buyer_pays'));
 assert.equal(bodies.length,4);
 for(const method of ['approvePurchase','denyPurchase','setAllowanceStatus','createAllowance','vault']) assert.equal(client[method],undefined);
 }finally{globalThis.fetch=previous;}
});

test('approvals inbox and refund request carry no approval digests',async()=>{
 const previous=globalThis.fetch;const calls=[];try{
 globalThis.fetch=async(url,init)=>{calls.push({url,body:init.body&&JSON.parse(init.body)});return Response.json(url.endsWith('/approvals')?{approvals:[{id:'b'.repeat(32),quote_digest:'private',share_token:'private',purchase:{approval:'requested'}}]}:{amount:'3.90',digest:'merchant-approval',failed_units:[1],requires_merchant_approval:true});};
 const client=new PayPalAgentClient(config);
 const inbox=await client.listApprovals();
 assert.equal(inbox.approvals[0].purchase.approval,'requested');assert.equal(inbox.approvals[0].quote_digest,undefined);assert.equal(inbox.approvals[0].share_token,undefined);
 const refund=await client.requestRefund('b'.repeat(32),'Second carton arrived open');
 assert.equal(calls.at(-1).url,`https://paypal-api.example/v1/paypal/tasks/${'b'.repeat(32)}/refund-request`);
 assert.deepEqual(calls.at(-1).body,{reason:'Second carton arrived open'});
 assert.equal(refund.amount,'3.90');assert.equal(refund.digest,undefined);assert.deepEqual(refund.failed_units,[1]);assert.match(refund.approval,/cannot refund/);
 await assert.rejects(client.requestRefund('b'.repeat(32),' '));
 }finally{globalThis.fetch=previous;}
});

test('threshold purchases preserve mode and approval-only requests cannot use a charging mode', async () => {
 const previous=globalThis.fetch; const bodies=[];
 try {
  globalThis.fetch=async (_url, init) => {bodies.push(JSON.parse(init.body)); return Response.json({id:'b'.repeat(32),purchase:{approval:'requested',policy:{allowed:true}}});};
  const client=new PayPalAgentClient(config);
  const args=['threshold-purchase-stable','a'.repeat(32),'grocer',[{id:'oat-milk',qty:2}]];
  const purchase=await client.purchase(...args,'ask_above');
  assert.equal(purchase.kind,'approval_requested');assert.equal(bodies[0].mode,'ask_above');assert.equal(bodies[0].approval_only,undefined);
  await client.requestPurchaseApproval(...args,'ask_above');
  await client.requestPurchaseApproval(...args,'ask_above');
  assert.deepEqual(bodies[1],{...bodies[0],approval_only:true});assert.deepEqual(bodies[2],bodies[1]);
  assert.throws(()=>client.requestPurchaseApproval(...args,'agent_pays'),/Approval requests/);
  await assert.rejects(client.purchase(...args,'unknown_mode'),/mode/);
  assert.equal(bodies.length,3);
 } finally {globalThis.fetch=previous;}
});
