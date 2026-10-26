// Records the allowances / marketplace / disputes cycle in the real PayPal workspace UI.
// The API is a stateful stand-in ported from frontend/test/fixtures/paypal-allowances.tsx
// (same seed catalog, same rule order, same response shapes). PayPal is a simulated page.
// Amounts are BigInt cents or "12.34" strings; nothing here goes through Number() or floats.
//
//   node record-demo.mjs /home/claude/demo-allowances
//
// Needs the Vite dev server first:
//   VITE_CHAINPAY_PAYPAL=true VITE_CHAINPAY_PAYPAL_API_ORIGIN=http://127.0.0.1:8081 npm run dev:paypal
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2] ?? process.cwd();
const BASE = 'http://127.0.0.1:5197';
const API = 'http://127.0.0.1:8081';
await mkdir(join(OUT, 'shots'), { recursive: true });
await mkdir(join(OUT, 'mobile'), { recursive: true });
await mkdir(join(OUT, 'video'), { recursive: true });

const hex = n => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const now = () => BigInt(Math.floor(Date.now() / 1000));
const money = c => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
const centsOf = s => BigInt(String(s).replace('.', ''));
// BigInt cents are written as bare JSON integers, so they never pass through Number.
const json = body => JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v);
const DAY = 86400n;

// Who is who. The access code is the bearer token the UI stores in sessionStorage.
const principals = {
  'demo-buyer-code': { id: 'buyer-one', workspace: 'demo-workspace', role: 'buyer' },
  'demo-agent-code': { id: 'shopper-bot', workspace: 'demo-workspace', role: 'agent' },
  'demo-merchant-code': { id: 'merchant-one', workspace: 'demo-workspace', role: 'merchant' },
};

// Same ids, names, prices and availability as catalog::merchants() on the backend.
const catalog = [
  { id: 'grocer', name: 'Corner Grocer', kind: 'grocery', items: [
    { id: 'oat-milk', name: 'Oat milk 1L', price_cents: 390n, availability: 'always' },
    { id: 'coffee-beans', name: 'Coffee beans 250g', price_cents: 1250n, availability: 'always' },
    { id: 'sourdough', name: 'Sourdough loaf', price_cents: 650n, availability: 'max_per_order:2' },
    { id: 'eggs', name: 'Free-range eggs (12)', price_cents: 480n, availability: 'weekdays' },
  ] },
  { id: 'box-office', name: 'Riverside Box Office', kind: 'events', items: [
    { id: 'matinee', name: 'Matinee ticket', price_cents: 1800n, availability: 'always' },
    { id: 'evening', name: 'Evening show ticket', price_cents: 3200n, availability: 'max_per_order:4' },
    { id: 'programme', name: 'Printed programme', price_cents: 500n, availability: 'always' },
  ] },
  { id: 'tours', name: 'Old Town Tours', kind: 'booking', items: [
    { id: 'walking-tour', name: 'Old town walking tour', price_cents: 2500n, availability: 'always' },
    { id: 'food-tour', name: 'Street food tour', price_cents: 4500n, availability: 'max_per_order:2' },
    { id: 'bike-rental', name: 'Bike rental (half day)', price_cents: 1500n, availability: 'weekdays' },
    { id: 'audio-guide', name: 'Audio guide', price_cents: 600n, availability: 'always' },
  ] },
  { id: 'print-shop', name: 'Quickprint', kind: 'print', items: [
    { id: 'bw-copies', name: 'B&W copies (100 pages)', price_cents: 800n, availability: 'always' },
    { id: 'colour-poster', name: 'Colour poster A2', price_cents: 1900n, availability: 'always' },
    { id: 'business-cards', name: 'Business cards (250)', price_cents: 2400n, availability: 'max_per_order:2' },
    { id: 'binding', name: 'Spiral binding', price_cents: 350n, availability: 'weekdays' },
  ] },
].map(m => ({ ...m, items: m.items.map(i => ({ ...i, price: money(i.price_cents) })) }));
const merchantName = id => catalog.find(m => m.id === id)?.name ?? null;

// One allowance exists before the demo starts: the "Ask me first" one for show tickets.
const allowances = [
  { id: 'al-tickets', name: 'Show tickets', status: 'Active', mode: 'ask_first', agent: 'shopper-bot', merchants: ['box-office'], total_cap_cents: 30000n, per_purchase_cap_cents: 10000n, spent_cents: 0n, purchases_today: 0n, max_per_day: 2n, cooldown_seconds: 0n, last_purchase_at: null, expires_at: now() + 7n * DAY, created_at: now() - 7200n, vault: { source: 'paypal', status: 'ready' } },
];
const tasks = [];
const disputes = [];
const shares = {};

