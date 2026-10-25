import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage();let delegated=false;let allocated=false;let owner='buyer-one';const calls=[];
 const sid='b'.repeat(32),tid='a'.repeat(32),did='c'.repeat(32);
 const task=()=>({id:tid,sandbox:true,currency:'USD',gross:'4.00',refund:'0.00',net:null,captured:false,funded:allocated,subscription_funding:allocated?{units:1,payment_id:'SALE-fixture',period_end:1999999999}:undefined,refund_confirmed:false,units:[{index:0,state:'pending',input_hash:'fixture'}],quote_digest:'original-digest',quote_expires_at:1999999999,created_at:1770000000});
 await page.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON();calls.push({path,body});let result={};
 if(path.endsWith('/session'))result={id:owner,workspace:'fixture',role:'buyer'};
 else if(path.endsWith('/offers'))result={offers:[{id:'document-extract-v1',name:'Summary',unit_price:'4.00',min_documents:1,max_documents:10}]};
 else if(path.endsWith('/subscriptions/terms'))result={terms:'terms-fixture',plan_id:'P-FIXTURE',enabled:true,policy:'ChainPay service periods; no rollover or overage.'};
 else if(path.endsWith('/subscriptions'))result={subscriptions:owner==='buyer-one'?[{subscription:{id:sid,status:'ACTIVE',create:{state:'observed'}},periods:[{start_at:1770000000,end_at:1999999999,available:allocated?9:10,payment_id:'SALE-fixture'}],delegations:delegated?[{id:did,agent:'distinct-agent',services:['document-extract-v1'],task_limit:1,period_limit:3,expires_at:1999999999,revoked:false}]:[]}]:[]};
 else if(path.endsWith('/delegations')){delegated=true;result={id:did};}
 else if(path.endsWith('/allowance')){allocated=true;result=task();}
 else if(path.endsWith('/tasks'))result={tasks:owner==='buyer-one'?[task()]:[]};
 await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto((process.env.PAYPAL_BROWSER_BASE||'http://127.0.0.1:5197')+'/paypal/');
 await page.getByLabel('Workspace access code').fill('buyer-one-token');await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await page.getByRole('heading',{name:'Monthly service allowance'}).waitFor();
 await page.getByLabel('Agent identity').fill('distinct-agent');await page.getByLabel('Units per task',{exact:true}).fill('1');await page.getByLabel('Units per service period').fill('3');const expires=new Date(Date.now()+7*86400000);const localExpiry=new Date(expires.getTime()-expires.getTimezoneOffset()*60000).toISOString().slice(0,16);await page.getByLabel('Expiry',{exact:true}).fill(localExpiry);
 await page.getByRole('button',{name:'Approve exactly these agent limits'}).click();await page.getByRole('button',{name:'Revoke new allocations'}).waitFor();
 const approval=calls.find(c=>c.path.endsWith('/delegations'));assert.equal(approval.body.agent,'distinct-agent');assert.equal(approval.body.period_limit,3);assert.ok(approval.body.request_id);assert.ok(approval.body.expires_at>Date.now()/1000);assert.ok(approval.body.expires_at<Date.now()/1000+366*86400);
 await page.getByRole('navigation',{name:'Task receipts'}).getByRole('button').click();
 await page.getByRole('button',{name:/Approve allocation of 1 units/}).click();await page.getByText(/Prepaid service allocation: 1 units/).waitFor();
 assert.equal(await page.getByRole('button',{name:/open checkout/}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Run or recover this paid task'}).count(),1);
 assert.deepEqual(calls.find(c=>c.path.endsWith('/allowance')).body,{subscription_id:sid,digest:'original-digest'});
 await page.getByRole('button',{name:'Sign out',exact:true}).click();owner='buyer-two';await page.getByLabel('Workspace access code').fill('buyer-two-token');await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.getByRole('heading',{name:'Monthly service allowance'}).waitFor();
 assert.equal(await page.getByText('SALE-fixture',{exact:true}).count(),0);assert.equal(await page.getByLabel('Agent identity').count(),0);
 console.log('Subscription allocation, explicit delegation terms, receipt truth and sign-out isolation browser fixture passed.');
 await page.close();
 // Funding remains allocated even when review blocks processing and the quote expires.
 for(const role of ['buyer','merchant']) for(const expired of [false,true]) {
  const context=await browser.newContext();const p=await context.newPage();
  const receipt={id:tid,sandbox:true,currency:'USD',gross:'4.00',refund:'0.00',net:null,captured:false,funded:false,payment_review:'Funding requires billing review',subscription_funding:{units:1,payment_id:'SALE-blocked',period_end:1999999999},refund_confirmed:false,units:[{index:0,state:'pending',input_hash:'fixture'}],quote_digest:'digest',quote_expires_at:expired?1:1999999999,created_at:1770000000};
  await p.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{const path=new URL(route.request().url()).pathname;let result={};
   if(path.endsWith('/session'))result={id:role,workspace:'fixture',role};
   else if(path.endsWith('/offers'))result={offers:[]};
   else if(path.endsWith('/subscriptions/terms'))result={terms:'terms',plan_id:'P',enabled:true,policy:'ChainPay policy'};
   else if(path.endsWith('/subscriptions'))result={subscriptions:[{subscription:{id:sid,status:'ACTIVE',create:{state:'observed'}},periods:[{start_at:1770000000,end_at:1999999999,available:0,payment_id:'SALE-unallocated',blocked:true}],delegations:[]}]};
   else if(path.endsWith('/tasks'))result={tasks:[receipt]};
   await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await p.goto((process.env.PAYPAL_BROWSER_BASE||'http://127.0.0.1:5197')+'/paypal/');await p.getByLabel('Workspace access code').fill(role+'-token');await p.getByRole('button',{name:'Open workspace',exact:true}).click();
  await p.getByText('SALE-unallocated',{exact:true}).waitFor();
  await p.getByRole('navigation',{name:'Task receipts'}).getByRole('button').click();await p.getByText(/Prepaid service allocation/).waitFor();
  assert.equal(await p.getByRole('button',{name:/open checkout|Approve allocation|Allocate this quote/}).count(),0);
  assert.equal(await p.getByText(/This quote expired/).count(),0);
  if(role==='merchant')assert.equal(await p.getByRole('button',{name:/Approve.*subscription terms|Confirm cancel|Approve exactly|Revoke new/}).count(),0);
  await context.close();
 }
 // Retry/reload retains an unresolved create identity; an explicit post-cancellation purchase rotates once.
 {
  const context=await browser.newContext();const p=await context.newPage();let status='';const ids=[];let reject=false;
  await p.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let result={};
   const view=()=>({subscription:{id:sid,status,create:{state:status==='CREATE_PENDING'?'unknown':'observed'}},periods:[],delegations:[]});
   if(path.endsWith('/session'))result={id:'retry-buyer',workspace:'fixture',role:'buyer'};
   else if(path.endsWith('/offers'))result={offers:[]};else if(path.endsWith('/tasks'))result={tasks:[]};
   else if(path.endsWith('/subscriptions/terms'))result={terms:'terms',plan_id:'P',enabled:true,policy:'policy'};
   else if(path.endsWith('/subscriptions')&&req.method()==='POST'){ids.push(req.postDataJSON().request_id);if(reject){await route.abort();return;}status='CREATE_PENDING';result=view();}
   else if(path.endsWith('/subscriptions'))result={subscriptions:status?[view()]:[]};
   await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await p.goto((process.env.PAYPAL_BROWSER_BASE||'http://127.0.0.1:5197')+'/paypal/');await p.getByLabel('Workspace access code').fill('retry-token');await p.getByRole('button',{name:'Open workspace',exact:true}).click();
  const approve=p.getByRole('button',{name:'Approve $40.00 monthly subscription terms',exact:true});await approve.click();await p.getByText('CREATE_PENDING · create unknown',{exact:true}).waitFor();const first=ids[0];
  await p.reload();await p.getByText('CREATE_PENDING · create unknown',{exact:true}).waitFor();assert.equal(await approve.isDisabled(),true);assert.equal(await p.evaluate(()=>sessionStorage.getItem('chainpay.paypal.subscription:fixture:retry-buyer:create')),first);
  status='CANCELLED';await p.getByRole('button',{name:'Refresh allowance',exact:true}).click();await p.getByText('CANCELLED · create observed',{exact:true}).waitFor();reject=true;
  await approve.click();await p.getByRole('alert').waitFor();assert.notEqual(ids[1],first);const replacement=ids[1];
  await p.reload();await p.getByText('CANCELLED · create observed',{exact:true}).waitFor();reject=false;await approve.click();await p.getByText('CREATE_PENDING · create unknown',{exact:true}).waitFor();assert.equal(ids[2],replacement);
  await context.close();
 }
 console.log('Blocked funding, merchant billing references and cancelled/unknown subscription identity fixtures passed.');

} finally {await browser.close();}
