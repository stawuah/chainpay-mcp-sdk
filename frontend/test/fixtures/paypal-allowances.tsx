// Browser fixture for allowances, marketplace and disputes. The whole API is mocked in this page,
// so it opens with no backend: /test/fixtures/paypal-allowances.html?role=buyer|agent|merchant
// Shapes and the seed catalog mirror backend/src/paypal/{catalog,allowance,disputes,observations}.rs.
// Every request is recorded on window.__paypalCalls for the browser tests. Not payment evidence.
import { createRoot } from "react-dom/client";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import App from "../../src/paypal/App";
import "../../src/paypal/paypal.css";
import "../../src/paypal/paypal-two.css";

const ORIGIN = "http://127.0.0.1:8081";
const query = new URLSearchParams(location.search);
const role = (["buyer", "agent", "merchant"].includes(query.get("role") ?? "") ? query.get("role") : "buyer") as "buyer" | "agent" | "merchant";
const principal = { id: role === "agent" ? "shopper-bot" : role === "buyer" ? "buyer-one" : "merchant-one", workspace: "fixture", role };
const now = Math.floor(Date.now() / 1000);

// Same ids, names, prices and availability as catalog::merchants() on the backend.
const catalog = [
  { id: "grocer", name: "Corner Grocer", kind: "grocery", items: [
    { id: "oat-milk", name: "Oat milk 1L", price_cents: 390, availability: "always" },
    { id: "coffee-beans", name: "Coffee beans 250g", price_cents: 1250, availability: "always" },
    { id: "sourdough", name: "Sourdough loaf", price_cents: 650, availability: "max_per_order:2" },
    { id: "eggs", name: "Free-range eggs (12)", price_cents: 480, availability: "weekdays" },
  ] },
  { id: "box-office", name: "Riverside Box Office", kind: "events", items: [
    { id: "matinee", name: "Matinee ticket", price_cents: 1800, availability: "always" },
    { id: "evening", name: "Evening show ticket", price_cents: 3200, availability: "max_per_order:4" },
    { id: "programme", name: "Printed programme", price_cents: 500, availability: "always" },
  ] },
  { id: "tours", name: "Old Town Tours", kind: "booking", items: [
    { id: "walking-tour", name: "Old town walking tour", price_cents: 2500, availability: "always" },
    { id: "food-tour", name: "Street food tour", price_cents: 4500, availability: "max_per_order:2" },
    { id: "bike-rental", name: "Bike rental (half day)", price_cents: 1500, availability: "weekdays" },
    { id: "audio-guide", name: "Audio guide", price_cents: 600, availability: "always" },
  ] },
  { id: "print-shop", name: "Quickprint", kind: "print", items: [
    { id: "bw-copies", name: "B&W copies (100 pages)", price_cents: 800, availability: "always" },
    { id: "colour-poster", name: "Colour poster A2", price_cents: 1900, availability: "always" },
    { id: "business-cards", name: "Business cards (250)", price_cents: 2400, availability: "max_per_order:2" },
    { id: "binding", name: "Spiral binding", price_cents: 350, availability: "weekdays" },
  ] },
].map(m => ({ ...m, items: m.items.map(i => ({ ...i, price: money(i.price_cents) })) }));
const merchantName = (id: string) => catalog.find(m => m.id === id)?.name ?? null;

