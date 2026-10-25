import test from 'node:test';
import assert from 'node:assert/strict';
import {handlePayPalMessage,PAYPAL_TOOLS} from '../dist/paypal.js';
import {CURRENT_PROTOCOL_VERSION} from '../dist/protocol.js';
const message=(method,params={})=>({jsonrpc:'2.0',id:1,method,params});
test('isolated MCP discovery contains only non-approving PayPal tools',async()=>{
  const response=await handlePayPalMessage(message('tools/list'),{});
  assert.equal(response.result.tools.length,7);
  assert.ok(PAYPAL_TOOLS.every(t=>t.name.startsWith('paypal_')));
  assert.ok(PAYPAL_TOOLS.every(t=>!['paypal_capture','paypal_refund','execute_payment'].includes(t.name)));
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
  } finally {await new Promise(resolve=>server.close(resolve));}
});
