// Records the whole PayPal cycle in the real workspace UI.
// PayPal and the AI are simulated by a stateful stand-in that answers with the
// same receipt shapes as backend/src/paypal/observations.rs. Not a live run.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2];
const BASE = 'http://127.0.0.1:5197';
const API = 'http://127.0.0.1:8081';
await mkdir(join(OUT, 'shots'), { recursive: true });
await mkdir(join(OUT, 'video'), { recursive: true });

const hex = n => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const now = () => Math.floor(Date.now() / 1000);
let task = null;
let shareToken = null;
const docs = [
  { name: 'North supplier terms', text: 'North Supply Co. delivers within three working days after purchase order approval. Returns are accepted within 30 days with the original packing slip.' },
  { name: 'South supplier terms', text: 'South Trading Ltd. ships within seven working days of a signed order. Damaged goods must be reported within 48 hours of delivery for a replacement.' },
];
const outputs = [
  { summary: 'North Supply delivers in three working days and accepts returns for 30 days.', facts: [{ claim: 'Delivery takes three working days', evidence: 'delivers within three working days after purchase order approval', document_index: 0 }, { claim: 'Returns accepted for 30 days', evidence: 'Returns are accepted within 30 days', document_index: 0 }], assessment: {} },
  { summary: 'South Trading ships in seven working days; damage must be reported within 48 hours.', facts: [{ claim: 'Shipping takes seven working days', evidence: 'ships within seven working days of a signed order', document_index: 1 }, { claim: 'Damage reported within 48 hours', evidence: 'reported within 48 hours of delivery', document_index: 1 }], assessment: {} },
];

function receipt(publicView = false) {
  const t = task;
  const units = t.units.map((u, i) => {
    const last = [...t.resolution].reverse().find(e => e.intent.binding.unit === i && e.intent.binding.revision === u.revision);
    const view = { buyer_review: last?.intent.action ?? null, index: i, state: u.state, input_hash: u.input_hash, output_hash: u.output_hash, revision: u.revision, source: 'merchant work record' };
    if (!publicView) Object.assign(view, { name: docs[i].name, result: u.result, reason: null });
    return view;
  });
  const confirmed = t.refunds.filter(r => r.confirmed).reduce((s, r) => s + r.cents, 0);
  const reserved = t.refunds.filter(r => r.state).reduce((s, r) => s + r.cents, 0);
  const dollars = c => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
  const view = {
    id: t.id, sandbox: true, currency: 'USD', offer_version: 'document-extract-v1', service_name: 'Evidence-linked document summary',
    created_at: t.created_at, approved_at: t.approved_at, allowance_units: null, gross: dollars(t.cents), captured: t.captured, payment_review: null,
    refund: dollars(confirmed), refund_confirmed: confirmed > 0, refund_pending: t.refunds.some(r => r.state && !r.confirmed),
    reserved_refunds: dollars(reserved), confirmed_refunds: dollars(confirmed), funding_method: 'paypal_order', subscription_funding: null,
    funded: t.captured, net: t.captured ? dollars(t.cents - confirmed) : null, units,
    order_id: t.order_id, capture_id: t.capture_id, refund_id: null, payment_source: 'PayPal sandbox API observation',
    delivery_source: 'Merchant processing record; not buyer acceptance', order_state: t.order_state, capture_state: t.capture_state, refund_state: null,
  };
  if (!publicView) Object.assign(view, {
    requirements: null, resolution: t.resolution, legacy_refund_units: null, revisions: t.units.map(() => []),
    refunds: t.refunds.map(({ cents, ...r }) => r), quote_digest: t.quote_digest, quote_expires_at: t.quote_expires_at,
    approval_url: t.approval_url, share_token: shareToken,
  });
  return view;
}

