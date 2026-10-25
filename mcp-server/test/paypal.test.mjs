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