type Allowance = { id: string; name: string; status: string; mode: string; agent: string | null; merchants: string[]; total_cap_cents: number; per_purchase_cap_cents: number; spent_cents: number; purchases_today: number; max_per_day: number; cooldown_seconds: number; last_purchase_at: number | null; expires_at: number; created_at: number; vault: { source: string; status: string; approval_url?: string } };
const allowances: Allowance[] = [
  { id: "al-groceries", name: "Weekly groceries", status: "Active", mode: "agent_pays", agent: null, merchants: ["grocer", "tours"], total_cap_cents: 2000, per_purchase_cap_cents: 800, spent_cents: 390, purchases_today: 1, max_per_day: 3, cooldown_seconds: 60, last_purchase_at: now - 3600, expires_at: now + 30 * 86400, created_at: now - 86400, vault: { source: "paypal", status: "ready" } },
  { id: "al-tickets", name: "Show tickets", status: "Paused", mode: "ask_first", agent: "shopper-bot", merchants: ["box-office"], total_cap_cents: 10000, per_purchase_cap_cents: 5000, spent_cents: 0, purchases_today: 0, max_per_day: 1, cooldown_seconds: 0, last_purchase_at: null, expires_at: now + 7 * 86400, created_at: now - 7200, vault: { source: "paypal", status: "pending_approval", approval_url: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=fixture" } },
];

type Check = { rule: string; limit_cents?: number; observed_cents?: number; allowed: boolean; observed: string };
type Policy = { allowed: boolean; rule: string; allowance_id: string; reason_code: string | null; checks: Check[] };
type Task = Record<string, unknown> & { id: string; units: { index: number; state: string; name: string; input_hash: string; output_hash?: string; reason?: string; price: string }[]; purchase: Record<string, unknown> & { approval?: string | null; policy: Policy; refund_request?: unknown }; gross: string; captured: boolean; capture_id?: string; refund_state?: string; refund_confirmed: boolean; refund: string; net: string | null; dispute: { id: string; status: string; evidence: string } | null };
const tasks: Task[] = [
  purchaseTask("t-captured-oatmilk-000000000000", "al-groceries", "grocer", [{ id: "oat-milk", qty: 1 }], { approval: null, captured: true }),
  purchaseTask("t-waiting-tickets-0000000000000", "al-tickets", "box-office", [{ id: "matinee", qty: 2 }], { approval: "requested", captured: false }),
];
tasks[0].dispute = { id: "PP-D-FIXTURE-1", status: "WAITING_FOR_SELLER_RESPONSE", evidence: "none" };
const disputes = [{ id: "PP-D-FIXTURE-1", task_id: tasks[0].id, capture_id: "CAP-FIXTURE-1", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount_cents: 390, amount: "3.90", currency: "USD", created_at: now - 1800, updated_at: now - 1800, seller_response_due: now + 5 * 86400, evidence: "none", evidence_submitted_at: null as number | null, evidence_digest: null as string | null, sandbox: true }];
const evidencePack = () => ({ dispute_id: "PP-D-FIXTURE-1", task_id: tasks[0].id, capture_id: "CAP-FIXTURE-1", allowance: { id: "al-groceries", name: "Weekly groceries", rule: "allowance-rules-v1", checks: tasks[0].purchase.policy.checks }, approval: null, delivery: tasks[0].units.map(u => ({ unit: u.index, state: u.state, delivered_at: u.state === "delivered" ? now - 1000 : null })), buyer_review: [], rework: [], refunds: [], receipt_digest: "sha256:receipt-fixture", public_receipt_url: null, notes: `Purchase ${tasks[0].id} for 3.90 USD was authorised under buyer allowance "Weekly groceries" (allowance-rules-v1) and captured as CAP-FIXTURE-1. The buyer pre-approved purchases of this kind without a per-purchase review. Of 1 units, 0 were marked delivered and 0 failed by the merchant. No refund has been issued.`, digest: "pack-digest-fixture" });

function money(cents: number): string { return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`; }
function lineFor(merchant: string, items: { id: string; qty: number }[]) {
  const m = catalog.find(c => c.id === merchant);
  return items.map(i => { const item = m?.items.find(x => x.id === i.id); return { id: i.id, name: item?.name ?? i.id, qty: i.qty, unit_cents: item?.price_cents ?? 0, line_cents: (item?.price_cents ?? 0) * i.qty }; });
}
// Same nine rows in the same order as allowance::check(); the first failing one names the reason code.
function check(a: Allowance, merchant: string, amount: number, actor: { id: string; role: string }): Policy {
  const agentOk = actor.role === "agent" ? !a.agent || a.agent === actor.id : actor.role === "buyer";
  const since = a.last_purchase_at === null ? null : now - a.last_purchase_at;
  const rows: [string, string, boolean, string, number?, number?][] = [
    ["status", "allowance_not_active", a.status === "Active", a.status],
    ["expiry", "allowance_expired", a.expires_at > now, String(a.expires_at)],
    ["agent", "agent_not_allowed", agentOk, actor.id],
    ["merchant", "merchant_not_allowed", a.merchants.includes(merchant), merchant],
    ["per_purchase_cap", "per_purchase_cap", amount <= a.per_purchase_cap_cents, money(amount), a.per_purchase_cap_cents, amount],
    ["total_cap", "total_cap", a.spent_cents + amount <= a.total_cap_cents, `${money(a.spent_cents)} spent`, a.total_cap_cents, a.spent_cents + amount],
    ["max_per_day", "max_per_day", a.purchases_today < a.max_per_day, `${a.purchases_today} of ${a.max_per_day} today`],
    ["cooldown", "cooldown", since === null || since >= a.cooldown_seconds, since === null ? "no purchases yet" : `${since}s since last purchase`],
    ["vault", "vault_not_ready", a.vault.status === "ready", a.vault.status],
  ];
  let reason_code: string | null = null;
  const checks: Check[] = rows.map(([rule, code, allowed, observed, limit_cents, observed_cents]) => {
    if (!allowed && reason_code === null) reason_code = code;
    return { rule, ...(limit_cents === undefined ? {} : { limit_cents, observed_cents }), allowed, observed };
  });
  return { allowed: reason_code === null, rule: "allowance-rules-v1", allowance_id: a.id, reason_code, checks };
}
function purchaseTask(id: string, allowance_id: string, merchant: string, items: { id: string; qty: number }[], state: { approval: string | null; captured: boolean; policy?: Policy }): Task {
  const lines = lineFor(merchant, items);
  const a = allowances.find(x => x.id === allowance_id)!;
  const gross = lines.reduce((sum, l) => sum + l.line_cents, 0);
  const units = lines.flatMap(l => Array.from({ length: l.qty }, () => ({ name: l.name, price: money(l.unit_cents) }))).map((u, index) => ({ index, state: "pending", input_hash: `sha256:${id}-${index}`, ...u }));
  // Seeded tasks passed their rules when they were made, whatever the allowance looks like now.
  const policy = state.policy ?? check({ ...a, status: "Active", spent_cents: 0, purchases_today: 0, vault: { source: a.vault.source, status: "ready" } }, merchant, gross, { id: "buyer-one", role: "buyer" });
  return {
    id, sandbox: true, currency: "USD", gross: money(gross), refund: "0.00", net: state.captured ? money(gross) : null, captured: state.captured, capture_id: state.captured ? "CAP-FIXTURE-1" : undefined, order_id: state.captured ? "ORD-FIXTURE-1" : undefined,
    funded: state.captured, funding_method: "paypal_vault", refund_confirmed: false, units, quote_digest: `digest-${id}`, quote_expires_at: now + 1800, created_at: now - 600, service_name: merchantName(merchant), offer_version: "catalog-v1", dispute: null,
    purchase: { merchant, buyer: "buyer-one", allowance_id, mode: a.mode, approval: state.approval, approval_requested_at: state.approval ? now - 600 : null, approval_decided_at: null, approved_by: null, lines: lines.map(({ line_cents: _unused, ...l }) => l), policy, refund_request: null },
  };
}
// allowance_view(): vault only for the owning buyer, approval_url only while the vault is not ready.
function view(a: Allowance) {
  const { vault, ...rest } = a;
  const base = { ...rest, remaining_cents: a.total_cap_cents - a.spent_cents, sandbox: true };
  if (role !== "buyer") return base;
  return { ...base, vault: vault.status === "ready" ? { source: vault.source, status: vault.status } : { source: vault.source, status: vault.status, approval_url: vault.approval_url ?? null } };
}

const calls: { method: string; path: string; body: unknown }[] = [];
(window as unknown as { __paypalCalls: unknown[] }).__paypalCalls = calls;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${ORIGIN}/v1/paypal`)) return realFetch(input, init);
  const method = init?.method ?? "GET";
  const path = new URL(url).pathname.replace("/v1/paypal", "");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path, body });
  const [status, result] = handle(method, path, body);
  return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
};