async function handle(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace('/v1/paypal', '');
  const method = request.method();
  const auth = request.headers().authorization ?? '';
  const role = auth.includes('merchant') ? 'merchant' : 'buyer';
  const cors = { 'Access-Control-Allow-Origin': BASE, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE' };
  const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const body = request.postData() ? request.postDataJSON() : {};
  // A short pause so the recording shows the request happening.
  await new Promise(r => setTimeout(r, 250));
  if (path === '/session') return method === 'DELETE' ? send({}) : send({ id: `demo-${role}`, workspace: 'demo-workspace', role });
  if (path === '/offers') return send({ offers: [
    { id: 'document-extract-v1', name: 'Evidence-linked document summary', unit_price: '4.00', delivery: 'Summary and factual claims linked to source excerpts.', min_documents: 1, max_documents: 10, requires_requirements: false },
    { id: 'document-compare-v1', name: 'Compare two documents', unit_price: '8.00', delivery: 'Differences between two sources with excerpts.', min_documents: 2, max_documents: 2, requires_requirements: false },
  ] });
  if (path === '/preflight') return send({ ready: true, outputs: body.documents.length, amount: `${body.documents.length * 4}.00`, issues: [] });
  if (path === '/subscriptions/terms') return send({ terms: 'demo', plan_id: null, enabled: false, policy: 'Subscriptions are off in this demo.', price: '40.00', units: 10 });
  if (path === '/subscriptions') return send({ subscriptions: [] });
  if (path === '/tasks' && method === 'GET') return send({ tasks: task ? [receipt()] : [] });
  if (path === '/tasks' && method === 'POST') {
    task = { id: hex(32), created_at: now(), approved_at: null, cents: body.documents.length * 400, captured: false, order_id: null, capture_id: null, order_state: null, capture_state: null, approval_url: null, quote_digest: hex(64), quote_expires_at: now() + 3600, resolution: [], refunds: [],
      units: body.documents.map(() => ({ state: 'pending', input_hash: hex(64), output_hash: null, revision: 0, result: null })) };
    return send(receipt());
  }
  if (path.startsWith('/receipts/')) return send(receipt(true));
  if (path === '/analytics') {
    const r = receipt();
    return send({ captured: r.captured ? r.gross : '0.00', confirmed_refunds: r.confirmed_refunds, known_net_cost: r.net, delivered_units: r.units.filter(u => u.state === 'delivered').length, failed_units: 0, unresolved_tasks: 0, task_count: 1, scope: 'Latest 100 tasks accessible to this principal; not lifetime totals', tasks: [r] });
  }
  if (!task) return send({ error: 'Not found' }, 404);
  const action = path.split('/').slice(3).join('/');
  if (action === 'checkout') {
    task.order_id = `DEMO-ORDER-${hex(6).toUpperCase()}`;
    task.order_state = 'observed';
    task.approved_at = now();
    task.approval_url = `https://www.sandbox.paypal.com/checkoutnow?token=${task.order_id}`;
    return send(receipt());
  }
  if (action === 'capture') {
    task.captured = true; task.capture_id = `DEMO-CAPTURE-${hex(6).toUpperCase()}`; task.capture_state = 'observed';
    return send(receipt());
  }
  if (action === 'process') {
    await new Promise(r => setTimeout(r, 1200));
    task.units.forEach((u, i) => { u.state = 'delivered'; u.output_hash = hex(64); u.result = { model: 'simulated model (demo)', output: outputs[i] }; });
    return route.fulfill({ status: 202, headers: cors });
  }
  if (action === 'resolution') {
    task.resolution.push({ actor: `demo-${role}`, role, timestamp: now(), intent: body });
    return send(receipt());
  }
  if (action === 'resolution-refunds') {
    task.refunds.push({ ...body, amount: `${body.bindings.length * 4}.00`, cents: body.bindings.length * 400, digest: hex(64), proposed_by: 'demo-merchant', proposed_at: now(), approval_request_id: null, provider_id: null, confirmed: false, state: null });
    return send(receipt());
  }
  if (action === 'resolution-refunds/approve') {
    const r = task.refunds.find(x => x.digest === body.digest);
    // The real service confirms this when PayPal's verified webhook arrives.
    r.state = 'observed'; r.confirmed = true; r.provider_id = `DEMO-REFUND-${hex(6).toUpperCase()}`; r.approval_request_id = body.request_id;
    return send(receipt());
  }
  if (action === 'share') { shareToken = hex(64); return send({ token: shareToken }); }
  if (action === 'refund-proposal') return send({ error: 'No failed units to refund' }, 422);
  if (action === 'explain') return send({ explanation: 'Simulated explanation: USD 8.00 was captured, USD 4.00 was refunded for the challenged output, so the buyer paid USD 4.00.', receipt: receipt() });
  if (action === 'reconcile' || action === '') return send(receipt());
  return send(receipt());
}

const paypalPage = id => `<!doctype html><meta charset="utf-8"><title>PayPal Sandbox (simulated)</title>
<style>body{margin:0;font-family:Helvetica,Arial,sans-serif;background:#f5f7fa;color:#001c64}.bar{background:#003087;color:#fff;padding:14px 24px;font-weight:700;font-size:20px}
.tag{background:#ffc439;color:#001c64;font-size:12px;padding:4px 8px;border-radius:4px;margin-left:12px;vertical-align:middle}.card{max-width:420px;margin:48px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 6px}.amt{font-size:34px;font-weight:700;margin:18px 0}.row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #e6e9ef;font-size:14px}
a.pay{display:block;text-align:center;margin-top:22px;background:#0070e0;color:#fff;padding:14px;border-radius:24px;text-decoration:none;font-weight:700}small{display:block;margin-top:14px;color:#5b6b8c;font-size:12px}</style>
<div class="bar">PayPal <span class="tag">SANDBOX · SIMULATED FOR THIS DEMO</span></div>
<div class="card"><h1>Pay ChainPay sandbox merchant</h1><div>Logged in as sandbox-buyer@personal.example.com</div><div class="amt">$8.00 USD</div>
<div class="row"><span>Evidence-linked document summary × 2</span><span>$8.00</span></div><div class="row"><span>Pay with</span><span>PayPal balance (sandbox)</span></div>
<a class="pay" href="${BASE}/paypal/checkout?task=${id}">Complete purchase</a><small>In the real test this is PayPal's own sandbox checkout. Use the sandbox personal account.</small></div>`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(OUT, 'video'), size: { width: 1280, height: 800 } } });
await context.addInitScript(() => {
  window.__caption = (step, text) => {
    let bar = document.getElementById('__demo_caption');
    if (!bar) {
      bar = document.createElement('div'); bar.id = '__demo_caption';
      bar.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;max-width:960px;padding:12px 18px;border-radius:14px;background:rgba(20,33,61,.94);color:#fff;font:500 16px/1.4 Inter,system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;pointer-events:none';
      document.body.appendChild(bar);
      const badge = document.createElement('div');
      badge.textContent = 'Demo · PayPal and AI simulated';
      badge.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;padding:6px 10px;border-radius:999px;background:#ffc439;color:#001c64;font:700 12px/1 Inter,system-ui,sans-serif;pointer-events:none;top:auto;bottom:86px;right:16px';
      document.body.appendChild(badge);
    }
    bar.innerHTML = `<span style="background:#0052ff;border-radius:999px;padding:4px 10px;font-weight:700;font-size:13px;white-space:nowrap">Step ${step}</span><span>${text}</span>`;
  };
});
await context.route(`${API}/v1/paypal/**`, handle);
await context.route('https://www.sandbox.paypal.com/**', route => route.fulfill({ contentType: 'text/html', body: paypalPage(task.id) }));
const page = await context.newPage();
const pause = ms => page.waitForTimeout(ms);
let shot = 0;
async function step(n, text, wait = 1800) {
  await page.evaluate(([n, text]) => window.__caption(n, text), [n, text]);
  await pause(wait);
  shot += 1;
  await page.screenshot({ path: join(OUT, 'shots', `${String(shot).padStart(2, '0')}-step${n}.png` ) });
}
async function signIn(code) {
  await page.getByLabel('Workspace access code').fill(code);
  await pause(500);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
}
async function scrollTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  await pause(400);
}

