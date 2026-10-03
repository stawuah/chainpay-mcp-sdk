import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE=process.env.PET_BROWSER_BASE || 'http://127.0.0.1:5191';
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
for(const reducedMotion of ['reduce','no-preference']){
 const context=await browser.newContext({viewport:{width:900,height:900},reducedMotion,acceptDownloads:true});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 let revision=1,props=[],memories=[],visitors=0;
 const state=()=>({needs:{battery:80,joy:80,cleanliness:35},lowPower:false,sleeping:false,mood:'bright',nextNapAt:Date.now()+3600000,napUntil:null,favorite:null,props,revision,serverTime:Date.now(),recentMemories:memories,suggestedAction:'polish'});
 await page.route('**/v1/pet/**',async r=>{
  const path=new URL(r.request().url()).pathname;let result=state();
  if(path.endsWith('/visitors')){visitors++;result={token:'fixture',expiresAt:Date.now()+3600000};}
  if(path.endsWith('/memories'))result={memories,nextBefore:null,aggregates:[]};
  if(path.endsWith('/act')){const action=r.request().postDataJSON().action;if(action==='secret'){props=['blue-star'];memories=[{id:'star',at:Date.now(),kind:'discovery',text:'A blue star joined the shelf.'}];revision++;}result={state:state(),outcome:action==='secret'?'accepted':'cooldown',replayed:false};}
  await r.fulfill({json:result});
 });
 await page.addInitScript(()=>{
   // Deterministically reach the authored 45s offer without changing its logic.
   const original=setInterval;window.setInterval=(fn,ms,...args)=>original(fn,ms===45000?300:ms,...args);
   const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type.includes('webgl')?null:get.call(this,type,...args);};
 });
 await page.goto(BASE+'/pet');
 await page.getByRole('button',{name:'Investigate together'}).click();
 await page.getByText('A blue star joined the shelf.').waitFor();
 assert.deepEqual(props,['blue-star']);assert.equal(visitors,1);
 const coin=page.getByRole('button',{name:'Toss a coin',exact:true});await coin.click();
 const first=await page.locator('.community-scene').getAttribute('data-reaction');
 await page.locator('.community-toss').evaluate(el=>window.firstToss=el);
 await coin.click();
 assert.equal(Number(await page.locator('.community-scene').getAttribute('data-reaction')),Number(first)+1);
 assert.equal(await page.locator('.community-toss').evaluate(el=>el===window.firstToss),false,'new interaction restarts the coin animation');
 assert.equal(await page.locator('.community-toss').evaluate(el=>getComputedStyle(el).animationName),reducedMotion==='reduce'?'none':'community-toss');
 const ball=page.getByRole('button',{name:'Roll the ball',exact:true});await ball.click();const rolled=Number(await page.locator('.community-scene').getAttribute('data-reaction'));await ball.click();assert.equal(Number(await page.locator('.community-scene').getAttribute('data-reaction')),rolled+1);
 await page.waitForFunction(()=>document.querySelector('.community-scene').dataset.action==='idle');
 const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Save a photo'}).click();const download=await downloadEvent;const png=await readFile(await download.path());assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),780);
 await page.reload();await page.getByText('A blue star joined the shelf.').waitFor();assert.ok(await page.locator('.community-small').filter({hasText:'blue-star'}).count());
 await context.close();
}
// Real browser tabs share a single anonymous session and converge on the same
// confirmed room. The storage simulation itself is covered by convex-test.
{
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 let visitors=0,revision=1;const authorizations=[];
 const needs={battery:80,joy:80,cleanliness:80};
 const now=Date.now(), first={id:'first',at:now,kind:'first',text:'Our first shared memory.'}, older={id:'older',at:now-1000,kind:'first',text:'An older shared memory.'}, newest={id:'newest',at:now+1000,kind:'first',text:'A new shared moment.'};
 let fresh=false, delayedPage;
 const state=()=>({needs,lowPower:false,sleeping:false,mood:'bright',nextNapAt:now+3600000,napUntil:null,favorite:null,props:[],revision,serverTime:Date.now(),recentMemories:[...(fresh?[newest]:[]),first],suggestedAction:'charge'});
 await context.route('**/v1/pet/**',async route=>{
  const url=new URL(route.request().url());let result;
  if(url.pathname.endsWith('/visitors')){visitors++;await new Promise(resolve=>setTimeout(resolve,40));result={token:`cp_pet_${'a'.repeat(64)}`,expiresAt:now+3600000};}
  else if(url.pathname.endsWith('/act')){authorizations.push(route.request().headers().authorization);const action=route.request().postDataJSON().action;if(action==='charge')needs.battery=100;if(action==='polish')needs.cleanliness=100;if(action==='pat')fresh=true;revision++;result={state:state(),outcome:'accepted',replayed:false};}
  else if(url.pathname.endsWith('/memories')){
   if(url.searchParams.has('before')){assert.equal(url.searchParams.get('before'),'987654321');delayedPage=route;return;}
   result={memories:[...(fresh?[newest]:[]),first],nextBefore:987654321,aggregates:[{day:Math.floor(now/86400000),counts:{pat:fresh?9:1}}]};
  }else result=state();
  await route.fulfill({json:result});
 });
 const [a,b]=await Promise.all([context.newPage(),context.newPage()]);
 for(const page of[a,b])page.on('pageerror',error=>errors.push(error.message));
 await Promise.all([a.goto(BASE+'/pet'),b.goto(BASE+'/pet')]);
 await Promise.all([a.getByText('Connected to our shared room.',{exact:false}).waitFor(),b.getByText('Connected to our shared room.',{exact:false}).waitFor()]);
 await Promise.all([a.locator('.community-care .community-actions').getByRole('button',{name:'Charge',exact:true}).click(),b.getByRole('button',{name:'Polish',exact:true}).click()]);
 await Promise.all([a.getByText('Saved to our shared room.',{exact:false}).waitFor(),b.getByText('Saved to our shared room.',{exact:false}).waitFor()]);
 assert.equal(visitors,1,'simultaneous first-use tabs must acquire one identity');assert.equal(new Set(authorizations).size,1);
 for(const page of[a,b]){
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('meter[aria-label="Battery"]').value===100&&document.querySelector('meter[aria-label="Cleanliness"]').value===100);
 }
 await a.getByRole('button',{name:'Earlier memories'}).click();
 await a.getByRole('button',{name:'Pat',exact:true}).click();
 await a.getByText('A new shared moment.',{exact:true}).waitFor();
 assert.ok(delayedPage,'pagination requested its opaque cursor');
 await delayedPage.fulfill({json:{memories:[older],nextBefore:null,aggregates:[{day:Math.floor(now/86400000),counts:{pat:1}}]}});
 for(const text of[first.text,older.text,newest.text]){await a.getByText(text,{exact:true}).waitFor();assert.equal(await a.getByText(text,{exact:true}).count(),1);}
 assert.match(await a.locator('.community-day').innerText(),/9 pat/,'slow page cannot rewind fresh aggregate');
 await a.getByRole('button',{name:'Pat',exact:true}).click();await a.getByText('Saved to our shared room.',{exact:false}).waitFor();
 await a.waitForTimeout(100);assert.equal(await a.getByText(older.text,{exact:true}).count(),1,'refresh retains expanded history');
 await context.close();
}
assert.deepEqual(errors,[]);await browser.close();console.log('review interaction, discovery, photo, shared tabs and scrapbook race checks passed');
