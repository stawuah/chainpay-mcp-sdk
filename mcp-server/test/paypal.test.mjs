import test from 'node:test';
import assert from 'node:assert/strict';
import {handlePayPalMessage,PAYPAL_TOOLS} from '../dist/paypal.js';
import {CURRENT_PROTOCOL_VERSION} from '../dist/protocol.js';
const message=(method,params={})=>({jsonrpc:'2.0',id:1,method,params});
test('isolated MCP discovery contains only non-approving PayPal tools',async()=>{
  const response=await handlePayPalMessage(message('tools/list'),{});
  assert.equal(response.result.tools.length,19);
  assert.ok(PAYPAL_TOOLS.every(t=>t.name.startsWith('paypal_')));
  assert.ok(PAYPAL_TOOLS.every(t=>!['paypal_capture','paypal_refund','execute_payment','paypal_approve_purchase','paypal_create_allowance','paypal_set_allowance_status'].includes(t.name)));
  for(const name of ['paypal_find_allowance','paypal_search_catalog','paypal_quote_purchase','paypal_list_approvals']) assert.equal(PAYPAL_TOOLS.find(t=>t.name===name).annotations.readOnlyHint,true);
  assert.match(PAYPAL_TOOLS.find(t=>t.name==='paypal_purchase').description,/SAME request_id/);
  assert.match(PAYPAL_TOOLS.find(t=>t.name==='paypal_request_approval').description,/cannot approve/);
  const init=await handlePayPalMessage(message('initialize',{protocolVersion:'2024-11-05'}),{});
  assert.match(init.result.instructions,/never sees the vault token/);assert.match(init.result.instructions,/same request_id/);
  const modern=await handlePayPalMessage(message('server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':CURRENT_PROTOCOL_VERSION,'io.modelcontextprotocol/clientCapabilities':{}}}),{});
  assert.equal(modern.result._meta['io.modelcontextprotocol/serverInfo'].name,'chainpay-paypal');
});
test('agent role is checked before any tool and changed arguments are rejected',async()=>{
  let calls=0;
  const client={requireAgent:async()=>{throw new Error('agent-role grant required');},process:async()=>{calls++;return {};}};
  const response=await handlePayPalMessage(message('tools/call',{name:'paypal_run_paid_task',arguments:{task_id:'a'.repeat(32)}}),client);
  assert.equal(response.result.isError,true);assert.equal(calls,0);
  const extra=await handlePayPalMessage(message('tools/call',{name:'paypal_run_paid_task',arguments:{task_id:'a'.repeat(32),amount:'0.01'}}),client);
  assert.equal(extra.error.code,-32602);
});
test('notifications do not produce replies or trigger tools',async()=>{
  assert.equal(await handlePayPalMessage({jsonrpc:'2.0',method:'notifications/initialized'},{}),undefined);
});

test('requirements without service selection are rejected before quoting',async()=>{
  let quotes=0;
  const client={requireAgent:async()=>{},quote:async()=>{quotes++;}};
  const response=await handlePayPalMessage(message('tools/call',{name:'paypal_prepare_task',arguments:{request_id:'request-123456789',documents:[{name:'A',text:'Terms'}],requirements:'Private terms'}}),client);
  assert.equal(response.result.isError,true);
  assert.equal(quotes,0);
});