await page.goto(`${BASE}/paypal/`);
await step(1, 'Open the PayPal workspace and sign in with the buyer access code.');
await signIn('demo-buyer-code');
await page.getByLabel('Source text', { exact: true }).waitFor();
await step(2, 'Signed in as buyer. Choose a service and paste the documents to analyse.');
await page.getByLabel('Service', { exact: true }).selectOption('document-extract-v1');
await page.getByLabel('Source text', { exact: true }).first().fill(docs[0].text);
await page.getByRole('button', { name: 'Add document', exact: true }).click();
await page.getByLabel('Source text', { exact: true }).nth(1).fill(docs[1].text);
await step(3, 'Two documents at $4.00 each. Prepare quote prices the work; nothing is charged yet.');
await page.getByRole('button', { name: 'Prepare quote', exact: true }).click();
const approve = page.getByRole('button', { name: 'Approve $8.00 quote & open checkout', exact: true });
await approve.waitFor();
await scrollTo(approve);
await step(4, 'The quote is $8.00. Approving it sends the buyer to PayPal sandbox checkout.');
await approve.click();
await page.waitForURL(/sandbox\.paypal\.com/);
await step(5, 'PayPal sandbox checkout. In the real test, log in with the sandbox personal account.', 2600);
await page.getByRole('link', { name: 'Complete purchase' }).click();
await page.waitForURL(/\/paypal\/checkout/);
const capture = page.getByRole('button', { name: 'Confirm capture of $8.00', exact: true });
await capture.waitFor();
await scrollTo(capture);
await step(6, 'Back in ChainPay. The buyer approved on PayPal; now confirm the capture to take the payment.');
await capture.click();
const run = page.getByRole('button', { name: 'Run or recover this paid task', exact: true });
await run.waitFor();
await scrollTo(run);
await step(7, 'Captured. Only a verified capture unlocks the paid work.');
await run.click();
await page.getByText('North Supply delivers in three working days', { exact: false }).first().waitFor();
await scrollTo(page.getByText('North Supply delivers in three working days', { exact: false }).first());
await step(8, 'Delivered. Every claim is linked to an exact excerpt from the source document.', 2600);
const review = page.getByRole('region', { name: 'Buyer resolution' });
await scrollTo(review);
await page.getByLabel('Review reason').fill('Output 2 misses the replacement condition for damaged goods.');
await step(9, 'The buyer reviews each output: accept output 1, challenge output 2 with a reason.');
await page.getByRole('button', { name: 'Accept output 1', exact: true }).click();
await review.getByText('Accepted by buyer', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Challenge output 2', exact: true }).click();
await review.getByText('Challenged by buyer', { exact: true }).waitFor();
await step(10, 'Output 1 accepted, output 2 challenged. The buyer cannot refund themselves; the merchant decides.');
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await page.getByLabel('Workspace access code').waitFor();
await step(11, 'Sign out, and sign back in as the merchant.', 1400);
await signIn('demo-merchant-code');
await page.getByRole('region', { name: 'Buyer resolution' }).waitFor();
await scrollTo(page.getByRole('region', { name: 'Buyer resolution' }));
await page.getByLabel('Review reason').fill('Agreed: refund the challenged output.');
await page.getByLabel('Refund output 2', { exact: true }).check();
await step(12, 'The merchant sees the challenge and selects output 2 for a refund (free rework is the other option).');
await page.getByRole('button', { name: 'Prepare selected-output refund', exact: true }).click();
const approveRefund = page.getByRole('button', { name: 'Approve $4.00 selected-output refund', exact: true }).last();
await approveRefund.waitFor();
await scrollTo(approveRefund);
await step(13, 'A $4.00 refund proposal, bound to that exact output. The merchant approves it.');
await approveRefund.click();
await page.getByText('Refund confirmed', { exact: false }).first().waitFor();
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await pause(800);
await step(14, 'Refund confirmed. Captured $8.00, refunded $4.00, the buyer paid $4.00 net.', 2600);
await page.getByRole('button', { name: 'Outcome dashboard', exact: true }).click();
await page.getByRole('heading', { name: 'Orders cash cost', exact: true }).waitFor();
await step(15, 'The outcome dashboard shows the same numbers: what was captured, refunded and delivered.', 2400);
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await page.getByLabel('Workspace access code').waitFor();
await signIn('demo-buyer-code');
await page.locator('button', { hasText: '$8.00 ·' }).first().click();
const shareButton = page.getByRole('button', { name: 'Share redacted receipt' });
await shareButton.waitFor();
await scrollTo(shareButton);
await shareButton.click();
await page.getByLabel('Public receipt URL').waitFor();
await scrollTo(page.getByLabel('Public receipt URL'));
await step(16, 'Back as the buyer: share a redacted receipt link. Amounts and status for an accountant, no document text.');
await page.goto(`${BASE}/paypal/receipt/${shareToken}`);
await page.waitForLoadState('networkidle');
await pause(800);
await step(17, 'The public receipt, opened without signing in. No buttons, no private content. End of the cycle.', 3000);
await context.close();
await browser.close();
console.log('demo recorded');
