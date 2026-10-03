import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const artifacts = await mkdtemp(join(tmpdir(), 'chainpay-community-browser-'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.PET_BROWSER_BASE || 'http://127.0.0.1:5191';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
for (const [width, noWebGL, reducedMotion] of [[390,true,'reduce'],[768,false,'reduce'],[1440,false,'no-preference']]) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  let revision = 1, stateReads = 0, actions = [], drop = false;
  const needs = { battery: 30, joy: 45, cleanliness: 40 };
  const state = () => ({ needs, revision, serverTime: Date.now(), lowPower: false, sleeping: false, mood: 'content', nextNapAt: Date.now()+3600000, napUntil:null, favorite:'ball',props:['blue-marble'],recentMemories:[{id:'first',at:Date.now(),kind:'first',text:'Someone rolled the first ball.'}],suggestedAction:'charge' });
  await page.route('https://**/*', r => r.abort());
  await page.route('**/v1/pet/**', async r => {
    const url = new URL(r.request().url());
    let body;
    if (url.pathname.endsWith('/state')) { stateReads++; body=state(); }
    else if (url.pathname.endsWith('/visitors')) body={ token:'anonymous-fixture',expiresAt:Date.now()+86400000 };
    else if (url.pathname.endsWith('/memories')) body={memories:state().recentMemories,nextBefore:null,aggregates:[{day:Math.floor(Date.now()/86400000),counts:{ball:1}}]};
    else { const action=r.request().postDataJSON(); actions.push(action); if(drop) { drop=false; return r.abort(); } if(action.action==='charge') needs.battery=80; if(action.action==='polish') needs.cleanliness=90; revision++; body={state:state(),outcome:'accepted',replayed:false}; }
    await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.addInitScript(({ noWebGL }) => {
    localStorage.setItem('chainpay.pet.v1', 'legacy-preserved');
    localStorage.setItem('chainpay.pet.hidden','1');
    if(noWebGL) { const original=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(type,...args){ return type.includes('webgl')?null:original.call(this,type,...args); }; }
  }, {noWebGL});
  await page.goto(BASE+'/pet');
  await page.getByRole('heading',{name:'One little robot. All of us.'}).waitFor();
  await page.getByText('Connected to our shared room.',{exact:false}).waitFor();
  assert.equal(await page.locator('.community-companion,.cp-pet,.cp-pet-return').count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('chainpay.pet.v1')),'legacy-preserved');
  assert.equal(await page.locator('[data-wallet-adapter]').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('.community-care .community-primary').click();
  await page.waitForFunction(()=>document.querySelector('.community-needs strong')?.textContent==='80%');
  await page.getByRole('button',{name:'Polish',exact:true}).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(()=>[...document.querySelectorAll('.community-needs strong')].some(el=>el.textContent==='90%'));
  assert.ok(actions.some(a=>a.action==='polish'));
  await page.getByText('Someone rolled the first ball.').waitFor();
  await page.locator('#community-caption').fill('Our little moment');
  const downloadPromise=page.waitForEvent('download'); await page.getByRole('button',{name:'Save a photo'}).click();
  const download=await downloadPromise; assert.equal(download.suggestedFilename(),'chainpay-community-moment.png');
  await download.saveAs(join(artifacts, `community-pet-${width}.png`));
  drop=true; await page.getByRole('button',{name:'Toss a coin',exact:true}).click();
  const retry=page.getByRole('button',{name:'Retry unconfirmed action'}); await retry.waitFor();
  const uncertain=actions.at(-1); await retry.click(); await page.waitForFunction(()=>!document.querySelector('.community-sync')?.textContent?.includes('unconfirmed'));
  assert.deepEqual(actions.at(-1),uncertain);
  const before=stateReads;
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(5300); assert.equal(stateReads,before,'hidden tab must not poll');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});window.dispatchEvent(new Event('focus'));});
  await page.waitForTimeout(200); assert.ok(stateReads>before);
  if(width===1440) { await page.evaluate(()=>document.documentElement.style.zoom='2'); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% zoom overflows'); }
  await page.screenshot({path:join(artifacts, `community-room-${width}.png`),fullPage:true});
  await context.close();
}
// Companion stays quiet on financial routes; keyboard panel, Hide and Pin persist.
{
  const context = await browser.newContext({ viewport: { width: 900, height: 500 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',r=>r.abort());
  await page.route('**/v1/pet/**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({needs:{battery:80,joy:80,cleanliness:80},revision:1,serverTime:Date.now(),lowPower:false,sleeping:false,mood:'bright',nextNapAt:Date.now()+3600000,napUntil:null,favorite:null,props:[],recentMemories:[],suggestedAction:'charge'})}));
  await page.goto(BASE+'/verify');
  const robot=page.getByRole('button',{name:'Community robot',exact:true}); await robot.waitFor({timeout:20000});
  await robot.focus();await page.keyboard.press('Enter');
  const panel=page.getByRole('dialog',{name:'Community robot'});await panel.waitFor();
  const box=await panel.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=500,'short-screen panel stays visible');
  await page.getByRole('button',{name:'Pin here',exact:true}).click();
  assert.ok(await page.evaluate(()=>localStorage.getItem('chainpay.pet.pin')));
  await page.keyboard.press('Escape'); assert.equal(await robot.evaluate(el=>el===document.activeElement),true);
  await robot.click();await page.getByRole('button',{name:'Hide',exact:true}).click();
  const restore=page.getByRole('button',{name:'Bring the robot back'});await restore.waitFor();
  assert.equal(await restore.evaluate(el=>el===document.activeElement),true);
  await page.reload();await restore.waitFor({timeout:20000});await restore.click();await robot.waitFor();
  assert.equal(await page.locator('.community-companion').getAttribute('data-mode'),'pinned');
  assert.equal(await page.locator('.community-offer,.cp-pet-speech,.cp-pet-speck').count(),0);
  await context.close();
}
assert.deepEqual(errors,[]); await browser.close(); console.log('community pet responsive, keyboard, photo, retry and polling checks passed');
