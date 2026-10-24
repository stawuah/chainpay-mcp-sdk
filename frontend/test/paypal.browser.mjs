// Rendering/authorization affordance fixtures, not provider or model acceptance.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.PAYPAL_BROWSER_BASE || 'http://127.0.0.1:5197';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  for (const width of [1440,390]) {
    const context=await browser.newContext({viewport:{width,height:1000}});
    const page=await context.newPage();const errors=[];const external=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
    page.on('console',m=>{if(m.type()==='error') console.error(m.text());});
    page.on('request',r=>{if(r.url().includes('chainpay-relay') || r.url().includes('convex')) external.push(r.url());});
    let tasks=[];
    const receipt={id:'fixture-task',sandbox:true,currency:'USD',gross:'12.00',refund:'4.00',net:'12.00',captured:true,refund_confirmed:false,quote_digest:'fixture-digest',created_at:1792800000,order_id:'ORDER',capture_id:'CAPTURE',units:[
      {index:0,name:'North supplier terms · sample',state:'delivered',input_hash:'a'.repeat(64),output_hash:'b'.repeat(64),result:{model:'fixture model',output:{summary:'Fixture rendering: delivery takes three days.',facts:[{claim:'Three-day delivery',evidence:'three working days'}]}}},
      {index:1,name:'South supplier terms · sample',state:'delivered',input_hash:'c'.repeat(64),output_hash:'d'.repeat(64)},
      {index:2,name:'Unreadable document · intentional sample',state:'failed',input_hash:'e'.repeat(64),reason:'Input does not contain enough readable text'}]};
    await page.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{
      const request=route.request();const path=new URL(request.url()).pathname;
      const merchant=request.headers().authorization?.includes('merchant');
      let body={};
      if(path.endsWith('/session')) body={id:merchant?'merchant':'buyer',workspace:'fixture',role:merchant?'merchant':'buyer'};
      else if(path.endsWith('/tasks') && request.method()==='POST'){const input=request.postDataJSON();assert.equal(input.documents.length,3);tasks=[receipt];body=receipt;}
      else if(path.endsWith('/tasks')) body={tasks};
      else if(path.endsWith('/analytics')) body={captured:'12.00',confirmed_refunds:receipt.refund_confirmed?'4.00':'0.00',known_net_cost:receipt.net,delivered_units:2,failed_units:1,unresolved_tasks:0,task_count:1,scope:'Latest 100 tasks accessible to this principal; not lifetime totals',tasks:[receipt]};
      else if(path.endsWith('/analytics/ask')) body={answer:'Fixture analyst: confirmed net cost is USD 8.00.'};
      else if(path.endsWith('/refund-proposal')) body={amount:'4.00',digest:'refund-fixture',reason:'One failed unit.'};
      else if(path.endsWith('/refund')){assert.ok(merchant);receipt.refund_confirmed=true;receipt.net='8.00';body=receipt;}
      else if(path.endsWith('/share')) body={token:'f'.repeat(64)};
      else if(path.endsWith('/explain')) body={explanation:'Fixture explanation: one failed unit needs merchant review.'};
      else body=receipt;
      await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':base,'Access-Control-Allow-Headers':'authorization,content-type'},body:JSON.stringify(body)});
    });
    await page.goto(`${base}/paypal/`);
    await page.getByLabel('Workspace access code').fill('buyer-fixture');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.getByRole('button',{name:'Use three sample documents'}).click();
    await page.getByRole('button',{name:'Prepare quote',exact:true}).click();
    await page.getByRole('heading',{name:'3 documents, one clear record.'}).waitFor();
    assert.equal(await page.getByRole('button',{name:/Approve .* quote/}).count(),0);
    await page.getByRole('button',{name:'Review failed-unit refund'}).click();
    await page.getByText('A merchant must review and approve this refund.').waitFor();
    assert.equal(await page.getByRole('button',{name:/Approve .* sandbox refund/}).count(),0);
    await page.getByRole('button',{name:'Ask AI to explain this receipt'}).click();
    await page.getByText('AI explanation · not payment authority').waitFor();
    await page.getByRole('button',{name:'Share redacted receipt'}).click();
    await page.getByLabel('Public receipt URL').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`/private/tmp/chainpay-paypal-${width}.png`,fullPage:true});
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByLabel('Workspace access code').fill('merchant-fixture');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.getByRole('heading',{name:'3 documents, one clear record.'}).waitFor();
    assert.equal(await page.getByRole('button',{name:/Approve .* quote/}).count(),0);
    await page.getByRole('button',{name:'Review failed-unit refund'}).click();
    await page.getByRole('button',{name:'Approve $4.00 sandbox refund'}).click();
    await page.getByText('Refund confirmed',{exact:true}).waitFor();
    await page.getByText('$8.00',{exact:true}).waitFor();
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(()=>document.activeElement!==document.body));
    await page.getByRole('button',{name:'Outcome dashboard',exact:true}).click();
    await page.getByRole('heading',{name:'Confirmed buyer cost',exact:true}).waitFor().catch(async e=>{await page.screenshot({path:'/private/tmp/paypal-analytics-error.png',fullPage:true});console.error(await page.locator('body').innerText());throw e;});
    await page.getByRole('heading',{name:'Work outcomes',exact:true}).waitFor();
    await page.getByRole('heading',{name:'Receipt evidence',exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh snapshot',exact:true}).click();
    await page.getByRole('heading',{name:'Confirmed buyer cost',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`/private/tmp/chainpay-paypal-analytics-${width}.png`,fullPage:true});
    if(width===1440){
      await page.getByText('AI Assistant',{exact:true}).click();
      await page.getByText('Explain my costs',{exact:true}).click();
      await page.getByText(/Fixture analyst: confirmed net cost/).waitFor();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await context.close();
  }
  console.log('PayPal desktop/mobile buyer/merchant receipt fixtures passed. No provider/model acceptance claimed.');
} finally {await browser.close();}