function lineFor(merchant, items) {
  const m = catalog.find(c => c.id === merchant);
  return items.map(i => { const item = m?.items.find(x => x.id === i.id); const qty = BigInt(i.qty); return { id: i.id, name: item?.name ?? i.id, qty, unit_cents: item?.price_cents ?? 0n, line_cents: (item?.price_cents ?? 0n) * qty }; });
}
// Same nine rows in the same order as allowance::check(); the first failing one names the reason code.
function check(a, merchant, amount, actor) {
  const agentOk = actor.role === 'agent' ? !a.agent || a.agent === actor.id : actor.role === 'buyer';
  const since = a.last_purchase_at === null ? null : now() - a.last_purchase_at;
  const rows = [
    ['status', 'allowance_not_active', a.status === 'Active', a.status],
    ['expiry', 'allowance_expired', a.expires_at > now(), String(a.expires_at)],
    ['agent', 'agent_not_allowed', agentOk, actor.id],
    ['merchant', 'merchant_not_allowed', a.merchants.includes(merchant), merchant],
    ['per_purchase_cap', 'per_purchase_cap', amount <= a.per_purchase_cap_cents, money(amount), a.per_purchase_cap_cents, amount],
    ['total_cap', 'total_cap', a.spent_cents + amount <= a.total_cap_cents, `${money(a.spent_cents)} spent`, a.total_cap_cents, a.spent_cents + amount],
    ['max_per_day', 'max_per_day', a.purchases_today < a.max_per_day, `${a.purchases_today} of ${a.max_per_day} today`],
    ['cooldown', 'cooldown', since === null || since >= a.cooldown_seconds, since === null ? 'no purchases yet' : `${since}s since last purchase`],
    ['vault', 'vault_not_ready', a.vault.status === 'ready', a.vault.status],
  ];
  let reason_code = null;
  const checks = rows.map(([rule, code, allowed, observed, limit_cents, observed_cents]) => {
    if (!allowed && reason_code === null) reason_code = code;
    return { rule, ...(limit_cents === undefined ? {} : { limit_cents, observed_cents }), allowed, observed };
  });
  return { allowed: reason_code === null, rule: 'allowance-rules-v1', allowance_id: a.id, reason_code, checks };
}
function purchaseTask(allowance, merchant, items, policy, actor) {
  const id = hex(32);
  const lines = lineFor(merchant, items);
  const gross = lines.reduce((sum, l) => sum + l.line_cents, 0n);
  const units = lines.flatMap(l => Array.from({ length: Number(l.qty) }, () => ({ name: l.name, price_cents: l.unit_cents }))).map((u, index) => ({ index, state: 'pending', revision: 0, input_hash: `sha256:${hex(56)}`, output_hash: null, reason: null, ...u }));
  const askFirst = allowance.mode === 'ask_first';
  const captured = policy.allowed && !askFirst;
  return {
    id, gross_cents: gross, refund_cents: 0n, captured, capture_id: captured ? `DEMO-CAPTURE-${hex(6).toUpperCase()}` : null, order_id: captured ? `DEMO-ORDER-${hex(6).toUpperCase()}` : null,
    refund_id: null, refund_state: null, refund_confirmed: false, units, quote_digest: hex(64), quote_expires_at: now() + 1800n, created_at: now(), service_name: merchantName(merchant), dispute: null,
    purchase: { merchant, buyer: 'buyer-one', allowance_id: allowance.id, mode: allowance.mode, approval: policy.allowed && askFirst ? 'requested' : null, approval_requested_at: policy.allowed && askFirst ? now() : null, approval_decided_at: null, approved_by: null, lines: lines.map(({ line_cents: _unused, ...l }) => l), policy, refund_request: null, requested_by: actor.id },
  };
}
// observations.rs receipt shape. The public view drops digests, identities and the approval link.
function taskView(t, publicView = false) {
  const units = t.units.map(({ price_cents, ...u }) => ({ ...u, price: money(price_cents), buyer_review: null, source: 'merchant work record' }));
  const view = {
    id: t.id, sandbox: true, currency: 'USD', offer_version: 'catalog-v1', service_name: t.service_name, created_at: t.created_at,
    gross: money(t.gross_cents), refund: money(t.refund_cents), net: t.captured ? money(t.gross_cents - (t.refund_confirmed ? t.refund_cents : 0n)) : null,
    captured: t.captured, funded: t.captured, funding_method: 'paypal_vault', refund_confirmed: t.refund_confirmed, units,
    order_id: t.order_id, capture_id: t.capture_id, refund_id: t.refund_id, order_state: t.captured ? 'observed' : null, capture_state: t.captured ? 'observed' : null, refund_state: t.refund_state,
    payment_source: 'PayPal sandbox API observation', delivery_source: 'Merchant processing record; not buyer acceptance', dispute: t.dispute,
    purchase: { merchant: t.purchase.merchant, allowance_id: t.purchase.allowance_id, mode: t.purchase.mode, approval: t.purchase.approval, approval_requested_at: t.purchase.approval_requested_at, approval_decided_at: t.purchase.approval_decided_at, approved_by: publicView ? null : t.purchase.approved_by, lines: t.purchase.lines, policy: t.purchase.policy, refund_request: t.purchase.refund_request && (publicView ? { ...t.purchase.refund_request, requested_by: 'redacted' } : t.purchase.refund_request) },
  };
  if (!publicView) Object.assign(view, { quote_digest: t.quote_digest, quote_expires_at: t.quote_expires_at, share_token: shares[t.id] ?? null, resolution: [], revisions: t.units.map(() => []), refunds: [] });
  return view;
}
// allowance_view(): vault only for the owning buyer, approval_url only while the vault is not ready.
function allowanceView(a, role) {
  const { vault, ...rest } = a;
  const base = { ...rest, remaining_cents: a.total_cap_cents - a.spent_cents, sandbox: true };
  if (role !== 'buyer') return base;
  return { ...base, vault: vault.status === 'ready' ? { source: vault.source, status: vault.status } : { source: vault.source, status: vault.status, approval_url: vault.approval_url ?? null } };
}
function evidencePack(d) {
  const t = tasks.find(x => x.id === d.task_id);
  const a = allowances.find(x => x.id === t.purchase.allowance_id);
  const delivered = t.units.filter(u => u.state === 'delivered').length, failed = t.units.filter(u => u.state === 'failed').length;
  const p = t.purchase;
  return {
    dispute_id: d.id, task_id: t.id, capture_id: t.capture_id,
    allowance: { id: a.id, name: a.name, rule: p.policy.rule, checks: p.policy.checks },
    approval: p.approval ? { approval: p.approval, approved_by: p.approved_by, approval_requested_at: p.approval_requested_at, approval_decided_at: p.approval_decided_at } : null,
    delivery: t.units.map(u => ({ unit: u.index, state: u.state, delivered_at: u.state === 'delivered' ? u.delivered_at : null })),
    buyer_review: [], rework: [], refunds: t.refund_confirmed ? [{ id: t.refund_id, amount: money(t.refund_cents), confirmed: true }] : [],
    receipt_digest: `sha256:${hex(64)}`, public_receipt_url: shares[t.id] ? `${BASE}/paypal/receipt/${shares[t.id]}` : null,
    notes: `Purchase ${t.id} for ${money(t.gross_cents)} USD was authorised under buyer allowance "${a.name}" (${p.policy.rule}) and captured as ${t.capture_id}. ${p.approval === 'approved' ? `The buyer approved this purchase on ${new Date(Number(p.approval_decided_at) * 1000).toISOString()}.` : 'The buyer pre-approved purchases of this kind without a per-purchase review.'} Of ${t.units.length} units, ${delivered} were marked delivered and ${failed} failed by the merchant. ${t.refund_confirmed ? `A refund of ${money(t.refund_cents)} USD was issued.` : 'No refund has been issued.'}`,
    digest: d.pack_digest,
  };
}

