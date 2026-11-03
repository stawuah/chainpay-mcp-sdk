// Dashboard buyer flows: fixture-only payment decisions and selected receipt navigation.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base=(process.env.PAYPAL_BROWSER_BASE||'http://127.0.0.1:5197')+'/test/fixtures/dashboard-harness.html?tab=paypal&ready=1&view=';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const width of [390,768,1440]) {
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
  await page.goto(base+'allowances');
  const row=page.locator('.paypal-allowance-row').first();await row.waitFor();
  assert.ok((await row.boundingBox()).y<(await page.locator('.paypal-allowance-builder').boundingBox()).y);
  await page.getByRole('button',{name:'New allowance',exact:true}).click();
  assert.equal(await page.getByLabel('Name',{exact:true}).evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('.paypal-permission-card-amount small').first().evaluate(e=>getComputedStyle(e).color),'rgb(255, 255, 255)');
  assert.equal(await page.locator('.paypal-card').first().evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.goto(base+'disputes');
  const detail=page.locator('.paypal-dispute-detail').first();await detail.waitFor();
  for(const label of ['Status','Stage','Reason'])assert.ok((await detail.innerText()).includes(label));
  await detail.getByRole('button',{name:'View purchase receipt',exact:true}).click();
  const receipt=page.getByRole('region',{name:/Purchase receipt/});await receipt.waitFor();
  assert.match(await receipt.innerText(),/Original amount/);
  assert.equal(await receipt.evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.goto(base+'connect');
  await page.getByRole('button',{name:'Approve $37.00',exact:true}).click();
  const outcome=page.locator('.cp-paypal-outcome');await outcome.waitFor();
  assert.match(await outcome.innerText(),/capture confirmed/);
  assert.equal(await outcome.evaluate(e=>e===document.activeElement),true);
  await page.close();
 }
 console.log('PayPal dashboard browser: 3 widths passed (allowance controls, contrast, reduced motion, dispute receipt, approval outcome).');
} finally {await browser.close();}
