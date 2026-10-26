// Human resolution UI fixtures; no provider/model traffic.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true});
const base=process.env.PAYPAL_BROWSER_BASE || 'http://127.0.0.1:5197';
try {
 const page=await browser.newPage();let loseDecision=false;const calls=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const review=page.getByRole("region",{name:"Buyer resolution"});
 const task={id:'a'.repeat(32),service_name:'Summary',offer_version:'document-extract-v1',created_at:1,units:[0,1].map(index=>({index,name:`Document ${index+1}`,revision:0,state:'delivered',input_hash:'source',output_hash:'original',result:{model:'fixture',output:{summary:'Delivered source review',facts:[]}}})),gross:'8.00',net:'8.00',refund:'0.00',captured:true,funded:true,refund_confirmed:false,resolution:[],revisions:[[],[]],refunds:[]};
 await page.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{
  const request=route.request();const path=new URL(request.url()).pathname;const body=request.postDataJSON();const role=request.headers().authorization?.includes('merchant')?'merchant':'buyer';let result={};calls.push({path,body,role});
  if(path.endsWith('/session'))result={id:role,workspace:'fixture',role};
  else if(path.endsWith('/offers'))result={offers:[]};
  else if(path.endsWith('/tasks'))result={tasks:[task]};
  else if(path.endsWith('/resolution')){if(loseDecision){loseDecision=false;await route.abort('failed');return;}task.resolution.push({actor:role,role,timestamp:1,intent:body});task.units[body.binding.unit].buyer_review=body.action;result=task;}
  else if(path.endsWith('/rework')){const u=task.units[body.binding.unit];task.revisions[u.index].push({...u});u.revision++;u.buyer_review=null;u.state='pending';u.output_hash=null;u.result=null;task.resolution.push({actor:role,role,timestamp:2,intent:body});result=task;}
  else if(path.endsWith('/resolution-refunds/approve')){task.refunds.find(r=>r.digest===body.digest).state='unknown';task.refund_pending=true;task.reserved_refunds='4.00';result=task;}
  else if(path.endsWith('/resolution-refunds')){task.refunds.push({...body,digest:`bound-proposal-${task.refunds.length}`,amount:'4.00',confirmed:false,state:null});result=task;}
  else if(path.includes('/tasks/'))result=task;
  else if(path.includes('/receipts/')){const {resolution,revisions,refunds,legacy_refund_units,...publicTask}=task;result={...publicTask,units:task.units.map(({index,revision,state,input_hash,output_hash,buyer_review})=>({index,revision,state,input_hash,output_hash,buyer_review}))};}
  else if(path.endsWith('/subscriptions'))result={subscriptions:[]};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 });
 const login=async role=>{await page.goto(`${base}/paypal/?task=${task.id}`);await page.getByLabel('Workspace access code').fill(role);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.getByRole('heading',{name:'2 outputs, one clear record.'}).waitFor();};
 await login('buyer');
 await page.getByLabel('Review reason').fill('é'.repeat(1001));assert.equal(await page.getByRole('button',{name:'Accept output 1',exact:true}).isDisabled(),true);await page.getByText('2002 / 2000 UTF-8 bytes.',{exact:false}).waitFor();
 await page.getByLabel('Review reason').fill('Source excerpt is missing.');
 for(const action of ['Accept','Challenge','Accept']){await page.getByRole('button',{name:`${action} output 1`,exact:true}).click();await review.getByText(action==='Accept'?'Accepted by buyer':'Challenged by buyer',{exact:true}).waitFor();}
 const accepts=calls.filter(c=>c.body?.action==='accept');assert.equal(accepts.length,2);assert.notEqual(accepts[0].body.request_id,accepts[1].body.request_id);
 loseDecision=true;await page.getByRole('button',{name:'Challenge output 1',exact:true}).click();await page.getByRole('alert').filter({hasText:"No response yet. Keep the original request and check it again; do not create another."}).waitFor();
 await page.getByRole('button',{name:'Challenge output 1',exact:true}).click();await review.getByText('Challenged by buyer',{exact:true}).waitFor();
 const challenges=calls.filter(c=>c.body?.action==='challenge');assert.equal(challenges.at(-1).body.request_id,challenges.at(-2).body.request_id);
 await page.getByRole('button',{name:'Challenge output 2',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('p')].filter(p=>p.textContent==='Challenged by buyer').length===2);
 assert.equal(await page.getByRole('button',{name:/Approve free rework/}).count(),0);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await login('merchant');
 await page.getByLabel('Review reason').fill('Approved free rework and refund review.');
 await page.getByLabel('Refund output 1',{exact:true}).check();await page.getByRole('button',{name:'Prepare selected-output refund',exact:true}).click();await page.getByText('Awaiting merchant approval',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Refund output 1',{exact:true}).isChecked(),false);
 await page.getByLabel('Refund output 1',{exact:true}).check();
 await page.getByRole('button',{name:'Approve free rework for output 1',exact:true}).click();
 await page.getByText('Proposal is stale:',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Prepare selected-output refund',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Approve $4.00 selected-output refund',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Review failed-unit refund',exact:true}).count(),0);
 await page.getByText('Original outputs and earlier revisions',{exact:true}).click();await page.getByText(/"summary": "Delivered source review"/).waitFor();
 await page.getByLabel('Refund output 2',{exact:true}).check();await page.getByRole('button',{name:'Prepare selected-output refund',exact:true}).click();
 await page.getByText('Awaiting merchant approval',{exact:true}).waitFor();await page.getByRole('button',{name:'Approve $4.00 selected-output refund',exact:true}).last().click();await page.getByText('Refund reserved; check original provider record',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/resolution-refunds/approve')).length,1);
 assert.deepEqual(calls.filter(c=>c.path.endsWith('/resolution-refunds')).at(-1).body.bindings.map(b=>b.unit),[1]);
 await page.getByText('Payment unresolved',{exact:true}).waitFor();await page.getByText('$8.00 · Payment unresolved',{exact:true}).waitFor();
 for(const call of calls.filter(c=>c.body?.binding)){assert.equal(call.body.binding.revision,0);assert.equal(call.body.binding.output_hash,'original');assert.ok(call.body.request_id.length>=16);}
 assert.deepEqual(errors,[]);await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.goto(`${base}/paypal/receipt/${'b'.repeat(64)}`);await page.getByText('Revision 0 · Challenged by buyer',{exact:true}).waitFor();await page.getByText('Revision 1 · Buyer acceptance not recorded',{exact:true}).waitFor();await page.getByText('Payment unresolved',{exact:true}).waitFor();assert.equal(await review.count(),0);
 console.log('Buyer challenges → merchant free rework / selected refund browser fixture passed.');
}finally{await browser.close();}
