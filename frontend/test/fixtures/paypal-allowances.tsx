// Browser fixture for allowances, marketplace and disputes. The whole API is mocked in this page,
// so it opens with no backend: /test/fixtures/paypal-allowances.html?role=buyer|agent|merchant
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

const catalog = [
  { id: "grocer", name: "Northside Grocer", kind: "grocer", items: [
    { id: "oat-milk", name: "Oat milk 1L", price_cents: 390, availability: "always" },
    { id: "eggs", name: "Free-range eggs, dozen", price_cents: 620, availability: "always" },
    { id: "coffee", name: "Coffee beans 500g", price_cents: 1450, availability: "always" },
    { id: "cake", name: "Birthday cake", price_cents: 2800, availability: "max_per_order:1" },
  ] },
  { id: "box-office", name: "Riverside Box Office", kind: "box office", items: [
    { id: "saturday-ticket", name: "Saturday show ticket", price_cents: 2400, availability: "max_per_order:4" },
    { id: "matinee", name: "Sunday matinee ticket", price_cents: 1800, availability: "max_per_order:4" },
  ] },
  { id: "tours", name: "Old Town Tours", kind: "tours", items: [
    { id: "walking-tour", name: "Walking tour, 2h", price_cents: 3500, availability: "weekdays" },
    { id: "boat", name: "Canal boat, 1h", price_cents: 5200, availability: "always" },
  ] },
  { id: "print-shop", name: "Corner Print Shop", kind: "print shop", items: [
    { id: "poster-a2", name: "A2 poster print", price_cents: 1200, availability: "always" },
    { id: "business-cards", name: "Business cards, 100", price_cents: 2900, availability: "always" },
  ] },
].map(m => ({ ...m, items: m.items.map(i => ({ ...i, price: money(i.price_cents) })) }));

