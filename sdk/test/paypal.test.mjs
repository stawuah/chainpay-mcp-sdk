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
