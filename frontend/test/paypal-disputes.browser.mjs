// Merchant dispute table, evidence preview and one-time submit, plus fulfilment on a purchase receipt.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base=(process.env.PAYPAL_BROWSER_BASE||'http://127.0.0.1:5197')+'/test/fixtures/paypal-allowances.html';
const browser=await chromium.launch({channel:'chrome',headless:true});
const calls=page=>page.evaluate(()=>window.__paypalCalls);
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.goto(base+'?role=merchant');
 assert.equal(await page.getByRole('button',{name:/Allowances|Marketplace/}).count(),0);
 await page.getByRole('button',{name:'Disputes',exact:true}).click();
 await page.getByRole('table').waitFor();
 const row=page.getByRole('row',{name:/PP-D-FIXTURE-1/});
 assert.match(await row.innerText(),/WAITING_FOR_SELLER_RESPONSE/);assert.match(await row.innerText(),/\$3\.90/);assert.match(await row.innerText(),/Not sent/);
 await page.getByRole('button',{name:'Sync from PayPal'}).click();
 await page.waitForFunction(()=>window.__paypalCalls.some(c=>c.path==='/disputes/sync'&&c.method==='POST'));
 const submit=page.getByRole('button',{name:'Submit evidence pack'});
 assert.equal(await submit.isDisabled(),true);
 await page.getByRole('button',{name:'Preview evidence pack'}).click();
 await page.getByText('pack-digest-fixture').waitFor();
 const pack=await page.locator('.paypal-evidence').innerText();
 assert.match(pack,/allowance-rules-v1/);assert.match(pack,/per_purchase_cap: \$3\.90 of \$8\.00 · within/);assert.match(pack,/Agent paid within the allowance/);
 assert.equal(await submit.isDisabled(),false);
 await submit.click();
 await page.getByText('Evidence submitted').waitFor();
 const sent=(await calls(page)).filter(c=>c.method==='POST'&&c.path==='/disputes/PP-D-FIXTURE-1/evidence');
 assert.deepEqual(sent.map(c=>c.body),[{digest:'pack-digest-fixture'}]);
 assert.equal(await page.getByRole('button',{name:'Submit evidence pack'}).count(),0);
 assert.match(await row.innerText(),/Submitted/);
 // The task link opens the receipt with its dispute pill and per-unit fulfilment.
 await row.getByRole('button').click();
 await page.locator('.paypal-status',{hasText:'Dispute WAITING_FOR_SELLER_RESPONSE'}).waitFor();
 assert.equal(await page.getByRole('button',{name:/open checkout|Run or recover/}).count(),0);
 await page.getByRole('button',{name:'Fulfil unit 1'}).click();
 await page.locator('.paypal-unit-state',{hasText:'Delivered'}).waitFor();
 const fulfil=(await calls(page)).find(c=>c.path.endsWith('/fulfil'));
 assert.deepEqual(fulfil.body,{outcomes:[{unit:0,state:'delivered'}]});
 assert.equal(await page.getByRole('button',{name:/Fulfil unit/}).count(),0);
 await page.close();
 // A buyer on a purchase receipt with a failed unit can ask for a refund; the merchant approves with the digest.
 {
  const buyer=await browser.newPage();
  await buyer.goto(base+'?role=merchant');
  await buyer.getByRole('navigation',{name:'Task receipts'}).getByRole('button',{name:/\$3\.90/}).click();
  await buyer.getByRole('button',{name:'Mark unit 1 failed'}).click();
  await buyer.locator('.paypal-unit-state',{hasText:'Failed'}).waitFor();
  assert.equal(await buyer.getByRole('button',{name:'Request refund for failed units'}).count(),0);
  await buyer.evaluate(async()=>{await fetch('http://127.0.0.1:8081/v1/paypal/tasks/t-captured-oatmilk-000000000000/refund-request',{method:'POST',body:JSON.stringify({reason:'Never arrived'})});});
  await buyer.getByRole('button',{name:'Check original payment'}).click();
  await buyer.getByText(/Refund requested: \$3\.90 for unit 1\. Never arrived\./).waitFor();
  // A purchase receipt counts items, not outputs, and shows the unit price instead of revision and hash lines.
  await buyer.getByRole('heading',{name:'1 items, one clear record.'}).waitFor();
  const unit=await buyer.locator('.paypal-units').innerText();
  assert.doesNotMatch(unit,/Revision/);assert.doesNotMatch(unit,/Evidence hashes/);assert.match(unit,/\$3\.90/);
  assert.match(await buyer.getByRole('navigation',{name:'Task receipts'}).innerText(),/1 item\b/);
  await buyer.getByRole('button',{name:'Approve $3.90 refund'}).click();
  await buyer.locator('.paypal-status',{hasText:'Refund confirmed'}).waitFor();
  const refund=(await calls(buyer)).find(c=>c.path.endsWith('/refund')&&c.method==='POST');
  assert.deepEqual(refund.body,{digest:'refund-t-captured-oatmilk-000000000000'});
  // Once the refund is confirmed the "merchant must approve" notice is gone.
  assert.equal(await buyer.getByText(/A merchant must approve it/).count(),0);
  await buyer.close();
 }
 // Phone width: the dispute table scrolls inside its wrap, the page itself does not scroll sideways.
 {
  const phone=await browser.newPage({viewport:{width:390,height:844}});
  await phone.goto(base+'?role=merchant');
  await phone.getByRole('button',{name:'Disputes',exact:true}).click();
  await phone.getByRole('table').waitFor();
  const widths=await phone.evaluate(()=>({page:document.documentElement.scrollWidth,wrap:document.querySelector('.paypal-table-wrap').clientWidth,table:document.querySelector('.paypal-dispute-table').scrollWidth}));
  assert.ok(widths.page<=390,`page scrollWidth ${widths.page}`);
  assert.ok(widths.wrap<=390&&widths.table>widths.wrap,`table ${widths.table} should scroll inside wrap ${widths.wrap}`);
  await phone.screenshot({path:(process.env.PAYPAL_SHOTS||'/tmp/chainpay-paypal')+'-disputes-390.png',fullPage:true});
  await phone.close();
 }
 console.log('Dispute table, evidence preview, single submit, fulfilment and refund request fixtures passed.');
} finally {await browser.close();}