type Allowance = { id: string; name: string; status: string; mode: string; agent: string | null; merchants: string[]; total_cap_cents: number; per_purchase_cap_cents: number; spent_cents: number; purchases_today: number; max_per_day: number; cooldown_seconds: number; last_purchase_at: number | null; expires_at: number; created_at: number; vault: { source: string; status: string; approval_url?: string } };
const allowances: Allowance[] = [
  { id: "al-groceries", name: "Weekly groceries", status: "Active", mode: "agent_pays", agent: null, merchants: ["grocer", "tours"], total_cap_cents: 2000, per_purchase_cap_cents: 800, spent_cents: 390, purchases_today: 1, max_per_day: 3, cooldown_seconds: 60, last_purchase_at: now - 3600, expires_at: now + 30 * 86400, created_at: now - 86400, vault: { source: "paypal", status: "ready" } },
  { id: "al-tickets", name: "Show tickets", status: "Paused", mode: "ask_first", agent: "shopper-bot", merchants: ["box-office"], total_cap_cents: 10000, per_purchase_cap_cents: 5000, spent_cents: 0, purchases_today: 0, max_per_day: 1, cooldown_seconds: 0, last_purchase_at: null, expires_at: now + 7 * 86400, created_at: now - 7200, vault: { source: "paypal", status: "pending_approval", approval_url: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=fixture" } },
];

type Task = Record<string, unknown> & { id: string; units: { index: number; state: string; name: string; input_hash: string; output_hash?: string; reason?: string; price: string }[]; purchase: Record<string, unknown> & { approval?: string | null; refund_request?: unknown }; gross: string; captured: boolean; capture_id?: string; refund_state?: string; refund_confirmed: boolean; refund: string; net: string | null; dispute: { id: string; status: string; evidence: string } | null };
const tasks: Task[] = [
  purchaseTask("t-captured-oatmilk-000000000000", "al-groceries", "grocer", [{ id: "oat-milk", qty: 1 }], { allowed: true, approval: null, captured: true }),
  purchaseTask("t-waiting-tickets-0000000000000", "al-tickets", "box-office", [{ id: "saturday-ticket", qty: 2 }], { allowed: true, approval: "requested", captured: false }),
];
tasks[0].dispute = { id: "PP-D-FIXTURE-1", status: "WAITING_FOR_SELLER_RESPONSE", evidence: "none" };
const disputes = [{ id: "PP-D-FIXTURE-1", task_id: tasks[0].id, capture_id: "CAP-FIXTURE-1", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount_cents: 390, amount: "3.90", created_at: now - 1800, updated_at: now - 1800, seller_response_due: now + 5 * 86400, evidence: "none", evidence_submitted_at: null, evidence_digest: null }];
const evidencePack = () => ({ dispute_id: "PP-D-FIXTURE-1", task_id: tasks[0].id, capture_id: "CAP-FIXTURE-1", allowance: { id: "al-groceries", name: "Weekly groceries", rule: "allowance-rules-v1", checks: [{ rule: "per_purchase_cap", limit_cents: 800, observed_cents: 390, allowed: true }, { rule: "total_cap", limit_cents: 2000, observed_cents: 390, allowed: true }] }, approval: null, delivery: tasks[0].units.map(u => ({ unit: u.index, state: u.state, delivered_at: u.state === "delivered" ? now - 1000 : undefined })), buyer_review: [], rework: [], refunds: [], receipt_digest: "sha256:receipt-fixture", public_receipt_url: null, notes: "The buyer set an allowance of $20.00 with an $8.00 per-purchase cap for Northside Grocer. The agent bought 1 x Oat milk 1L for $3.90 inside those rules. The merchant recorded delivery.", digest: "pack-digest-fixture" });

function money(cents: number): string { return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`; }
function lineFor(merchant: string, items: { id: string; qty: number }[]) {
  const m = catalog.find(c => c.id === merchant);
  return items.map(i => { const item = m?.items.find(x => x.id === i.id); return { id: i.id, name: item?.name ?? i.id, qty: i.qty, unit_cents: item?.price_cents ?? 0, line_cents: (item?.price_cents ?? 0) * i.qty }; });
}
function check(a: Allowance | undefined, merchant: string, amount: number, agent: string | null) {
  const checks = [];
  let reason_code: string | undefined;
  if (!a) return { allowed: false, rule: "allowance-rules-v1", reason_code: "allowance_not_active", checks };
  if (a.status !== "Active") reason_code ??= "allowance_not_active";
  if (a.expires_at < now) reason_code ??= "allowance_expired";
  if (a.agent && agent && a.agent !== agent) reason_code ??= "agent_not_allowed";
  checks.push({ rule: "merchant_allowed", observed: merchant, allowed: a.merchants.includes(merchant) });
  if (!a.merchants.includes(merchant)) reason_code ??= "merchant_not_allowed";
  checks.push({ rule: "per_purchase_cap", limit_cents: a.per_purchase_cap_cents, observed_cents: amount, allowed: amount <= a.per_purchase_cap_cents });
  if (amount > a.per_purchase_cap_cents) reason_code ??= "per_purchase_cap";
  checks.push({ rule: "total_cap", limit_cents: a.total_cap_cents, observed_cents: a.spent_cents + amount, allowed: a.spent_cents + amount <= a.total_cap_cents });
  if (a.spent_cents + amount > a.total_cap_cents) reason_code ??= "total_cap";
  checks.push({ rule: "max_per_day", observed: a.purchases_today + 1, allowed: a.purchases_today < a.max_per_day });
  if (a.purchases_today >= a.max_per_day) reason_code ??= "max_per_day";
  if (a.vault.status !== "ready" && !reason_code) reason_code = "vault_not_ready";
  return { allowed: !reason_code, rule: "allowance-rules-v1", allowance_id: a.id, reason_code, checks };
}
function purchaseTask(id: string, allowance_id: string, merchant: string, items: { id: string; qty: number }[], state: { allowed: boolean; approval: string | null; captured: boolean; reason_code?: string; checks?: unknown[] }): Task {
  const lines = lineFor(merchant, items);
  const a = allowances.find(x => x.id === allowance_id);
  const gross = lines.reduce((sum, l) => sum + l.line_cents, 0);
  const units = lines.flatMap(l => Array.from({ length: l.qty }, () => ({ name: l.name, price: money(l.unit_cents) }))).map((u, index) => ({ index, state: state.captured ? "pending" : "pending", input_hash: `sha256:${id}-${index}`, ...u }));
  return {
    id, sandbox: true, currency: "USD", gross: money(gross), refund: "0.00", net: state.captured ? money(gross) : null, captured: state.captured, capture_id: state.captured ? "CAP-FIXTURE-1" : undefined, order_id: state.captured ? "ORD-FIXTURE-1" : undefined,
    funded: state.captured, funding_method: state.captured ? "paypal_vault" : undefined, refund_confirmed: false, units, quote_digest: `digest-${id}`, quote_expires_at: now + 86400, created_at: now - 600, service_name: "Catalog purchase", offer_version: "catalog-v1", dispute: null,
    purchase: { merchant, buyer: "buyer-one", allowance_id, mode: a?.mode ?? "agent_pays", approval: state.approval, approval_requested_at: state.approval ? now - 600 : undefined, lines: lines.map(({ line_cents: _unused, ...l }) => l), policy: { allowed: state.allowed, rule: "allowance-rules-v1", allowance_id, reason_code: state.reason_code, checks: state.checks ?? check(a, merchant, gross, null).checks }, refund_request: null },
  };
}
function view(a: Allowance) {
  const { vault, ...rest } = a;
  const base = { ...rest, remaining_cents: a.total_cap_cents - a.spent_cents, sandbox: true };
  return role === "buyer" ? { ...base, vault } : base;
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
    const visible = role === "agent" ? allowances.filter(a => a.status === "Active" && (!a.agent || a.agent === principal.id)) : allowances;
    return [200, { allowances: visible.map(view) }];
  }
  if (path === "/allowances" && method === "POST") {
    if (role !== "buyer") return [403, { error: "Only the buyer creates allowances" }];
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
    const a = allowances.find(x => x.id === b.allowance_id);
    return [200, { merchant: b.merchant, lines, amount_cents: amount, amount: money(amount), policy: b.allowance_id ? check(a, String(b.merchant), amount, role === "agent" ? principal.id : null) : undefined }];
  }
  if (path === "/purchases" && method === "POST") {
    const existing = tasks.find(t => t.request_id === b.request_id);
    if (existing) return [200, existing];
    const items = b.items as { id: string; qty: number }[];
    const a = allowances.find(x => x.id === b.allowance_id);
    const amount = lineFor(String(b.merchant), items).reduce((sum, l) => sum + l.line_cents, 0);
    const policy = check(a, String(b.merchant), amount, role === "agent" ? principal.id : null);
    const askFirst = a?.mode === "ask_first";
    const task = purchaseTask(`t-${String(tasks.length + 1).padStart(29, "0")}`, String(b.allowance_id), String(b.merchant), items, { allowed: policy.allowed, approval: policy.allowed && askFirst ? "requested" : null, captured: policy.allowed && !askFirst, reason_code: policy.reason_code, checks: policy.checks });
    task.request_id = b.request_id;
    if (policy.allowed && a) { a.spent_cents += amount; a.purchases_today += 1; a.last_purchase_at = now; }
    tasks.unshift(task);
    return [200, task];
  }
  if (path === "/purchases/approvals") return [200, { approvals: tasks.filter(t => t.purchase.approval === "requested") }];
  if (seg[0] === "purchases" && seg[2] === "approve") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such purchase" }];
    if (b.digest !== t.quote_digest) return [409, { error: "Digest does not match the quote" }];
    t.purchase.approval = "approved"; t.purchase.approved_by = "buyer-one"; t.purchase.approval_decided_at = now;
    t.captured = true; t.funded = true; t.capture_id = "CAP-FIXTURE-2"; t.order_id = "ORD-FIXTURE-2"; t.net = t.gross; t.funding_method = "paypal_vault";
    return [200, t];
  }
  if (seg[0] === "purchases" && seg[2] === "deny") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such purchase" }];
    t.purchase.approval = "denied"; t.purchase.approval_decided_at = now;
    return [200, t];
  }
  if (seg[0] === "tasks" && seg[2] === "fulfil") {
    const t = tasks.find(x => x.id === seg[1]);
    if (!t) return [404, { error: "No such task" }];
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
    const amount = money(failed.reduce((sum, i) => sum + Number(t.units[i].price.replace(".", "")), 0));
    t.purchase.refund_request = { amount, digest: `refund-${t.id}`, reason: b.reason, failed_units: failed };
    return [200, { amount, digest: `refund-${t.id}`, failed_units: failed, requires_merchant_approval: true }];
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
