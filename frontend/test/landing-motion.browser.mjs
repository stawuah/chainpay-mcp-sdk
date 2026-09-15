const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
await page.route('https://**/*',r=>r.abort());
await page.goto('http://127.0.0.1:5189/');
await page.getByRole('heading',{level:1}).waitFor();
await page.waitForTimeout(1200);

const ids = ['spend-limits','payment-review','receipts','stay-in-control'];
for (const index of [0,1,2,3,2,1]) {
  await page.locator('#'+ids[index]).evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+scrollY-innerHeight/2+e.clientHeight/2));
  await page.waitForTimeout(150);
  const state = page.locator('.story-morph-state').nth(index);
  assert.equal(await state.evaluate(e=>getComputedStyle(e).opacity),'1');
  const box = await page.locator('.story-morph').boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 1000, JSON.stringify(box));
}
await page.screenshot({path:'/tmp/chainpay-morph.png'});
function contrast(a,b) {
 const lum = s => { const v=s.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4});return v[0]*.2126+v[1]*.7152+v[2]*.0722; };
 const x=lum(a), y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
const buttons=page.locator('.landing .astryx-button');
for(let i=0;i<await buttons.count();i++) {
 const button=buttons.nth(i);
 for(const mode of ['normal','hover','focus']) {
  if(mode==='hover') await button.hover();
  if(mode==='focus') await button.focus();
  const colors=await button.evaluate(e=>({fg:getComputedStyle(e.querySelector('span span')||e).color,bg:getComputedStyle(e).backgroundColor}));
  assert.ok(contrast(colors.fg,colors.bg)>=4.5, JSON.stringify({mode,colors}));
 }
}
await page.emulateMedia({reducedMotion:'reduce'});
await page.waitForFunction(()=>!document.querySelector('.is-morphing'));
assert.equal(await page.locator('.pin-spacer').count(),0);
assert.equal(await page.locator('.story-morph').isVisible(),false);
assert.deepEqual(errors,[]);
console.log('PASS: all four story states and reverse scroll; pinned card bounds; normal/hover/focus button contrast >=4.5; reduced-motion teardown; no runtime errors');
await browser.close();
