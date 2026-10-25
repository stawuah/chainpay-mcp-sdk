// Rendering/authorization affordance fixtures, not provider or model acceptance.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const artifacts=join(tmpdir(),'chainpay-paypal-browser');
await mkdir(artifacts,{recursive:true});
const base=process.env.PAYPAL_BROWSER_BASE || 'http://127.0.0.1:5197';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const merchantContext=await browser.newContext();
  const requests=[];
  await merchantContext.route('**/*',async route=>{
    const request=route.request();requests.push({url:request.url(),headers:request.headers(),body:request.postData()});
    const path=new URL(request.url()).pathname;
    if(path==='/demo-merchant/paypal.html') return route.fulfill({contentType:'text/html',body:await readFile(new URL('../../demo-merchant/paypal.html',import.meta.url),'utf8')});
    if(path==='/sdk/dist/paypal-widget.js') return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../sdk/dist/paypal-widget.js',import.meta.url),'utf8')});
    if(path==='/paypal/') return route.fulfill({contentType:'text/html',body:'<h1>Trusted workspace fixture</h1>'});
    throw new Error(`Unexpected merchant request: ${request.url()}`);
  });
  const merchantPage=await merchantContext.newPage();
  await merchantPage.goto('http://merchant.example/demo-merchant/paypal.html');
  await merchantPage.getByLabel('Service').selectOption('document-compare-v1');
  const popupPromise=merchantContext.waitForEvent('page');
  await merchantPage.getByRole('link',{name:'Continue in ChainPay'}).click();
  const popup=await popupPromise;await popup.waitForLoadState();
  assert.equal(popup.url(),'http://localhost:5197/paypal/?service=document-compare-v1');
  assert.equal(await popup.evaluate(()=>window.opener),null);
  assert.equal(requests.length,3);
  assert.ok(requests.every(r=>!r.headers.authorization && r.body===null));
  assert.equal(requests.at(-1).headers.referer,undefined);
  await merchantContext.close();
  for (const width of [1440,390]) {
    const context=await browser.newContext({viewport:{width,height:1000}});
    const page=await context.newPage();const errors=[];const external=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
    page.on('console',m=>{if(m.type()==='error') console.error(m.text());});
    page.on('request',r=>{if(r.url().includes('chainpay-relay') || r.url().includes('convex')) external.push(r.url());});
    let tasks=[]; const submissions=[]; let suggestionUnavailable = false;
    const receipt={id:'fixture-task',sandbox:true,currency:'USD',gross:'12.00',refund:'4.00',net:'12.00',captured:true,refund_confirmed:false,quote_digest:'fixture-digest',created_at:1792800000,order_id:'ORDER',capture_id:'CAPTURE',units:[
      {index:0,name:'North supplier terms · sample',state:'delivered',input_hash:'a'.repeat(64),output_hash:'b'.repeat(64),result:{model:'fixture model',output:{summary:'Fixture rendering: delivery takes three days.',facts:[{claim:'Three-day delivery',evidence:'three working days'}],assessment:{}}}},
      {index:1,name:'South supplier terms · sample',state:'delivered',input_hash:'c'.repeat(64),output_hash:'d'.repeat(64)},
      {index:2,name:'Unreadable document · intentional sample',state:'failed',input_hash:'e'.repeat(64),reason:'Input does not contain enough readable text'}]};
    await page.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{
      const request=route.request();const path=new URL(request.url()).pathname;
      const merchant=request.headers().authorization?.includes('merchant');
      let body={};
      if(path.endsWith('/session')) body={id:merchant?'merchant':'buyer',workspace:'fixture',role:merchant?'merchant':'buyer'};
      else if(path.endsWith('/offers')) body={offers:[{id:'document-extract-v1',name:'Evidence-linked document summary',unit_price:'4.00',delivery:'Summary and claims with source excerpts',min_documents:1,max_documents:10,requires_requirements:false},{id:'document-compare-v1',name:'Compare two documents',unit_price:'8.00',delivery:'Compare both sources',min_documents:2,max_documents:2,requires_requirements:false},{id:'requirements-check-v1',name:'Check supplied requirements',unit_price:'4.00',delivery:'Check requirements',min_documents:1,max_documents:10,requires_requirements:true}]};
      else if(path.endsWith('/preflight')) {
        const input=request.postDataJSON();
        const issues=input.documents.flatMap((d,i)=>(d.text.match(/[\p{L}\p{N}]/gu) ?? []).length < 30 ? [{document_index:i,message:'Supply at least 30 alphanumeric characters of readable source text'}] : []);
        const outputs=input.service_id==='document-compare-v1'?1:input.documents.length;
        body={ready:issues.length===0,outputs,amount:input.service_id==='document-compare-v1'?'8.00':`${outputs*4}.00`,issues};
      }
      else if(path.endsWith('/recommend-service')) {
        assert.deepEqual(Object.keys(request.postDataJSON()),['objective']);
        if(suggestionUnavailable) return route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:'Service suggestion unavailable; select a service manually'})});
        body={service_id:'document-compare-v1',explanation:'Comparison of supplied sources with exact source excerpts'};
      }
      else if(path.endsWith('/tasks') && request.method()==='POST'){
        const input=request.postDataJSON();submissions.push(input);
        if(input.service_id==='document-extract-v1'){assert.equal(input.documents.length,3);tasks=[receipt];body=receipt;}
        else {
          const comparison=input.service_id==='document-compare-v1';
          body={id:`fixture-${input.service_id}`,sandbox:true,currency:'USD',gross:comparison?'8.00':'4.00',refund:'0.00',net:null,captured:false,refund_confirmed:false,quote_digest:'pending-digest',created_at:1792800000,offer_version:input.service_id,service_name:comparison?'Compare two documents':'Check supplied requirements',requirements:input.requirements,units:[{index:0,name:input.documents.map(d=>d.name).join(' ↔ '),state:'pending',input_hash:'a'.repeat(64)}]};
          tasks=[body];
        }
      }
      else if(path.endsWith('/tasks')) body={tasks};
      else if(path.endsWith('/analytics')) body={captured:'12.00',confirmed_refunds:receipt.refund_confirmed?'4.00':'0.00',known_net_cost:receipt.net,delivered_units:2,failed_units:1,unresolved_tasks:0,task_count:1,scope:'Latest 100 tasks accessible to this principal; not lifetime totals',tasks:[receipt]};
      else if(path.endsWith('/analytics/ask')) body={answer:'Fixture analyst: confirmed net cost is USD 8.00.'};
      else if(path.endsWith('/refund-proposal')) body={amount:'4.00',digest:'refund-fixture',reason:'One failed unit.'};
      else if(path.endsWith('/refund')){assert.ok(merchant);receipt.refund_confirmed=true;receipt.net='8.00';body=receipt;}
      else if(path.endsWith('/share')) body={token:'f'.repeat(64)};
      else if(path.endsWith('/explain')) body={explanation:'Fixture explanation: one failed unit needs merchant review.'};
      else body=tasks[0] ?? receipt;
      await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':base,'Access-Control-Allow-Headers':'authorization,content-type'},body:JSON.stringify(body)});
    });
    await page.goto(`${base}/paypal/?service=document-compare-v1`);
    await page.getByLabel('Workspace access code').fill('buyer-fixture');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#paypal-service')?.value==='document-compare-v1');
    await page.getByLabel('Service',{exact:true}).selectOption('document-extract-v1');
    await page.getByLabel('Source text',{exact:true}).fill('???');
    await page.getByRole('button',{name:'Check inputs',exact:true}).click();
    await page.getByText('Inputs need attention:',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Prepare quote',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Document 1'}).waitFor();
    assert.equal(submissions.length,0);
    await page.getByLabel('What do you want to learn? (optional)').fill('é'.repeat(1001));
    await page.getByText('2002 / 2000 UTF-8 bytes.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Suggest a service',exact:true}).isDisabled(),true);
    await page.getByLabel('What do you want to learn? (optional)').fill('é'.repeat(1000));
    assert.equal(await page.getByRole('button',{name:'Suggest a service',exact:true}).isDisabled(),false);
    await page.getByLabel('What do you want to learn? (optional)').fill('Compare supplier delivery terms');
    await page.getByRole('button',{name:'Suggest a service',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Service suggestion ready for your review.'}).waitFor();
    await page.getByRole('button',{name:'Use suggested service',exact:true}).click();
    assert.equal(await page.getByLabel('Service',{exact:true}).inputValue(),'document-compare-v1');
    assert.equal(submissions.length,0);
    suggestionUnavailable=true;
    await page.getByRole('button',{name:'Suggest a service',exact:true}).click();
    await page.getByText('Service suggestion unavailable; select a service manually',{exact:false}).waitFor();
    suggestionUnavailable=false;
    const first='Buyer document A: delivery within three working days after approval.';
    const second='Buyer document B: delivery within seven working days after approval.';
    await page.getByLabel('Source text',{exact:true}).fill(first);
    await page.getByLabel('Service',{exact:true}).selectOption('document-compare-v1');
    assert.equal(await page.getByRole('button',{name:'Prepare quote',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Add document',exact:true}).click();
    await page.getByLabel('Source text',{exact:true}).nth(1).fill(second);
    await page.getByRole('button',{name:'Prepare quote',exact:true}).click();
    await page.getByText('Service version:',{exact:false}).waitFor();
    assert.equal(submissions[0].service_id,'document-compare-v1');
    assert.deepEqual(submissions[0].documents.map(d=>d.text),[first,second]);
    await page.getByRole('button',{name:'Approve $8.00 quote & open checkout',exact:true}).waitFor();
    await page.reload();
    await page.getByRole('heading',{name:'Compare two documents',exact:true}).waitFor();
    await page.getByText('document-compare-v1',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Approve $8.00 quote & open checkout',exact:true}).waitFor();
    tasks[0]={...tasks[0],captured:true,net:'8.00',units:[{...tasks[0].units[0],state:'delivered',result:{model:'fixture',output:{summary:'The supplied delivery times differ.',facts:[{claim:'A takes three days',evidence:'three working days',document_index:0},{claim:'B takes seven days',evidence:'seven working days',document_index:1}],assessment:{}}}}]};
    await page.getByRole('button',{name:'Check original payment',exact:true}).click();
    await page.getByText('Source document 1',{exact:true}).waitFor();
    await page.getByText('Source document 2',{exact:true}).waitFor();
    await page.getByRole('button',{name:'New task',exact:true}).click();
    await page.getByLabel('Source text',{exact:true}).first().fill(first);
    await page.getByLabel('Service',{exact:true}).selectOption('document-extract-v1');
    await page.getByRole('button',{name:'Add document',exact:true}).click();
    await page.getByRole('button',{name:'Add document',exact:true}).click();
    await page.getByLabel('Service',{exact:true}).selectOption('document-compare-v1');
    assert.equal(await page.getByLabel('Source text',{exact:true}).count(),3);
    assert.equal(await page.getByLabel('Source text',{exact:true}).first().inputValue(),first);
    assert.equal(await page.getByRole('button',{name:'Prepare quote',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Remove document 3',exact:true}).click();
    await page.getByRole('button',{name:'Remove document 2',exact:true}).click();
    await page.getByLabel('Service',{exact:true}).selectOption('requirements-check-v1');
    await page.getByLabel('Requirements to check').fill('é'.repeat(2001));
    await page.getByText('4002 / 4000 UTF-8 bytes.',{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Prepare quote',exact:true}).isDisabled(),true);
    const terms='Private exact terms: delivery within five days.\nCertification required.';
    await page.getByLabel('Requirements to check').fill(terms);
    await page.getByRole('button',{name:'Prepare quote',exact:true}).click();
    await page.getByRole('heading',{name:'Purchased requirements',exact:true}).waitFor();
    assert.equal(submissions[1].service_id,'requirements-check-v1');
    assert.equal(submissions[1].requirements,terms);
    await page.getByText(terms,{exact:true}).waitFor();
    await page.getByRole('button',{name:'Approve $4.00 quote & open checkout',exact:true}).waitFor();
    await page.reload();
    await page.getByRole('heading',{name:'Purchased requirements',exact:true}).waitFor();
    await page.getByText(terms,{exact:true}).waitFor();
    await page.getByText('requirements-check-v1',{exact:true}).waitFor();
    tasks[0]={...tasks[0],captured:true,net:'4.00',units:[{...tasks[0].units[0],state:'delivered',result:{model:'fixture',output:{summary:'Requirements reviewed.',facts:[{claim:'Three-day delivery',evidence:'three working days'}],assessment:{requirements:terms,conclusion:'Timing supported; other evidence limited.',missing_evidence:['Contradicted: seven-day guarantee','Not established: certification']}}}}]};
    await page.getByRole('button',{name:'Check original payment',exact:true}).click();
    await page.getByText('Requirements assessment',{exact:true}).waitFor();
    await page.getByText('Contradicted: seven-day guarantee',{exact:true}).waitFor();
    await page.getByText('Not established: certification',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:join(artifacts,`requirements-${width}.png`),fullPage:true});
    // Old malformed optional assessment fields must not crash historical receipts.
    tasks[0].units[0].result.output.assessment={};
    await page.getByRole('button',{name:'Check original payment',exact:true}).click();
    await page.getByRole('button',{name:'New task',exact:true}).click();
    await page.getByLabel('Service',{exact:true}).selectOption('document-extract-v1');
    await page.getByRole('button',{name:'Use three sample documents'}).click();
    await page.getByRole('button',{name:'Prepare quote',exact:true}).click();
    await page.getByRole('heading',{name:'3 outputs, one clear record.'}).waitFor();
    assert.equal(await page.getByRole('button',{name:/Approve .* quote/}).count(),0);
    await page.getByRole('button',{name:'Review failed-unit refund'}).click();
    await page.getByText('A merchant must review and approve this refund.').waitFor();
    assert.equal(await page.getByRole('button',{name:/Approve .* sandbox refund/}).count(),0);
    await page.getByRole('button',{name:'Ask AI to explain this receipt'}).click();
    await page.getByText('AI explanation · not payment authority').waitFor();
    await page.getByRole('button',{name:'Share redacted receipt'}).click();
    await page.getByLabel('Public receipt URL').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:join(artifacts,`receipt-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByLabel('Workspace access code').fill('merchant-fixture');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.getByRole('heading',{name:'3 outputs, one clear record.'}).waitFor();
    assert.equal(await page.getByRole('button',{name:/Approve .* quote/}).count(),0);
    await page.getByRole('button',{name:'Review failed-unit refund'}).click();
    await page.getByRole('button',{name:'Approve $4.00 sandbox refund'}).click();
    await page.getByText('Refund confirmed',{exact:true}).waitFor();
    await page.getByText('$8.00',{exact:true}).waitFor();
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(()=>document.activeElement!==document.body));
    await page.getByRole('button',{name:'Outcome dashboard',exact:true}).click();
    await page.getByRole('heading',{name:'Confirmed buyer cost',exact:true}).waitFor().catch(async e=>{await page.screenshot({path:join(artifacts,'analytics-error.png'),fullPage:true});console.error(await page.locator('body').innerText());throw e;});
    await page.getByRole('heading',{name:'Work outcomes',exact:true}).waitFor();
    await page.getByRole('heading',{name:'Receipt evidence',exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh snapshot',exact:true}).click();
    await page.getByRole('heading',{name:'Confirmed buyer cost',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:join(artifacts,`analytics-${width}.png`),fullPage:true});
    if(width===1440){
      await page.getByText('AI Assistant',{exact:true}).click();
      await page.getByText('Explain my costs',{exact:true}).click();
      await page.getByText(/Fixture analyst: confirmed net cost/).waitFor();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByLabel('Workspace access code').fill('buyer-fixture');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.getByRole('button',{name:'New task',exact:true}).click();
    assert.equal(await page.getByLabel('Source text',{exact:true}).inputValue(),'');
    assert.equal(await page.getByLabel('Service',{exact:true}).inputValue(),'document-extract-v1');
    assert.equal(await page.getByLabel('What do you want to learn? (optional)').inputValue(),'');
    await page.getByLabel('Service',{exact:true}).selectOption('requirements-check-v1');
    assert.equal(await page.getByLabel('Requirements to check').inputValue(),'');
    await context.close();
  }
  console.log('PayPal desktop/mobile buyer/merchant receipt fixtures passed. No provider/model acceptance claimed.');
} finally {await browser.close();}
