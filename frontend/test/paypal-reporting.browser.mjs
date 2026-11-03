// Reconciliation inbox fixtures only; never PayPal/model network calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true});
const base=process.env.PAYPAL_BROWSER_BASE || 'http://127.0.0.1:5197';
try {
 const page=await browser.newPage();const errors=[];const calls=[];let pages=0;let delayed=false;let release;
 page.on('pageerror',e=>errors.push(e.message));
 const row={id:'a'.repeat(64),transaction_id:'TX-FIXTURE',event_code:'T0006',provider_status:'S',references:['CAPTURE'],amount:{value:'12.00',currency_code:'USD'},fee:{value:'-0.55',currency_code:'USD'},net:null,checked_at:1792800000,changed:true,observation_count:2,status:'ambiguous',matches:['task:one','task:two'],observation_ambiguity:true,observations:[{hash:'old',provider_status:'P',amount:{value:'12.00',currency_code:'USD'},fee:null,net:null},{hash:'new',provider_status:'S',amount:{value:'12.00',currency_code:'USD'},fee:{value:'-0.55',currency_code:'USD'},net:null}]};
 const inbox=()=>({cursor:pages?{coverage_start:1792700000,window_start:1792700000,window_end:1792800000,next_page:3,completed:pages>1,watermark:pages>1?1792800000:null,checked_at:1792800000}:null,rows:pages?[row,{...row,id:'b'.repeat(64),transaction_id:'TX-JPY',status:'unmatched',matches:[],changed:false,observation_count:1,observation_ambiguity:false,amount:{value:'1200',currency_code:'JPY'},fee:null}]:[],next:pages?'b'.repeat(64):null,note:'Incomplete provider coverage; observation matching is not settlement.'});
 await page.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{
  const req=route.request();const path=new URL(req.url()).pathname;calls.push({path,method:req.method()});let data={};
  const role=req.headers().authorization?.includes('buyer')?'buyer':'merchant';
  if(path.endsWith('/session')) data={id:role,workspace:'fixture',role};
  else if(path.endsWith('/tasks'))data={tasks:[]};
  else if(path.endsWith('/offers'))data={offers:[]};
  else if(path.endsWith('/subscriptions'))data={subscriptions:[]};
  else if(path.endsWith('/reporting/sync')){pages++;data=inbox();}
  else if(path.endsWith('/reporting/inbox'))data=inbox();
  else if(path.endsWith('/explain')){if(delayed)await new Promise(resolve=>{release=resolve;});data={explanation:'Ambiguous references require merchant review.',citations:[row.id]};}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
 });
 const login=async role=>{await page.goto(`${base}/paypal/`);await page.getByLabel('Workspace access code').fill(role);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();};
 await login('merchant');
 const region=page.getByRole('region',{name:'Merchant reconciliation inbox'});
 await region.getByRole('button',{name:'Merchant reconciliation inbox',exact:true}).click();
 await region.getByText('No sync yet.',{exact:false}).waitFor();
 await region.getByRole('button',{name:'Sync transactions',exact:true}).click();
 await region.getByText('Incomplete; next page 3',{exact:true}).waitFor();
 await region.getByText('-0.55 USD',{exact:true}).waitFor();
 await region.getByText('1200 JPY',{exact:true}).waitFor();
 await region.getByText('Unknown (provider-reported only)',{exact:true}).first().waitFor();
 await region.getByRole('button',{name:'Explain row',exact:true}).first().click();
 await region.getByText('Ambiguous references require merchant review.',{exact:true}).waitFor();
 await region.getByText(`Citations: ${row.id}`,{exact:true}).waitFor();
 await region.getByRole('button',{name:'Resume sync',exact:true}).click();
 await region.getByText('Window imported; provider coverage remains incomplete',{exact:true}).waitFor();
 await page.reload();await region.getByRole('button',{name:'Merchant reconciliation inbox',exact:true}).click();await region.getByText('ambiguous · TX-FIXTURE',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/reporting/sync')).length,2);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 delayed=true;await region.getByRole('button',{name:'Explain row',exact:true}).first().click();
 await page.waitForTimeout(100);assert.equal(await region.getByRole('button',{name:'Merchant reconciliation inbox',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Sign out',exact:true}).click();release?.();
 await page.getByLabel('Workspace access code').fill('buyer');await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();assert.equal(await region.count(),0);assert.equal(await page.getByText('Ambiguous references require merchant review.',{exact:true}).count(),0);
 assert.equal(calls.filter(c=>/capture|refund/.test(c.path)).length,0);assert.deepEqual(errors,[]);
 console.log('Reporting sync/resume, signed amounts, mixed currencies, persistence, citations and sign-out fixture passed.');
}finally{await browser.close();}
