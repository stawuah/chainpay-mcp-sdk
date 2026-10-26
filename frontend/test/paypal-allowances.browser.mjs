// Allowance builder, agent view, approvals inbox and marketplace quotes. Rendering evidence only.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base=(process.env.PAYPAL_BROWSER_BASE||'http://127.0.0.1:5197')+'/test/fixtures/paypal-allowances.html';
const browser=await chromium.launch({channel:'chrome',headless:true});
const calls=page=>page.evaluate(()=>window.__paypalCalls);
try {
 // Buyer: the blue card rewrites as the caps change, create sends integer cents, status words are exact.
 {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.goto(base+'?role=buyer');
  await page.getByRole('button',{name:'Allowances',exact:true}).click();
  const card=page.getByLabel('Allowance preview');
  await card.getByText(/per purchase at Corner Grocer,/).waitFor();
  assert.match(await card.innerText(),/\$8\.00 per purchase at Corner Grocer, up to \$20\.00 in total, at most 3 times a day/);
  await page.getByLabel('Per purchase cap (USD)').fill('12.5');
  await page.getByLabel('Total cap (USD)').fill('45');
  await page.getByLabel('Max purchases per day').fill('1');
  await page.getByLabel('Old Town Tours').check();
  await page.getByLabel('Ask me first').check();
  const text=await card.innerText();
  assert.match(text,/may ask to buy up to \$12\.50 per purchase at Corner Grocer and Old Town Tours, up to \$45\.00 in total, at most 1 time a day/);
  assert.match(text,/You approve each one\./);
  await page.getByLabel('Name',{exact:true}).fill('Tours and treats');
  await page.getByRole('button',{name:'Create allowance'}).click();
  await page.getByRole('heading',{name:'Tours and treats'}).waitFor();
  const create=(await calls(page)).find(c=>c.method==='POST'&&c.path==='/allowances');
  assert.equal(create.body.total_cap_cents,4500);assert.equal(create.body.per_purchase_cap_cents,1250);
  assert.equal(create.body.mode,'ask_first');assert.deepEqual(create.body.merchants,['grocer','tours']);assert.equal(create.body.max_per_day,1);assert.ok(create.body.request_id);
  // Status words and the buttons that move them.
  const groceries=page.locator('.paypal-allowance-row',{hasText:'Weekly groceries'});
  assert.equal(await groceries.locator('.paypal-pill').innerText(),'Active');
  await groceries.getByRole('button',{name:'Pause',exact:true}).click();
  await groceries.getByRole('button',{name:'Resume',exact:true}).waitFor();
  assert.equal(await groceries.locator('.paypal-pill').innerText(),'Paused');
  await groceries.getByRole('button',{name:'Revoke',exact:true}).click();
  await page.locator('.paypal-allowance-row',{hasText:'Weekly groceries'}).locator('.paypal-pill',{hasText:'Revoked'}).waitFor();
  assert.equal(await groceries.getByRole('button').count(),0);
  const statuses=(await calls(page)).filter(c=>c.path==='/allowances/al-groceries/status').map(c=>c.body.status);
  assert.deepEqual(statuses,['Paused','Revoked']);
  assert.equal(await page.getByRole('link',{name:'Continue PayPal approval'}).count(),2);
  // One-tap approve sends only the digest; deny sends a reason.
  const inbox=page.getByLabel('Purchases waiting for approval');
  await inbox.getByRole('button',{name:'Approve $36.00'}).click();
  await page.getByText('Approved by buyer-one').waitFor();
  const approve=(await calls(page)).find(c=>c.path.endsWith('/approve'));
  assert.deepEqual(approve.body,{digest:'digest-t-waiting-tickets-0000000000000'});
  assert.equal(await page.locator('.paypal-status',{hasText:'PayPal capture confirmed'}).count(),1);
  assert.equal(await page.getByText('Purchase at Riverside Box Office').count(),1);
  // Every check row reads as "<observed> · allowed" or as money against a cap.
  const checks=await page.locator('.paypal-checks').innerText();
  assert.match(checks,/status\s+Active · allowed/);assert.match(checks,/cooldown\s+no purchases yet · allowed/);assert.match(checks,/per_purchase_cap\s+\$36\.00 of \$50\.00 · within/);
  // The expiry row is a date, not the raw epoch.
  assert.match(checks,/expiry\s+\S*\d\S* · allowed/);assert.doesNotMatch(checks,/expiry\s+\d{9,}/);
  await page.close();
 }
 // Buyer on a phone: the blue card sits above the form so the sentence is read before Create, and the pills stay on one row.
 {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(base+'?role=buyer');
  await page.getByRole('button',{name:'Allowances',exact:true}).click();
  const card=await page.getByLabel('Allowance preview').boundingBox();
  const create=await page.getByRole('button',{name:'Create allowance'}).boundingBox();
  assert.ok(card.y<create.y,`card at ${card.y} should be above Create at ${create.y}`);
  const pills=page.getByRole('group',{name:'Workspace view switcher'});
  const pillBox=await pills.boundingBox();
  assert.ok(pillBox.height<=48,`pills are ${pillBox.height}px tall`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=390),'no horizontal scroll at 390px');
  await page.screenshot({path:(process.env.PAYPAL_SHOTS||'/tmp/chainpay-paypal')+'-allowances-390.png',fullPage:true});
  await page.close();
 }
 // Approve when the rules no longer pass: the server answers 200 with the request denied by the rules and the policy refused.
 {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.goto(base+'?role=buyer&recheck=fail');
  await page.getByRole('button',{name:'Allowances',exact:true}).click();
  await page.getByLabel('Purchases waiting for approval').getByRole('button',{name:'Approve $36.00'}).click();
  await page.locator('.paypal-status',{hasText:'Refused by allowance rules'}).waitFor();
  const verdict=await page.locator('.paypal-verdict').innerText();
  assert.match(verdict,/This allowance is not Active/);assert.match(verdict,/allowance_not_active/);
  assert.match(await page.locator('.paypal-checks').innerText(),/status\s+Paused · not allowed/);
  await page.getByText('Denied by the allowance rules at approval time').waitFor();
  assert.equal(await page.getByLabel('Purchases waiting for approval').getByRole('button',{name:'Approve $36.00'}).count(),0);
  await page.close();
 }
 // Deny: the receipt shows the buyer's decision as the reason and the extra buyer_decision check.
 {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.goto(base+'?role=buyer');
  await page.getByRole('button',{name:'Allowances',exact:true}).click();
  await page.getByLabel('Purchases waiting for approval').getByRole('button',{name:'Deny',exact:true}).click();
  await page.waitForFunction(()=>window.__paypalCalls.some(c=>c.path.endsWith('/deny')));
  assert.deepEqual((await calls(page)).find(c=>c.path.endsWith('/deny')).body,{reason:'Denied by buyer'});
  await page.getByRole('navigation',{name:'Task receipts'}).getByRole('button',{name:/\$36\.00/}).click();
  await page.locator('.paypal-status',{hasText:'Refused by allowance rules'}).waitFor();
  const verdict=await page.locator('.paypal-verdict').innerText();
  assert.match(verdict,/Denied by the buyer/);assert.match(verdict,/denied/);
  assert.match(await page.locator('.paypal-checks').innerText(),/buyer_decision\s+Denied by buyer · not allowed/);
  await page.close();
 }
 // Purchases paused on the server: the 422 message is shown as is.
 {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.goto(base+'?role=buyer&paused=1');
  await page.getByRole('button',{name:'Allowances',exact:true}).click();
  await page.getByLabel('Allowance preview').waitFor();
  await page.getByRole('button',{name:'Create allowance'}).click();
  assert.equal(await page.getByRole('alert').innerText(),'Allowances and catalog purchases are paused');
  await page.close();
 }
 // Back from PayPal: ?allowance= finishes the payment method once and the query is dropped.
 {
  const page=await browser.newPage();
  await page.goto(base+'?role=buyer&allowance=al-tickets');
  await page.getByText('Payment method ready (PayPal sandbox).').nth(1).waitFor();
  assert.deepEqual((await calls(page)).filter(c=>c.path==='/allowances/al-tickets/vault').map(c=>c.method),['POST']);
  assert.equal(new URL(page.url()).search,'');
  await page.close();
 }
 // Agent: sees only Active allowances it may use, never a payment method, and a refusal shows its reason.
 {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(base+'?role=agent');
  await page.getByRole('button',{name:'Allowances',exact:true}).click();
  await page.getByRole('heading',{name:'Weekly groceries'}).waitFor();
  const panel=await page.getByLabel('Agent allowances').innerText();
  assert.doesNotMatch(panel.toLowerCase(),/vault/);
  assert.doesNotMatch(panel,/Show tickets|Continue PayPal approval|Payment method/);
  assert.equal(await page.getByRole('button',{name:/^(Pause|Resume|Revoke)$/}).count(),0);
  assert.equal(await page.getByLabel('Per purchase cap (USD)').count(),0);
  const fromServer=JSON.stringify(await page.evaluate(async()=>(await fetch('http://127.0.0.1:8081/v1/paypal/allowances')).json()));
  assert.doesNotMatch(fromServer,/vault|approval_url/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=390),'no horizontal scroll at 390px');
  await page.getByRole('button',{name:'Marketplace',exact:true}).click();
  await page.locator('.paypal-merchant-tile',{hasText:'Corner Grocer'}).click();
  await page.getByRole('button',{name:'More Coffee beans 250g'}).click();
  await page.getByRole('status').filter({hasText:'Refused'}).waitFor();
  const verdict=await page.getByRole('status').filter({hasText:'Refused'}).innerText();
  assert.match(verdict,/Over the per-purchase cap/);assert.match(verdict,/per_purchase_cap/);
  assert.equal(await page.getByRole('button',{name:/Buy now/}).isDisabled(),true);
  await page.getByRole('button',{name:'Fewer Coffee beans 250g'}).click();
  await page.getByRole('button',{name:'More Oat milk 1L'}).click();
  await page.getByRole('status').filter({hasText:'Allowed by the allowance rules.'}).waitFor();
  for(const name of ['More Oat milk 1L','Fewer Oat milk 1L']){const box=await page.getByRole('button',{name}).boundingBox();assert.ok(box.height>=44&&box.width>=44,`${name} is ${box.width}x${box.height}`);}
  await page.getByRole('button',{name:'Buy now · $3.90'}).click();
  await page.locator('.paypal-status',{hasText:'PayPal capture confirmed'}).waitFor();
  const buy=(await calls(page)).find(c=>c.method==='POST'&&c.path==='/purchases');
  assert.equal(buy.body.allowance_id,'al-groceries');assert.equal(buy.body.mode,'agent_pays');assert.deepEqual(buy.body.items,[{id:'oat-milk',qty:1}]);assert.ok(buy.body.request_id);
  assert.equal(await page.getByText('Purchase at Corner Grocer').count(),1);
  assert.equal(await page.getByRole('button',{name:'Run or recover this paid task'}).count(),0);
  await page.close();
 }
 // No allowance named: the quote comes back without a policy block and nothing can be bought.
 {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.goto(base+'?role=agent&empty=1');
  await page.getByRole('button',{name:'Marketplace',exact:true}).click();
  await page.locator('.paypal-merchant-tile',{hasText:'Corner Grocer'}).click();
  await page.getByRole('button',{name:'More Oat milk 1L'}).click();
  await page.getByText('Ask the buyer to create or resume an allowance before buying.').waitFor();
  const quote=(await calls(page)).find(c=>c.path==='/purchases/quote');
  assert.equal(quote.body.allowance_id,undefined);
  assert.equal(await page.locator('.paypal-verdict').count(),0);
  assert.equal(await page.getByRole('button',{name:'Buy now · $3.90'}).isDisabled(),true);
  await page.close();
 }
 console.log('Allowance builder card, exact status words, agent isolation, one-tap approval and marketplace refusal fixtures passed.');
} finally {await browser.close();}