test('MCP forwards selected service and exact requirements through the real SDK',async()=>{
  const {PayPalAgentClient}=await import('@chainpayhq/sdk/paypal');
  const {createServer}=await import('node:http');
  const requests=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req) body+=chunk;
    requests.push({path:req.url,body:body?JSON.parse(body):null,authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url.endsWith('/session')?{role:'agent'}:{id:'a'.repeat(32),quote_digest:'secret'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const client=new PayPalAgentClient({enabled:true,apiOrigin:origin,workspaceOrigin:origin,token:'b'.repeat(64)});
    const args={request_id:'request-123456789',service_id:'requirements-check-v1',requirements:'Exact private terms\n≤ five days',documents:[{name:'A',text:'Delivery within three working days.'}]};
    const response=await handlePayPalMessage(message('tools/call',{name:'paypal_prepare_task',arguments:args}),client);
    assert.ok(!response.result.isError);
    assert.deepEqual(requests.map(r=>r.path),['/v1/paypal/session','/v1/paypal/tasks']);
    assert.deepEqual(requests[1].body,args);
    assert.equal(requests[1].authorization,`Bearer ${'b'.repeat(64)}`);
    assert.ok(!JSON.stringify(response).includes('quote_digest'));
    const {request_id, ...input} = args;
    await handlePayPalMessage(message('tools/call',{name:'paypal_preflight',arguments:input}),client);
    assert.equal(requests.at(-1).path,'/v1/paypal/preflight');
    assert.deepEqual(requests.at(-1).body,input);
    const objective={objective:'Compare delivery times without approving a payment'};
    await handlePayPalMessage(message('tools/call',{name:'paypal_recommend_service',arguments:objective}),client);
    assert.equal(requests.at(-1).path,'/v1/paypal/recommend-service');
    assert.deepEqual(requests.at(-1).body,objective);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('assistance runtime shapes reject malformed inputs before forwarding',async()=>{
  let forwarded=0;
  const client={requireAgent:async()=>{},preflight:async()=>{forwarded++;},recommendService:async()=>{forwarded++;}};
  for(const [name,args] of [
    ['paypal_recommend_service',{objective:42}],
    ['paypal_recommend_service',{objective:'é'.repeat(1001)}],
    ['paypal_recommend_service',{objective:' '}],
    ['paypal_preflight',{service_id:'custom',documents:[{name:'A',text:'source'}]}],
    ['paypal_preflight',{service_id:'document-extract-v1',documents:[null]}],
    ['paypal_preflight',{service_id:'document-extract-v1',documents:[{name:'A',text:'é'.repeat(8001)}]}],
    ['paypal_preflight',{service_id:'document-extract-v1',documents:[{name:'A',text:'source',price:'0.01'}]}],
  ]) {
    const response=await handlePayPalMessage(message('tools/call',{name,arguments:args}),client);
    assert.equal(response.result.isError,true);
  }
  assert.equal(forwarded,0);
});

test('delegated allowance tool rejects money and limit override arguments',async()=>{
 const client={requireAgent:async()=>{},consumeAllowance:async(...args)=>({args})};
 const args={task_id:'a'.repeat(32),subscription_id:'b'.repeat(32),delegation_id:'c'.repeat(32)};
 const result=await handlePayPalMessage(message('tools/call',{name:'paypal_consume_allowance',arguments:args}),client);
 assert.equal(result.result.isError,false);
 for(const key of ['buyer','amount','period_limit']){const result=await handlePayPalMessage(message('tools/call',{name:'paypal_consume_allowance',arguments:{...args,[key]:'override'}}),client);assert.equal(result.error.code,-32602);}
});

test('purchase tools forward exact arguments and reject anything that could widen the allowance',async()=>{
 const seen=[];
 const client={requireAgent:async()=>{},purchase:async(...args)=>{seen.push(args);return {kind:'receipt'};},requestPurchaseApproval:async(...args)=>{seen.push(args);return {kind:'approval_requested'};},quotePurchase:async(input)=>{seen.push(input);return {};},requestRefund:async(...args)=>{seen.push(args);return {};},findAllowance:async()=>({allowances:[]}),listApprovals:async()=>({approvals:[]}),searchCatalog:async(q)=>{seen.push(q);return {merchants:[]};}};
 const args={request_id:'purchase-request-stays-same',allowance_id:'a'.repeat(32),merchant:'grocer',items:[{id:'oat-milk',qty:2}]};
 for(const [name,mode] of [['paypal_purchase','agent_pays'],['paypal_request_approval','ask_first']]){
  const ok=await handlePayPalMessage(message('tools/call',{name,arguments:args}),client);
  assert.equal(ok.result.isError,false);assert.deepEqual(seen.at(-1),['purchase-request-stays-same','a'.repeat(32),'grocer',[{id:'oat-milk',qty:2}],mode]);
  for(const key of ['amount_cents','vault','approval','digest','per_purchase_cap_cents','approval_only']){const r=await handlePayPalMessage(message('tools/call',{name,arguments:{...args,[key]:'override'}}),client);assert.equal(r.error.code,-32602);}
  const missing=await handlePayPalMessage(message('tools/call',{name,arguments:{allowance_id:'a'.repeat(32),merchant:'grocer',items:args.items}}),client);
  assert.equal(missing.result.isError,true);
 }
 const quote=await handlePayPalMessage(message('tools/call',{name:'paypal_quote_purchase',arguments:{merchant:'grocer',items:args.items}}),client);
 assert.equal(quote.result.isError,false);assert.deepEqual(seen.at(-1),{merchant:'grocer',items:args.items,allowance_id:undefined});
 const quoteExtra=await handlePayPalMessage(message('tools/call',{name:'paypal_quote_purchase',arguments:{merchant:'grocer',items:args.items,request_id:'x'.repeat(16)}}),client);
 assert.equal(quoteExtra.error.code,-32602);
 const search=await handlePayPalMessage(message('tools/call',{name:'paypal_search_catalog',arguments:{q:'milk'}}),client);
 assert.equal(search.result.isError,false);assert.equal(seen.at(-1),'milk');
 const refund=await handlePayPalMessage(message('tools/call',{name:'paypal_request_refund',arguments:{task_id:'b'.repeat(32),reason:'Carton arrived open'}}),client);
 assert.equal(refund.result.isError,false);assert.deepEqual(seen.at(-1),['b'.repeat(32),'Carton arrived open']);
 const refundAmount=await handlePayPalMessage(message('tools/call',{name:'paypal_request_refund',arguments:{task_id:'b'.repeat(32),reason:'x',amount:'99.00'}}),client);
 assert.equal(refundAmount.error.code,-32602);
 for(const name of ['paypal_find_allowance','paypal_list_approvals']){
  const ok=await handlePayPalMessage(message('tools/call',{name,arguments:{}}),client);assert.equal(ok.result.isError,false);
  const extra=await handlePayPalMessage(message('tools/call',{name,arguments:{status:'Active'}}),client);assert.equal(extra.error.code,-32602);
 }
});

test('purchase through the real SDK keeps request_id and never leaks the vault or digests',async()=>{
 const {PayPalAgentClient}=await import('@chainpayhq/sdk/paypal');
 const {createServer}=await import('node:http');
 const requests=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req) body+=chunk;
  requests.push({path:req.url,body:body?JSON.parse(body):null});
  res.setHeader('content-type','application/json');
  const answer=req.url.endsWith('/session')?{role:'agent'}:req.url.endsWith('/allowances')?{allowances:[{id:'a'.repeat(32),status:'Active',vault:{source:'paypal',status:'ready'}}]}:{id:'c'.repeat(32),quote_digest:'secret',share_token:'secret',purchase:{approval:'requested',policy:{allowed:true}}};
  res.end(JSON.stringify(answer));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const origin=`http://127.0.0.1:${server.address().port}`;
  const client=new PayPalAgentClient({enabled:true,apiOrigin:origin,workspaceOrigin:origin,token:'b'.repeat(64)});
  const found=await handlePayPalMessage(message('tools/call',{name:'paypal_find_allowance',arguments:{}}),client);
  assert.ok(!JSON.stringify(found).includes('vault'));
  const args={request_id:'purchase-request-stays-same',allowance_id:'a'.repeat(32),merchant:'grocer',items:[{id:'oat-milk',qty:2}]};
  const first=await handlePayPalMessage(message('tools/call',{name:'paypal_request_approval',arguments:args}),client);
  const again=await handlePayPalMessage(message('tools/call',{name:'paypal_request_approval',arguments:args}),client);
  assert.equal(first.result.structuredContent.kind,'approval_requested');
  assert.equal(first.result.structuredContent.review_url,`${origin}/paypal/?task=${'c'.repeat(32)}`);
  const posts=requests.filter(r=>r.path==='/v1/paypal/purchases');
  assert.equal(posts.length,2);assert.deepEqual(posts[0].body,{...args,mode:'ask_first',approval_only:true});assert.deepEqual(posts[1].body,{...args,mode:'ask_first',approval_only:true});
  assert.ok(!JSON.stringify([first,again]).includes('secret'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('threshold mode works through MCP and real SDK while approval requests remain approval-only', async () => {
 const {PayPalAgentClient}=await import('@chainpayhq/sdk/paypal');
 const old=globalThis.fetch;const posts=[];
 globalThis.fetch=async(url, init)=>{
  if(url.endsWith('/session'))return Response.json({role:'agent'});
  const body=JSON.parse(init.body);posts.push(body);
  return Response.json({id:'c'.repeat(32),purchase:{policy:{allowed:true},approval:'requested'}});
 };
 try {
  const client=new PayPalAgentClient({enabled:true,apiOrigin:'https://paypal-api.example',workspaceOrigin:'https://paypal-ui.example',token:'a'.repeat(64)});
  const args={request_id:'threshold-request-stable',allowance_id:'a'.repeat(32),merchant:'grocer',items:[{id:'oat-milk',qty:2}],mode:'ask_above'};
  for(const name of ['paypal_purchase','paypal_request_approval']) {
   const r=await handlePayPalMessage(message('tools/call',{name,arguments:args}),client);
   assert.equal(r.result.isError,false);assert.equal(r.result.structuredContent.kind,'approval_requested');
  }
  assert.deepEqual(posts[0],args);assert.deepEqual(posts[1],{...args,approval_only:true});
  for(const [name,mode] of [['paypal_request_approval','agent_pays'],['paypal_purchase','unknown'],['paypal_request_approval','unknown']]){
   const r=await handlePayPalMessage(message('tools/call',{name,arguments:{...args,mode}}),client);
   assert.equal(r.result.isError,true);
  }
  assert.equal(posts.length,2);
 }finally{globalThis.fetch=old;}
});