function handle(method: string, path: string, body: Record<string, unknown> | undefined): [number, unknown] {
  const seg = path.split("/").filter(Boolean);
  const b = body ?? {};
  if (path === "/session") return [200, principal];
  if (path === "/offers") return [200, { offers: [] }];
  if (path === "/subscriptions/terms") return [200, { terms: "fixture", plan_id: "P-FIXTURE", enabled: false, policy: "", price: "40.00", units: 10 }];
  if (path === "/subscriptions") return [200, { subscriptions: [] }];
  if (path === "/tasks") return [200, { tasks }];
  if (path === "/catalog") return [200, { merchants: catalog }];
  if (path === "/allowances" && method === "GET") {
    if (query.get("empty") === "1") return [200, { allowances: [] }];
    const visible = role === "merchant" ? [] : role === "agent" ? allowances.filter(a => a.status === "Active" && (!a.agent || a.agent === principal.id)) : allowances;
    return [200, { allowances: visible.map(view) }];
  }
  if (path === "/allowances" && method === "POST") {
    if (role !== "buyer") return [403, { error: "Only the buyer creates allowances" }];
    if (query.get("paused") === "1") return [422, { error: "Allowances and catalog purchases are paused" }];
    const id = `al-${String(allowances.length + 1).padStart(3, "0")}`;
    const paypal = b.vault_source !== "card";
    const a: Allowance = { id, name: String(b.name), status: "Active", mode: String(b.mode), agent: (b.agent as string) ?? null, merchants: b.merchants as string[], total_cap_cents: Number(b.total_cap_cents), per_purchase_cap_cents: Number(b.per_purchase_cap_cents), spent_cents: 0, purchases_today: 0, max_per_day: Number(b.max_per_day), cooldown_seconds: Number(b.cooldown_seconds), last_purchase_at: null, expires_at: Number(b.expires_at), created_at: now, vault: paypal ? { source: "paypal", status: "pending_approval", approval_url: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${id}` } : { source: "card", status: "ready" } };
    allowances.unshift(a);
    return [200, view(a)];
  }
  if (seg[0] === "allowances" && seg[2] === "vault") {
    const a = allowances.find(x => x.id === seg[1]);
    if (!a) return [404, { error: "No such allowance" }];
    a.vault = { source: a.vault.source, status: "ready" };
    return [200, view(a)];
  }
  if (seg[0] === "allowances" && seg[2] === "status") {
    const a = allowances.find(x => x.id === seg[1]);
    if (!a) return [404, { error: "No such allowance" }];
    if (a.status === "Revoked") return [409, { error: "Revoked allowances stay revoked" }];
    a.status = String(b.status);
    return [200, view(a)];
  }
  if (seg[0] === "allowances" && seg.length === 2) {
    const a = allowances.find(x => x.id === seg[1]);
    return a ? [200, view(a)] : [404, { error: "No such allowance" }];
  }
  if (path === "/purchases/quote") {
    const lines = lineFor(String(b.merchant), b.items as { id: string; qty: number }[]);
    const amount = lines.reduce((sum, l) => sum + l.line_cents, 0);
    const quote: Record<string, unknown> = { merchant: b.merchant, lines, amount_cents: amount, amount: money(amount), currency: "USD", sandbox: true };
    if (b.allowance_id) {
      const a = allowances.find(x => x.id === b.allowance_id);
      if (!a) return [404, { error: "Not found" }];
      quote.policy = check(a, String(b.merchant), amount, principal);
    }
    return [200, quote];
  }
  if (path === "/purchases" && method === "POST") {
    if (query.get("paused") === "1") return [422, { error: "Allowances and catalog purchases are paused" }];
    const existing = tasks.find(t => t.request_id === b.request_id);
    if (existing) return [200, existing];
    const items = b.items as { id: string; qty: number }[];
    const a = allowances.find(x => x.id === b.allowance_id);
    if (!a) return [404, { error: "Not found" }];
    // Same rule as the server: the caller must say which mode it expects.
    if (b.mode !== a.mode) return [422, { error: `Allowance mode is ${a.mode}, not ${String(b.mode)}` }];
    const amount = lineFor(String(b.merchant), items).reduce((sum, l) => sum + l.line_cents, 0);
    const policy = check(a, String(b.merchant), amount, principal);
    const askFirst = a.mode === "ask_first";
    const task = purchaseTask(`t-${String(tasks.length + 1).padStart(29, "0")}`, a.id, String(b.merchant), items, { approval: policy.allowed && askFirst ? "requested" : null, captured: policy.allowed && !askFirst, policy });
    task.request_id = b.request_id;
    if (policy.allowed) { a.spent_cents += amount; a.purchases_today += 1; a.last_purchase_at = now; }
    tasks.unshift(task);
    return [200, task];
  }
  if (path === "/purchases/approvals") return [200, { approvals: tasks.filter(t => t.purchase.approval === "requested") }];
  if (seg[0] === "purchases" && seg[2] === "approve") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such purchase" }];
    if (b.digest !== t.quote_digest) return [409, { error: "Digest does not match the quote" }];
    // Rules run again at approval time; a failing re-check denies the request on the rules' behalf.
    const a = allowances.find(x => x.id === t.purchase.allowance_id)!;
    const policy = check({ ...a, status: query.get("recheck") === "fail" ? "Paused" : "Active", vault: { source: a.vault.source, status: "ready" } }, String(t.purchase.merchant), Number(t.gross.replace(".", "")), principal);
    t.purchase.policy = policy;
    t.purchase.approval_decided_at = now;
    if (!policy.allowed) { t.purchase.approval = "denied"; t.purchase.approved_by = "rules"; return [200, t]; }
    t.purchase.approval = "approved"; t.purchase.approved_by = "buyer-one";
    t.captured = true; t.funded = true; t.capture_id = "CAP-FIXTURE-2"; t.order_id = "ORD-FIXTURE-2"; t.net = t.gross;
    return [200, t];
  }
  if (seg[0] === "purchases" && seg[2] === "deny") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such purchase" }];
    t.purchase.approval = "denied"; t.purchase.approval_decided_at = now; t.purchase.approved_by = "buyer-one";
    t.purchase.policy = { ...t.purchase.policy, allowed: false, reason_code: "denied", checks: [...t.purchase.policy.checks, { rule: "buyer_decision", allowed: false, observed: String(b.reason) }] };
    return [200, t];
  }
  if (seg[0] === "tasks" && seg[2] === "fulfil") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such task" }];
    if (!t.captured) return [422, { error: "A verified capture is required before fulfilment" }];
    for (const o of b.outcomes as { unit: number; state: string; reason?: string }[]) {
      const u = t.units[o.unit];
      if (u && u.state === "pending") { u.state = o.state; u.output_hash = `sha256:out-${o.unit}`; u.reason = o.reason; }
    }
    return [200, t];
  }
  if (seg[0] === "tasks" && seg[2] === "refund-request") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such task" }];
    const failed = t.units.filter(u => u.state === "failed").map(u => u.index);
    const amount_cents = failed.reduce((sum, i) => sum + Number(t.units[i].price.replace(".", "")), 0);
    const amount = money(amount_cents);
    t.purchase.refund_request = { reason: b.reason, amount, amount_cents, digest: `refund-${t.id}`, failed_units: failed, requested_by: principal.id, requested_at: now };
    return [200, { amount, amount_cents, currency: "USD", digest: `refund-${t.id}`, failed_units: failed, capture_id: t.capture_id ?? null, requires_merchant_approval: true }];
  }
  if (seg[0] === "tasks" && seg[2] === "refund") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such task" }];
    const r = t.purchase.refund_request as { amount: string } | null;
    t.refund_confirmed = true; t.refund = r?.amount ?? "0.00"; t.refund_id = "REF-FIXTURE-1"; t.refund_state = "observed";
    return [200, t];
  }
  if (seg[0] === "tasks" && seg.length >= 2) {
    const t = tasks.find(x => x.id === seg[1]);
    return t ? [200, t] : [404, { error: "No such task" }];
  }
  if (path === "/disputes" || path === "/disputes/sync") return role === "merchant" ? [200, { disputes }] : [403, { error: "Merchant only" }];
  if (seg[0] === "disputes" && seg[2] === "evidence" && method === "GET") return [200, evidencePack()];
  if (seg[0] === "disputes" && seg[2] === "evidence" && method === "POST") {
    const d = disputes.find(x => x.id === seg[1]);
    if (!d) return [404, { error: "No such dispute" }];
    if (b.digest !== "pack-digest-fixture") return [409, { error: "Digest does not match the preview" }];
    if (d.evidence !== "none") return [409, { error: "Evidence was already submitted" }];
    d.evidence = "submitted"; d.evidence_submitted_at = now; d.evidence_digest = "pack-digest-fixture";
    tasks[0].dispute = { id: d.id, status: d.status, evidence: "submitted" };
    return [200, d];
  }
  return [404, { error: `Fixture has no route for ${method} ${path}` }];
}

sessionStorage.setItem("chainpay.paypal.session.v1", `fixture-${role}`);
createRoot(document.getElementById("root")!).render(<ChainPayTheme><App origin={ORIGIN} /></ChainPayTheme>);
