// Delayed local fixtures: no provider/model calls or payments.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.PAYPAL_BROWSER_BASE || 'http://127.0.0.1:5197';
const browser=await chromium.launch({channel:'chrome',headless:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const source='Private supplier document promises delivery within three working days.';
try {
  for(const scenario of ['edit','preflight-signout','task-signout','upload-signout','suggestion-signout']) {
    const context=await browser.newContext();const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const calls=[];let gate;let nextGate;
    await page.route('http://127.0.0.1:8081/v1/paypal/**',async route=>{
      const request=route.request();const path=new URL(request.url()).pathname;
      const body=request.postDataJSON();calls.push({path,body,token:request.headers().authorization});
      let hold;
      if(gate && path.endsWith(gate.path) && request.method()==='POST') {hold=gate;gate=nextGate;nextGate=undefined;hold.entered.resolve();await hold.release.promise;}
      let result={};
      if(path.endsWith('/session')) result={id:request.headers().authorization,workspace:'fixture',role:'buyer'};
      else if(path.endsWith('/offers')) result={offers:[{id:'document-extract-v1',name:'Summary',unit_price:'4.00',min_documents:1,max_documents:10,requires_requirements:false,delivery:'Summary with excerpts'}]};
      else if(path.endsWith('/preflight')) result={ready:true,outputs:1,amount:'4.00',issues:[]};
      else if(path.endsWith('/recommend-service')) result={service_id:'document-extract-v1',explanation:'Summary with excerpts'};
      else if(path.endsWith('/tasks') && request.method()==='POST') result={id:'old-task',units:[{index:0,name:'old private name',state:'pending',input_hash:'a'}],gross:'4.00',net:null,refund:'0.00',captured:false,refund_confirmed:false,quote_digest:'fixture',offer_version:'document-extract-v1'};
      else if(path.endsWith('/tasks')) result={tasks:[]};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
      hold?.done.resolve();
    });
    const delay=path=>({path,entered:deferred(),release:deferred(),done:deferred()});
    const login=async token=>{await page.getByLabel('Workspace access code').fill(token);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.getByLabel('Service',{exact:true}).waitFor();};
    const relogin=async()=>{await page.getByRole('button',{name:'Sign out',exact:true}).click();await login('second-buyer');};
    const prepare=()=>page.getByRole('button',{name:'Prepare quote',exact:true}).click();
    await page.goto(`${base}/paypal/`);await login('first-buyer');
    await page.getByLabel('Source text',{exact:true}).fill(source);
    if(scenario==='upload-signout') {
      await page.evaluate(()=>{File.prototype.text=function(){return new Promise(resolve=>{window.finishUpload=()=>resolve('Old private uploaded source with many readable characters.');});};});
      await page.locator('input[type=file]').setInputFiles({name:'old-private.txt',mimeType:'text/plain',buffer:Buffer.from(source)});
      await page.waitForFunction(()=>typeof window.finishUpload==='function');
      await relogin();await page.evaluate(()=>window.finishUpload());
    } else if(scenario==='suggestion-signout') {
      const held=gate=delay('/recommend-service');
      await page.getByLabel('What do you want to learn? (optional)').fill('Summarize private terms');
      await page.getByRole('button',{name:'Suggest a service',exact:true}).click();await held.entered.promise;
      await page.getByRole('status').filter({hasText:'Finding a service suggestion…'}).waitFor();
      await relogin();held.release.resolve();await held.done.promise;
    } else {
      const held=gate=delay(scenario==='task-signout'?'/tasks':'/preflight');
      await prepare();await held.entered.promise;
      if(scenario==='edit') {
        await page.getByLabel('Source text',{exact:true}).fill(source+' Changed input.');
        held.release.resolve();await held.done.promise;
        // Wait on the actual control state instead of elapsed time.
        await page.getByRole('button',{name:'Prepare quote',exact:true}).waitFor();
        await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Prepare quote'&&!b.disabled));
        assert.equal(calls.filter(c=>c.path.endsWith('/tasks')&&c.body).length,0);
        await prepare();await page.getByRole('heading',{name:'1 outputs, one clear record.'}).waitFor();
        assert.equal(calls.find(c=>c.path.endsWith('/tasks')&&c.body).body.documents[0].text,source+' Changed input.');
      } else {
        await relogin();
        if(scenario==='task-signout') {
          // Old completion must not clear a new session's busy state.
          const newer=gate=delay('/preflight');
          await page.getByLabel('Source text',{exact:true}).fill('New buyer private source with sufficient readable input.');
          await prepare();await newer.entered.promise;
          held.release.resolve();await held.done.promise;
          await page.getByLabel('Source text',{exact:true}).fill('New buyer edited source with sufficient readable input.');
          assert.equal(await page.getByRole('button',{name:'Prepare quote',exact:true}).isDisabled(),true);
          newer.release.resolve();await newer.done.promise;
          await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Prepare quote'&&!b.disabled));
          assert.equal(await page.getByRole('heading',{name:'1 outputs, one clear record.'}).count(),0);
        } else {held.release.resolve();await held.done.promise;}
      }
    }
    if(scenario!=='edit') {
      // Drive a fresh check as a completion barrier; stale work cannot update this session.
      await page.getByRole('button',{name:'Check inputs',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Input check complete.'}).waitFor();
      assert.equal(await page.getByText('old private name',{exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'Use suggested service',exact:true}).count(),0);
      assert.equal(await page.getByRole('alert').count(),0);
      if(scenario!=='task-signout') assert.equal(await page.getByLabel('Source text',{exact:true}).inputValue(),'');
      assert.equal(calls.filter(c=>c.path.endsWith('/tasks')&&c.body).length,scenario==='task-signout'?1:0);
    }
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Delayed preflight, quote, upload and recommendation session fixtures passed.');
} finally {await browser.close();}