async function handle(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace('/v1/paypal', '');
  const seg = path.split('/').filter(Boolean);
  const method = request.method();
  const cors = { 'Access-Control-Allow-Origin': BASE, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE' };
  const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: json(body) });
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const token = (request.headers().authorization ?? '').replace(/^Bearer /, '');
  const me = principals[token];
  const role = me?.role;
  const b = request.postData() ? request.postDataJSON() : {};
  // A short pause so the recording shows the request happening.
  await new Promise(r => setTimeout(r, 200));

  if (path.startsWith('/receipts/')) {
    const id = Object.keys(shares).find(k => shares[k] === seg[1]);
    const t = tasks.find(x => x.id === id);
    return t ? send(taskView(t, true)) : send({ error: 'No such receipt' }, 404);
  }
  if (!me) return send({ error: 'Unknown access code' }, 401);
  if (path === '/session') return method === 'DELETE' ? send({}) : send(me);
  if (path === '/offers') return send({ offers: [
    { id: 'document-extract-v1', name: 'Evidence-linked document summary', unit_price: '4.00', delivery: 'Summary and factual claims linked to source excerpts.', min_documents: 1, max_documents: 10, requires_requirements: false },
    { id: 'document-compare-v1', name: 'Compare two documents', unit_price: '8.00', delivery: 'Differences between two sources with excerpts.', min_documents: 2, max_documents: 2, requires_requirements: false },
  ] });
  if (path === '/preflight') return send({ ready: true, outputs: b.documents?.length ?? 0, amount: money(BigInt(b.documents?.length ?? 0) * 400n), issues: [] });
  if (path === '/subscriptions/terms') return send({ terms: 'demo', plan_id: null, enabled: false, policy: 'Subscriptions are off in this demo.', price: '40.00', units: 10 });
  if (path === '/subscriptions') return send({ subscriptions: [] });
  if (path === '/catalog') return send({ merchants: catalog });
  if (path === '/analytics') {
    const captured = tasks.filter(t => t.captured).reduce((s, t) => s + t.gross_cents, 0n);
    const refunds = tasks.filter(t => t.refund_confirmed).reduce((s, t) => s + t.refund_cents, 0n);
    return send({ captured: money(captured), confirmed_refunds: money(refunds), known_net_cost: money(captured - refunds), delivered_units: tasks.flatMap(t => t.units).filter(u => u.state === 'delivered').length, failed_units: tasks.flatMap(t => t.units).filter(u => u.state === 'failed').length, unresolved_tasks: 0, task_count: tasks.length, scope: 'Latest 100 tasks accessible to this principal; not lifetime totals', tasks: tasks.map(t => taskView(t)) });
  }

  if (path === '/allowances' && method === 'GET') {
    // Merchants never see allowances; agents see only the active ones they may use.
    const visible = role === 'merchant' ? [] : role === 'agent' ? allowances.filter(a => a.status === 'Active' && (!a.agent || a.agent === me.id)) : allowances;
    return send({ allowances: visible.map(a => allowanceView(a, role)) });
  }
  if (path === '/allowances' && method === 'POST') {
    if (role !== 'buyer') return send({ error: 'Only the buyer creates allowances' }, 403);
    const id = `al-${String(allowances.length + 1).padStart(3, '0')}`;
    const paypal = b.vault_source !== 'card';
    // The request body carries bare integers; re-read them from the raw text so they stay exact.
    const raw = request.postData();
    const int = key => BigInt(new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(raw)[1]);
    const a = { id, name: String(b.name), status: 'Active', mode: String(b.mode), agent: b.agent ?? null, merchants: b.merchants, total_cap_cents: int('total_cap_cents'), per_purchase_cap_cents: int('per_purchase_cap_cents'), spent_cents: 0n, purchases_today: 0n, max_per_day: int('max_per_day'), cooldown_seconds: int('cooldown_seconds'), last_purchase_at: null, expires_at: int('expires_at'), created_at: now(), vault: paypal ? { source: 'paypal', status: 'pending_approval', approval_url: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${id}` } : { source: 'card', status: 'ready' } };
    allowances.unshift(a);
    return send(allowanceView(a, role));
  }
  if (seg[0] === 'allowances' && seg[2] === 'vault') {
    const a = allowances.find(x => x.id === seg[1]);
    if (!a) return send({ error: 'No such allowance' }, 404);
    a.vault = { source: a.vault.source, status: 'ready' };
    return send(allowanceView(a, role));
  }
  if (seg[0] === 'allowances' && seg[2] === 'status') {
    const a = allowances.find(x => x.id === seg[1]);
    if (!a) return send({ error: 'No such allowance' }, 404);
    if (a.status === 'Revoked') return send({ error: 'Revoked allowances stay revoked' }, 409);
    a.status = String(b.status);
    return send(allowanceView(a, role));
  }
  if (seg[0] === 'allowances' && seg.length === 2) {
    const a = allowances.find(x => x.id === seg[1]);
    return a ? send(allowanceView(a, role)) : send({ error: 'No such allowance' }, 404);
  }

  if (path === '/purchases/quote') {
    const lines = lineFor(String(b.merchant), b.items);
    const amount = lines.reduce((sum, l) => sum + l.line_cents, 0n);
    const quote = { merchant: b.merchant, lines, amount_cents: amount, amount: money(amount), currency: 'USD', sandbox: true };
    if (b.allowance_id) {
      const a = allowances.find(x => x.id === b.allowance_id);
      if (!a) return send({ error: 'Not found' }, 404);
      quote.policy = check(a, String(b.merchant), amount, me);
    }
    return send(quote);
  }
  if (path === '/purchases' && method === 'POST') {
    const existing = tasks.find(t => t.request_id === b.request_id);
    if (existing) return send(taskView(existing));
    const a = allowances.find(x => x.id === b.allowance_id);
    if (!a) return send({ error: 'Not found' }, 404);
    // Same rule as the server: the caller says which mode it expects, and it must match.
    if (!['agent_pays', 'ask_first'].includes(b.mode)) return send({ error: 'Purchase mode is agent_pays or ask_first' }, 422);
    if (b.mode !== a.mode) return send({ error: `Allowance mode is ${a.mode}, not ${b.mode}` }, 422);
    const amount = lineFor(String(b.merchant), b.items).reduce((sum, l) => sum + l.line_cents, 0n);
    const policy = check(a, String(b.merchant), amount, me);
    const task = purchaseTask(a, String(b.merchant), b.items, policy, me);
    task.request_id = b.request_id;
    // An allowed purchase reserves the cap now in both modes, like the server does.
    if (policy.allowed) { a.spent_cents += amount; a.purchases_today += 1n; a.last_purchase_at = now(); }
    tasks.unshift(task);
    return send(taskView(task));
  }
  if (path === '/purchases/approvals') return send({ approvals: tasks.filter(t => t.purchase.approval === 'requested').map(t => taskView(t)) });
  if (seg[0] === 'purchases' && seg[2] === 'approve') {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return send({ error: 'No such purchase' }, 404);
    if (b.digest !== t.quote_digest) return send({ error: 'Digest does not match the quote' }, 409);
    if (t.purchase.approval === 'approved') return send(taskView(t));
    if (t.purchase.approval !== 'requested') return send({ error: 'Purchase is not waiting for approval' }, 409);
    // Rules run again at approval time, not counting this purchase's own reserve.
    // A failing re-check denies it on the rules' behalf and releases the reserve.
    const a = allowances.find(x => x.id === t.purchase.allowance_id);
    const others = a.purchases_today - 1n;
    const policy = check({ ...a, spent_cents: a.spent_cents - t.gross_cents, purchases_today: others, last_purchase_at: others === 0n ? null : a.last_purchase_at }, t.purchase.merchant, t.gross_cents, me);
    t.purchase.policy = policy;
    t.purchase.approval_decided_at = now();
    if (!policy.allowed) {
      t.purchase.approval = 'denied'; t.purchase.approved_by = 'rules';
      a.spent_cents -= t.gross_cents; a.purchases_today -= 1n;
      return send(taskView(t));
    }
    t.purchase.approval = 'approved'; t.purchase.approved_by = me.id;
    t.captured = true; t.capture_id = `DEMO-CAPTURE-${hex(6).toUpperCase()}`; t.order_id = `DEMO-ORDER-${hex(6).toUpperCase()}`;
    return send(taskView(t));
  }
  if (seg[0] === 'purchases' && seg[2] === 'deny') {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return send({ error: 'No such purchase' }, 404);
    if (t.purchase.approval === 'requested') { const a = allowances.find(x => x.id === t.purchase.allowance_id); a.spent_cents -= t.gross_cents; a.purchases_today -= 1n; }
    t.purchase.approval = 'denied'; t.purchase.approval_decided_at = now(); t.purchase.approved_by = me.id;
    t.purchase.policy = { ...t.purchase.policy, allowed: false, reason_code: 'denied', checks: [...t.purchase.policy.checks, { rule: 'buyer_decision', allowed: false, observed: String(b.reason) }] };
    return send(taskView(t));
  }

  if (seg[0] === 'tasks' && seg[2] === 'fulfil') {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return send({ error: 'No such task' }, 404);
    if (!t.captured) return send({ error: 'A verified capture is required before fulfilment' }, 422);
    for (const o of b.outcomes) {
      const u = t.units[o.unit];
      if (u && u.state === 'pending') { u.state = o.state; u.output_hash = `sha256:${hex(56)}`; u.reason = o.reason ?? null; u.delivered_at = now(); }
    }
    return send(taskView(t));
  }
  if (seg[0] === 'tasks' && seg[2] === 'refund-request') {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return send({ error: 'No such task' }, 404);
    const failed = t.units.filter(u => u.state === 'failed').map(u => u.index);
    const amount_cents = failed.reduce((sum, i) => sum + t.units[i].price_cents, 0n);
    t.purchase.refund_request = { reason: b.reason, amount: money(amount_cents), amount_cents, digest: hex(64), failed_units: failed, requested_by: me.id, requested_at: now() };
    return send({ amount: money(amount_cents), amount_cents, currency: 'USD', digest: t.purchase.refund_request.digest, failed_units: failed, capture_id: t.capture_id, requires_merchant_approval: true });
  }
  if (seg[0] === 'tasks' && seg[2] === 'refund') {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return send({ error: 'No such task' }, 404);
    if (role !== 'merchant') return send({ error: 'Only a merchant approves a refund' }, 403);
    const r = t.purchase.refund_request;
    if (!r || b.digest !== r.digest) return send({ error: 'Digest does not match the refund request' }, 409);
    // The real service confirms this when PayPal's verified webhook arrives.
    t.refund_confirmed = true; t.refund_cents = r.amount_cents; t.refund_id = `DEMO-REFUND-${hex(6).toUpperCase()}`; t.refund_state = 'observed';
    return send(taskView(t));
  }
  if (seg[0] === 'tasks' && seg[2] === 'share') {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return send({ error: 'No such task' }, 404);
    if (method === 'DELETE') { delete shares[t.id]; return send({}); }
    shares[t.id] = hex(64);
    return send({ token: shares[t.id] });
  }
  if (seg[0] === 'tasks' && seg[2] === 'explain') {
    const t = tasks.find(x => x.id === seg[1]);
    return send({ explanation: `Simulated explanation: USD ${money(t.gross_cents)} was captured under the allowance rules; ${t.refund_confirmed ? `USD ${money(t.refund_cents)} was refunded for the failed unit.` : 'no refund has been confirmed.'}`, receipt: taskView(t) });
  }
  if (seg[0] === 'tasks' && seg[2] === 'reporting') return send({ note: 'Simulated PayPal transaction report for this demo.', truncated: false, transactions: [] });
  if (seg[0] === 'tasks' && seg.length >= 2) {
    const t = tasks.find(x => x.id === seg[1]);
    return t ? send(taskView(t)) : send({ error: 'No such task' }, 404);
  }
  if (path === '/tasks') return send({ tasks: tasks.map(t => taskView(t)) });

  if (path === '/disputes' || path === '/disputes/sync') {
    if (role !== 'merchant') return send({ error: 'Merchant only' }, 403);
    if (path === '/disputes/sync') {
      // "PayPal" has opened one case: the buyer of the show tickets says they never got them.
      const t = tasks.find(x => x.captured && x.purchase.merchant === 'box-office');
      if (t && !disputes.some(d => d.task_id === t.id)) {
        const d = { id: `PP-D-${hex(8).toUpperCase()}`, task_id: t.id, capture_id: t.capture_id, status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amount_cents: t.gross_cents, amount: money(t.gross_cents), currency: 'USD', created_at: now() - 1800n, updated_at: now() - 1800n, seller_response_due: now() + 5n * DAY, evidence: 'none', evidence_submitted_at: null, evidence_digest: null, sandbox: true, pack_digest: `sha256:${hex(64)}` };
        disputes.push(d);
        t.dispute = { id: d.id, status: d.status, evidence: d.evidence };
      }
    }
    return send({ disputes: disputes.map(({ pack_digest: _unused, ...d }) => d) });
  }
  if (seg[0] === 'disputes' && seg[2] === 'evidence') {
    const d = disputes.find(x => x.id === seg[1]);
    if (!d) return send({ error: 'No such dispute' }, 404);
    if (method === 'GET') return send(evidencePack(d));
    if (b.digest !== d.pack_digest) return send({ error: 'Digest does not match the preview' }, 409);
    if (d.evidence !== 'none') return send({ error: 'Evidence was already submitted' }, 409);
    d.evidence = 'submitted'; d.evidence_submitted_at = now(); d.evidence_digest = d.pack_digest;
    const t = tasks.find(x => x.id === d.task_id);
    t.dispute = { id: d.id, status: d.status, evidence: 'submitted' };
    const { pack_digest: _unused, ...view } = d;
    return send(view);
  }
  return send({ error: `Demo has no route for ${method} ${path}` }, 404);
}

// The page PayPal would show when the buyer sets up the allowance's payment method.
const paypalPage = id => {
  const a = allowances.find(x => x.id === id);
  return `<!doctype html><meta charset="utf-8"><title>PayPal Sandbox (simulated)</title>
<style>body{margin:0;font-family:Helvetica,Arial,sans-serif;background:#f5f7fa;color:#001c64}.bar{background:#003087;color:#fff;padding:14px 24px;font-weight:700;font-size:20px}
.tag{background:#ffc439;color:#001c64;font-size:12px;padding:4px 8px;border-radius:4px;margin-left:12px;vertical-align:middle}.card{max-width:440px;margin:48px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 6px}.amt{font-size:34px;font-weight:700;margin:18px 0}.row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #e6e9ef;font-size:14px}
a.pay{display:block;text-align:center;margin-top:22px;background:#0070e0;color:#fff;padding:14px;border-radius:24px;text-decoration:none;font-weight:700}small{display:block;margin-top:14px;color:#5b6b8c;font-size:12px}</style>
<div class="bar">PayPal <span class="tag">SANDBOX · SIMULATED FOR THIS DEMO</span></div>
<div class="card"><h1>Save a payment method for ChainPay</h1><div>Logged in as sandbox-buyer@personal.example.com</div><div class="amt">up to $${money(a.per_purchase_cap_cents)} per purchase</div>
<div class="row"><span>Allowance</span><span>${a.name}</span></div><div class="row"><span>Total limit</span><span>$${money(a.total_cap_cents)}</span></div><div class="row"><span>Pay with</span><span>PayPal balance (sandbox)</span></div>
<a class="pay" href="${BASE}/paypal/?allowance=${id}">Agree and continue</a><small>In the real test this is PayPal's own sandbox approval page for a saved payment method. Nothing is charged now.</small></div>`;
};

// Caption bar, demo badge and a picture-in-picture frame for "the other tab". All pointer-events:none.
const overlay = () => {
  window.__caption = (step, text) => {
    let bar = document.getElementById('__demo_caption');
    if (!bar) {
      bar = document.createElement('div'); bar.id = '__demo_caption';
      bar.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;max-width:1040px;padding:12px 18px;border-radius:14px;background:rgba(20,33,61,.94);color:#fff;font:500 16px/1.4 Inter,system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;pointer-events:none';
      document.body.appendChild(bar);
      const badge = document.createElement('div');
      badge.textContent = 'Demo · PayPal simulated';
      badge.style.cssText = 'position:fixed;z-index:99999;padding:6px 10px;border-radius:999px;background:#ffc439;color:#001c64;font:700 12px/1 Inter,system-ui,sans-serif;pointer-events:none;top:74px;right:16px';
      document.body.appendChild(badge);
    }
    bar.innerHTML = `<span style="background:#0052ff;border-radius:999px;padding:4px 10px;font-weight:700;font-size:13px;white-space:nowrap">Step ${step}</span><span>${text}</span>`;
  };
  window.__pip = (label, src) => {
    let box = document.getElementById('__demo_pip');
    if (!box) {
      box = document.createElement('div'); box.id = '__demo_pip';
      box.style.cssText = 'position:fixed;top:104px;right:24px;z-index:99998;width:760px;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.4);border:3px solid #0052ff;pointer-events:none';
      document.body.appendChild(box);
    }
    box.innerHTML = `<div style="background:#0052ff;color:#fff;font:700 13px/1 Inter,system-ui,sans-serif;padding:9px 12px">${label}</div><img src="${src}" style="display:block;width:100%">`;
  };
  window.__pipOff = () => document.getElementById('__demo_pip')?.remove();
};

async function wire(context) {
  await context.addInitScript(overlay);
  await context.route(`${API}/v1/paypal/**`, handle);
  await context.route('https://www.sandbox.paypal.com/**', route => route.fulfill({ contentType: 'text/html', body: paypalPage(new URL(route.request().url()).searchParams.get('approval_session_id')) }));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } } });
await wire(context);
const page = await context.newPage();
const pause = ms => page.waitForTimeout(ms);
let shot = 0;
async function step(n, name, text, wait = 1600) {
  await page.evaluate(([n, text]) => window.__caption(n, text), [n, text]);
  await pause(wait);
  shot += 1;
  await page.screenshot({ path: join(OUT, 'shots', `${String(shot).padStart(2, '0')}-${name}.png`) });
}
async function signIn(p, code) {
  await p.getByLabel('Workspace access code').fill(code);
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await p.getByRole('group', { name: 'Workspace view switcher' }).waitFor();
}
async function signOut(p) {
  await p.getByRole('button', { name: 'Sign out', exact: true }).click();
  await p.getByLabel('Workspace access code').waitFor();
}
const pill = (p, name) => p.getByRole('group', { name: 'Workspace view switcher' }).getByRole('button', { name, exact: true });
const taskButton = (p, amount) => p.getByRole('navigation', { name: 'Task receipts' }).locator('button', { hasText: `${amount} ·` }).first();
async function scrollTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  await pause(400);
}
async function typeSlow(locator, text) {
  await locator.fill('');
  await locator.pressSequentially(text, { delay: 140 });
}
async function openMarket(p, merchant, lines) {
  await pill(p, 'Marketplace').click();
  await p.getByRole('group', { name: 'Merchants' }).getByRole('button', { name: merchant }).click();
  for (const [item, qty] of lines) for (let i = 0; i < qty; i++) { await p.getByRole('button', { name: `More ${item}`, exact: true }).click(); await p.waitForTimeout(350); }
}

// 1. Buyer signs in and opens Allowances.
await page.goto(`${BASE}/paypal/`);
await step(1, 'sign-in', 'The buyer opens the PayPal workspace with their access code.', 1400);
await signIn(page, 'demo-buyer-code');
await pill(page, 'Allowances').click();
await page.getByRole('form', { name: 'New allowance' }).waitFor();
await step(1, 'allowances', 'Allowances: the caps a buyer sets once. The agent spends inside them and never sees how the buyer pays.', 2000);

// 2. Build "Weekend errands" and approve its payment method on PayPal.
await page.evaluate(() => window.__caption(2, 'Build "Weekend errands". The blue card rewrites as the caps are typed.'));
await typeSlow(page.getByLabel('Name', { exact: true }), 'Weekend errands');
await typeSlow(page.getByLabel('Total cap (USD)'), '120');
await typeSlow(page.getByLabel('Per purchase cap (USD)'), '40');
await page.getByLabel('Riverside Box Office').check();
await typeSlow(page.getByLabel('Cooldown (seconds)'), '0');
// Typing the cooldown scrolled the heading under the sticky bar; bring it back for the shot.
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await pause(600);
await step(2, 'builder-filled', '$120 total, $40 per purchase, two merchants, Agent pays, PayPal sandbox. Any agent may use it.', 2200);
await page.getByRole('button', { name: 'Create allowance', exact: true }).click();
const approvalLink = page.getByRole('link', { name: 'Continue PayPal approval' });
await approvalLink.waitFor();
await scrollTo(approvalLink);
await step(2, 'created-pending', 'Created. The payment method is not ready until the buyer approves it on PayPal.', 1800);
await approvalLink.click();
await page.waitForURL(/sandbox\.paypal\.com/);
await step(2, 'paypal-approve', 'PayPal sandbox: the buyer saves a payment method for this allowance. Nothing is charged now.', 2200);
await page.getByRole('link', { name: 'Agree and continue' }).click();
await page.waitForURL(/allowance=/);
const newRow = page.locator('.paypal-allowance-row', { hasText: 'Weekend errands' });
await newRow.getByText('Payment method ready (PayPal sandbox).').waitFor();
await scrollTo(newRow);
await step(2, 'allowance-ready', 'Back in ChainPay with ?allowance=. The vault is ready; the allowance is Active.', 2000);

// 3. The agent sees the policy, not the payment, and buys groceries under it.
await signOut(page);
await step(3, 'agent-sign-in', 'Now the agent signs in with its own access code.', 1200);
await signIn(page, 'demo-agent-code');
await pill(page, 'Allowances').click();
await page.locator('.paypal-allowance-row', { hasText: 'Weekend errands' }).waitFor();
await step(3, 'agent-allowances', 'The agent sees the rules and nothing about the vault or payment method.', 2000);
await openMarket(page, 'Corner Grocer', [['Oat milk 1L', 2], ['Coffee beans 250g', 1]]);
await page.getByText('Allowed by the allowance rules.').waitFor();
await page.locator('details', { hasText: 'Rule checks' }).locator('summary').click();
await scrollTo(page.locator('.paypal-quote'));
await step(3, 'market-quote-allowed', 'Corner Grocer: 2 × Oat milk + Coffee beans = $20.30. The quote passes all nine rules.', 2200);
await page.getByRole('button', { name: 'Buy now · $20.30', exact: true }).click();
await page.getByText('PayPal capture confirmed').waitFor();
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await pause(600);
await step(3, 'receipt-captured', 'Captured $20.30 from the buyer\'s vault. The receipt records the lines and the rule checks.', 2200);

// 4. Over the cap, then an ask-first allowance.
await openMarket(page, 'Riverside Box Office', [['Evening show ticket', 2]]);
await page.locator('code', { hasText: 'per_purchase_cap' }).waitFor();
await scrollTo(page.locator('.paypal-quote'));
await step(4, 'market-over-cap', '2 × Evening show ticket = $64.00. Refused: over the $40 per-purchase cap. Buy now stays disabled.', 2400);
await page.locator('#market-allowance').selectOption('al-tickets');
await page.getByText('Allowed by the allowance rules.').waitFor();
await step(4, 'market-ask-first', 'Switch to "Show tickets", an Ask-me-first allowance with a $100 cap. Allowed, but the buyer decides.', 2200);
await page.getByRole('button', { name: 'Buy now · $64.00', exact: true }).click();
await page.getByText('Approval requested', { exact: true }).first().waitFor();
await step(4, 'receipt-approval-requested', 'Nothing is charged. The purchase waits in the buyer\'s inbox as "Approval requested".', 2000);

// 5. The buyer approves, then pauses the errands allowance while the agent has a quote open.
await signOut(page);
await signIn(page, 'demo-buyer-code');
await pill(page, 'Allowances').click();
await page.getByText('Waiting for you (1)').waitFor();
await step(5, 'inbox', 'Buyer inbox: "Waiting for you (1)". One tap approves or denies the $64.00 ticket purchase.', 2000);
await page.getByRole('button', { name: 'Approve $64.00', exact: true }).click();
await page.getByText('PayPal capture confirmed').waitFor();
await step(5, 'receipt-approved', 'Approved. The rules ran again at approval time, then the $64.00 was captured.', 2000);

// The agent keeps a quote open in its own tab (no video; shown picture-in-picture).
const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await wire(agentContext);
const agentPage = await agentContext.newPage();
await agentPage.goto(`${BASE}/paypal/`);
await signIn(agentPage, 'demo-agent-code');
await openMarket(agentPage, 'Corner Grocer', [['Oat milk 1L', 1]]);
await agentPage.getByText('Allowed by the allowance rules.').waitFor();
await agentPage.locator('.paypal-quote').scrollIntoViewIfNeeded();
const pipShot = async () => `data:image/png;base64,${(await agentPage.screenshot()).toString('base64')}`;
await page.evaluate(([label, src]) => window.__pip(label, src), ['Agent tab · shopper-bot', await pipShot()]);
await step(5, 'agent-quote-open', 'Meanwhile the agent has another grocery quote open under "Weekend errands": Allowed.', 2200);
await page.evaluate(() => window.__pipOff());
await pill(page, 'Allowances').click();
const errands = page.locator('.paypal-allowance-row', { hasText: 'Weekend errands' });
await errands.waitFor();
await scrollTo(errands);
await errands.getByRole('button', { name: 'Pause', exact: true }).click();
await errands.locator('.paypal-pill', { hasText: 'Paused' }).waitFor();
await step(5, 'allowance-paused', 'The buyer pauses "Weekend errands". No agent action can resume it.', 1800);
await agentPage.getByRole('button', { name: 'More Oat milk 1L', exact: true }).click();
await agentPage.locator('code', { hasText: 'allowance_not_active' }).waitFor();
await page.evaluate(([label, src]) => window.__pip(label, src), ['Agent tab · shopper-bot', await pipShot()]);
await step(5, 'agent-not-active', 'The agent\'s next quote is refused: allowance_not_active. The status rule runs first.', 2400);
await page.evaluate(() => window.__pipOff());
await agentContext.close();

// 6. Merchant fulfils; one unit fails; the agent asks for a refund; the merchant approves it.
await signOut(page);
await signIn(page, 'demo-merchant-code');
await taskButton(page, '$20.30').click();
await page.getByRole('button', { name: 'Fulfil unit 1', exact: true }).waitFor();
await scrollTo(page.getByRole('button', { name: 'Fulfil unit 1', exact: true }));
await step(6, 'merchant-receipt', 'Merchant view of the grocery receipt. Each unit is fulfilled or failed on its own.', 1800);
await page.getByRole('button', { name: 'Fulfil unit 1', exact: true }).click();
await page.getByRole('button', { name: 'Fulfil unit 2', exact: true }).click();
await page.getByRole('button', { name: 'Mark unit 3 failed', exact: true }).click();
await page.getByText('2 delivered · 1 failed').waitFor();
await step(6, 'merchant-fulfilled', 'Units 1 and 2 delivered, unit 3 (Coffee beans) failed. The failure is on the record.', 2000);
await signOut(page);
await signIn(page, 'demo-agent-code');
await taskButton(page, '$20.30').click();
const refundRequest = page.getByRole('button', { name: 'Request refund for failed units', exact: true });
await refundRequest.waitFor();
await scrollTo(refundRequest);
await step(6, 'agent-refund-request', 'The agent asks for a refund of the failed unit. It cannot refund itself; a merchant approves.', 1800);
await refundRequest.click();
await page.getByText('Refund requested: $12.50').waitFor();
await step(6, 'agent-refund-requested', 'Refund requested: $12.50, exactly the failed unit\'s price, bound to unit 3.', 1800);
await signOut(page);
await signIn(page, 'demo-merchant-code');
await taskButton(page, '$20.30').click();
const approveRefund = page.getByRole('button', { name: 'Approve $12.50 refund', exact: true });
await approveRefund.waitFor();
await scrollTo(approveRefund);
await step(6, 'merchant-refund-approve', 'The merchant approves the $12.50 refund.', 1500);
await approveRefund.click();
await page.getByText('Refund confirmed', { exact: true }).waitFor();
await scrollTo(page.locator('.paypal-cost'));
await step(6, 'refund-confirmed', 'Refund confirmed. Captured $20.30, refunded $12.50, net buyer cost $7.80.', 2200);

// 7. A PayPal dispute on the ticket capture; the merchant answers with the evidence pack.
await pill(page, 'Disputes').click();
await page.getByRole('button', { name: 'Sync from PayPal', exact: true }).waitFor();
await step(7, 'disputes-empty', 'Disputes: sync pulls open PayPal cases for captured purchases.', 1500);
await page.getByRole('button', { name: 'Sync from PayPal', exact: true }).click();
await page.getByRole('cell', { name: 'WAITING_FOR_SELLER_RESPONSE' }).waitFor();
await step(7, 'disputes-synced', 'One case on the $64.00 ticket capture: WAITING_FOR_SELLER_RESPONSE, evidence "Not sent".', 2200);
await page.getByRole('button', { name: 'Preview evidence pack', exact: true }).click();
await page.locator('.paypal-evidence').waitFor();
await scrollTo(page.locator('.paypal-evidence'));
await step(7, 'evidence-preview', 'The evidence pack is the task record: rules that passed, who approved, delivery, refunds, digest.', 2600);
await page.getByRole('button', { name: 'Submit evidence pack', exact: true }).click();
await page.getByText('Evidence submitted').waitFor();
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await pause(600);
await step(7, 'evidence-submitted', 'Submitted once, with its digest. The table now shows "Submitted".', 2000);
await page.locator('.paypal-dispute-table .paypal-link-button').click();
await page.getByText('Dispute WAITING_FOR_SELLER_RESPONSE').waitFor();
await step(7, 'receipt-dispute-pill', 'The ticket receipt carries the dispute pill next to its payment status.', 2000);

// 8. The buyer shares a redacted receipt.
await signOut(page);
await signIn(page, 'demo-buyer-code');
await taskButton(page, '$20.30').click();
const shareButton = page.getByRole('button', { name: 'Share redacted receipt', exact: true });
await shareButton.waitFor();
await scrollTo(shareButton);
await shareButton.click();
await page.getByLabel('Public receipt URL').waitFor();
await scrollTo(page.getByLabel('Public receipt URL'));
await step(8, 'share-link', 'Back as the buyer: share a redacted receipt link for an accountant.', 1800);
const shareUrl = await page.getByLabel('Public receipt URL').inputValue();
await page.goto(shareUrl);
await page.getByText('Purchase at Corner Grocer').waitFor();
await pause(500);
await step(8, 'public-receipt', 'The public receipt, no sign-in: lines, rule checks, refund and net cost. No buttons, no approval actions. End.', 3000);
await context.close();

// Mobile screenshots at 390 wide, from the same mock state.
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await wire(mobile);
const m = await mobile.newPage();
let mshot = 0;
// Scroll to the top first, or the sticky header gets painted mid-page in the full-page capture.
const mobileShot = async name => { mshot += 1; await m.evaluate(() => window.scrollTo(0, 0)); await m.waitForTimeout(600); await m.screenshot({ path: join(OUT, 'mobile', `${String(mshot).padStart(2, '0')}-${name}.png`), fullPage: true }); };
await m.goto(`${BASE}/paypal/`);
await signIn(m, 'demo-buyer-code');
await pill(m, 'Allowances').click();
await m.getByRole('form', { name: 'New allowance' }).waitFor();
await mobileShot('allowances-builder');
// A fresh ask-first purchase so the inbox has something in it.
const tickets = allowances.find(a => a.id === 'al-tickets');
tasks.unshift(purchaseTask(tickets, 'box-office', [{ id: 'matinee', qty: 2 }], check(tickets, 'box-office', 3600n, principals['demo-agent-code']), principals['demo-agent-code']));
await m.getByRole('button', { name: 'Refresh', exact: true }).click();
await m.getByText('Waiting for you (1)').waitFor();
await mobileShot('approvals-inbox');
await taskButton(m, '$20.30').click();
await m.getByText('Purchase at Corner Grocer').waitFor();
await mobileShot('receipt-purchase');
await signOut(m);
// The errands allowance was paused on camera; the buyer resumes it off camera so the agent can quote again.
allowances.find(a => a.name === 'Weekend errands').status = 'Active';
await signIn(m, 'demo-agent-code');
await openMarket(m, 'Corner Grocer', [['Oat milk 1L', 2], ['Coffee beans 250g', 1]]);
await m.locator('.paypal-verdict').waitFor();
await m.locator('details', { hasText: 'Rule checks' }).locator('summary').click();
await mobileShot('marketplace-quote');
await signOut(m);
await signIn(m, 'demo-merchant-code');
await pill(m, 'Disputes').click();
await m.getByRole('cell', { name: 'WAITING_FOR_SELLER_RESPONSE' }).waitFor();
await mobileShot('disputes-table');
await mobile.close();
await browser.close();
console.log('demo recorded');
