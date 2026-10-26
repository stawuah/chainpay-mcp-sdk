import { dollars, type Allowance, type Dispute, type EvidencePack, type Merchant, type Policy, type PolicyCheck, type Principal, type Quote, type Receipt } from "../../paypal/client";
import type { PaypalApi, PaypalSource } from "./source";

/*
  ILLUSTRATIVE PayPal sandbox data for the design harness and tests. It answers
  the same /v1/paypal paths the real service does, in memory, so the shared
  Allowances / Marketplace / Disputes components run unchanged. Nothing here
  reaches PayPal or moves money.

  Shape: two allowances (one "ask me above $20"), one purchase waiting for
  approval, three purchases (one refunded without replenishing the allowance) and one
  open dispute.
*/

const HOUR = 3600;
const DAY = 86400;

// The four merchants seeded in backend/src/paypal/catalog.rs.
const MERCHANTS: Merchant[] = [
  { id: "grocer", name: "Corner Grocer", kind: "grocery", items: [
    item("oat-milk", "Oat milk 1L", 390, "always"),
    item("coffee-beans", "Coffee beans 250g", 1250, "always"),
    item("sourdough", "Sourdough loaf", 650, "max_per_order:2"),
    item("eggs", "Free-range eggs (12)", 480, "weekdays"),
  ] },
  { id: "box-office", name: "Riverside Box Office", kind: "events", items: [
    item("matinee", "Matinee ticket", 1800, "always"),
    item("evening", "Evening show ticket", 3200, "max_per_order:4"),
    item("programme", "Printed programme", 500, "always"),
  ] },
  { id: "tours", name: "Old Town Tours", kind: "booking", items: [
    item("walking-tour", "Old town walking tour", 2500, "always"),
    item("food-tour", "Street food tour", 4500, "max_per_order:2"),
    item("bike-rental", "Bike rental (half day)", 1500, "weekdays"),
    item("audio-guide", "Audio guide", 600, "always"),
  ] },
  { id: "print-shop", name: "Quickprint", kind: "print", items: [
    item("bw-copies", "B&W copies (100 pages)", 800, "always"),
    item("colour-poster", "Colour poster A2", 1900, "always"),
    item("business-cards", "Business cards (250)", 2400, "max_per_order:2"),
    item("binding", "Spiral binding", 350, "weekdays"),
  ] },
];

function item(id: string, name: string, cents: number, availability: string) {
  return { id, name, price_cents: cents, price: dollars(cents)!, availability };
}

type Line = { id: string; qty: number };

export type PaypalFixtureOptions = {
  wallet: string;
  /** No allowances, purchases or disputes: the first-run view. */
  empty?: boolean;
  /** Every read fails, to check error states. */
  fail?: boolean;
  /** Fixed clock (epoch seconds), so screenshots and tests are stable. */
  now?: number;
};

export function createFixturePaypalSource(options: PaypalFixtureOptions): PaypalSource {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const principal: Principal = { id: `wallet:${options.wallet}`, workspace: `wallet-${options.wallet.slice(0, 6)}`, role: "buyer" };
  const state = options.empty ? emptyState() : seed(now);
  let counter = 0;
  const newId = (prefix: string) => `${prefix}-${(++counter).toString().padStart(4, "0")}${now.toString(36)}`;

  const merchant = (id: string) => MERCHANTS.find((m) => m.id === id);
  function priced(merchantId: string, lines: Line[]) {
    const m = merchant(merchantId);
    if (!m) throw new Error("Unknown merchant");
    const out = lines.map((l) => {
      const found = m.items.find((i) => i.id === l.id);
      if (!found) throw new Error("Unknown item");
      return { id: found.id, name: found.name, qty: l.qty, unit_cents: found.price_cents, line_cents: found.price_cents * l.qty };
    });
    return { lines: out, amount: out.reduce((sum, l) => sum + l.line_cents, 0) };
  }
  function policy(allowanceId: string | undefined, merchantId: string, amount: number): Policy | undefined {
    if (!allowanceId) return undefined;
    const a = state.allowances.find((x) => x.id === allowanceId);
    if (!a) return { allowed: false, rule: "status", reason_code: "allowance_not_active", checks: [] };
    const kind = merchant(merchantId)?.kind ?? "";
    const checks: PolicyCheck[] = [
      { rule: "status", allowed: a.status === "Active", observed: a.status },
      { rule: "expiry", allowed: a.expires_at > now, observed: String(a.expires_at) },
      { rule: "merchant", allowed: a.merchants.includes(merchantId) || (a.categories ?? []).includes(kind), observed: merchantId },
      { rule: "per_purchase_cap", allowed: amount <= a.per_purchase_cap_cents, limit_cents: a.per_purchase_cap_cents, observed_cents: amount },
      { rule: "total_cap", allowed: a.spent_cents + amount <= a.total_cap_cents, limit_cents: a.total_cap_cents, observed_cents: a.spent_cents + amount },
      { rule: "max_per_day", allowed: a.purchases_today < a.max_per_day, observed: `${a.purchases_today} of ${a.max_per_day}` },
      { rule: "vault", allowed: a.vault?.status === "ready", observed: a.vault?.status ?? "none" },
    ];
    const codes: Record<string, string> = { status: "allowance_not_active", expiry: "allowance_expired", merchant: "merchant_not_allowed", per_purchase_cap: "per_purchase_cap", total_cap: "total_cap", max_per_day: "max_per_day", vault: "vault_not_ready" };
    const failed = checks.find((c) => !c.allowed);
    return { allowed: !failed, allowance_id: a.id, rule: failed?.rule, reason_code: failed ? codes[failed.rule] : null, checks };
  }
  function needsApproval(a: Allowance, amount: number) {
    return a.mode === "ask_first" || (a.mode === "ask_above" && amount > (a.ask_above_cents ?? 0));
  }
  function spend(a: Allowance, amount: number) {
    a.spent_cents += amount;
    a.remaining_cents = a.total_cap_cents - a.spent_cents;
    a.purchases_today += 1;
    a.last_purchase_at = now;
  }

  const api: PaypalApi = async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    await Promise.resolve();
    if (options.fail) throw new Error("Fixture: PayPal sandbox unavailable");
    const b = (body ?? {}) as Record<string, unknown>;
    const parts = path.split("?")[0].split("/").filter(Boolean);
    const out = (value: unknown) => structuredClone(value) as T;

    if (method === "GET") {
      if (path === "/session") return out(principal);
      if (path === "/catalog") return out({ merchants: MERCHANTS });
      if (path === "/allowances") return out({ allowances: state.allowances });
      if (path === "/purchases/approvals") return out({ approvals: state.tasks.filter((t) => t.purchase?.approval === "requested") });
      if (path === "/tasks") return out({ tasks: state.tasks });
      if (parts[0] === "tasks" && parts[1]) return out(found(state.tasks.find((t) => t.id === parts[1])));
      if (path === "/disputes") return out({ disputes: state.disputes });
      if (parts[0] === "disputes" && parts[2] === "evidence") return out(evidence(found(state.disputes.find((d) => d.id === parts[1])), state));
    }
    if (method === "POST") {
      if (path === "/allowances") {
        const total = Number(b.total_cap_cents), per = Number(b.per_purchase_cap_cents);
        const created: Allowance = {
          id: newId("al"), name: String(b.name), status: "Active", mode: b.mode as Allowance["mode"],
          ask_above_cents: b.mode === "ask_above" ? Number(b.ask_above_cents) : null,
          categories: Array.isArray(b.categories) ? (b.categories as string[]) : [],
          agent: (b.agent as string | undefined) ?? null, merchants: b.merchants as string[],
          total_cap_cents: total, per_purchase_cap_cents: per, spent_cents: 0, remaining_cents: total,
          purchases_today: 0, max_per_day: Number(b.max_per_day), cooldown_seconds: Number(b.cooldown_seconds),
          last_purchase_at: null, expires_at: Number(b.expires_at), created_at: now,
          // Sandbox stand-in: the PayPal approval step is treated as done.
          vault: { source: (b.vault_source as "paypal" | "card") ?? "paypal", status: "ready" }, sandbox: true,
        };
        state.allowances.unshift(created);
        return out(created);
      }
      if (parts[0] === "allowances" && parts[2] === "status") {
        const a = found(state.allowances.find((x) => x.id === parts[1]));
        if (a.status === "Revoked") throw new Error("A revoked allowance stays revoked.");
        a.status = b.status as Allowance["status"];
        return out(a);
      }
      if (parts[0] === "allowances" && parts[2] === "vault") {
        const a = found(state.allowances.find((x) => x.id === parts[1]));
        a.vault = { source: a.vault?.source ?? "paypal", status: "ready" };
        return out(a);
      }
      if (path === "/purchases/quote") {
        const { lines, amount } = priced(String(b.merchant), b.items as Line[]);
        const quote: Quote = { merchant: String(b.merchant), lines, amount_cents: amount, amount: dollars(amount)!, currency: "USD", sandbox: true, policy: policy(b.allowance_id as string | undefined, String(b.merchant), amount) };
        return out(quote);
      }
      if (path === "/purchases") {
        const { lines, amount } = priced(String(b.merchant), b.items as Line[]);
        const a = found(state.allowances.find((x) => x.id === b.allowance_id));
        const checked = policy(a.id, String(b.merchant), amount)!;
        if (!checked.allowed) throw new Error(`Refused by the allowance rules (${checked.reason_code}).`);
        const ask = needsApproval(a, amount);
        const task = purchaseTask({ id: newId("task"), merchant: String(b.merchant), allowance: a, lines, amount, at: now, approval: ask ? "requested" : null, captured: !ask, policy: checked });
        if (!ask) spend(a, amount);
        state.tasks.unshift(task);
        return out(task);
      }
      if (parts[0] === "purchases" && parts[2] === "approve") {
        const task = found(state.tasks.find((t) => t.id === parts[1]));
        const a = found(state.allowances.find((x) => x.id === task.purchase?.allowance_id));
        const amount = Number(task.gross.replace(".", ""));
        task.purchase = { ...task.purchase!, approval: "approved", approval_decided_at: now, approved_by: principal.id };
        task.captured = true; task.net = task.gross; task.capture_id = `CAP-${task.id.toUpperCase()}`; task.capture_state = "COMPLETED";
        task.units = task.units.map((u) => ({ ...u, state: "processing" }));
        spend(a, amount);
        return out(task);
      }
      if (parts[0] === "purchases" && parts[2] === "deny") {
        const task = found(state.tasks.find((t) => t.id === parts[1]));
        task.purchase = { ...task.purchase!, approval: "denied", approval_decided_at: now, approved_by: principal.id };
        task.net = "0.00";
        task.units = task.units.map((u) => ({ ...u, state: "failed", reason: "Declined by you" }));
        return out(task);
      }
      if (path === "/disputes/sync") return out({});
    }
    throw new Error(`Fixture: no sandbox answer for ${method} ${path}`);
  };

  return {
    mode: "fixture",
    async connect() {
      if (options.fail) throw new Error("Fixture: PayPal sandbox unavailable");
      return { api, principal, wallet: options.wallet, expiresAt: (now + HOUR) * 1000 };
    },
    disconnect() {},
  };
}

function found<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Not found");
  return value;
}

type FixtureState = { allowances: Allowance[]; tasks: Receipt[]; disputes: Dispute[] };

function emptyState(): FixtureState {
  return { allowances: [], tasks: [], disputes: [] };
}

function purchaseTask(input: { id: string; merchant: string; allowance: Allowance; lines: { id: string; name: string; qty: number; unit_cents: number }[]; amount: number; at: number; approval: "requested" | "approved" | null; captured: boolean; policy?: Policy }): Receipt {
  const gross = dollars(input.amount)!;
  return {
    id: input.id, sandbox: true, currency: "USD", gross, refund: "0.00", net: input.captured ? gross : null,
    captured: input.captured, refund_confirmed: false, created_at: input.at, funded: input.captured, funding_method: "allowance",
    service_name: undefined, quote_digest: `sha256:${input.id}`,
    order_id: input.captured ? `ORDER-${input.id.toUpperCase()}` : undefined,
    capture_id: input.captured ? `CAP-${input.id.toUpperCase()}` : undefined,
    capture_state: input.captured ? "COMPLETED" : undefined,
    units: input.lines.map((l, index) => ({ index, name: `${l.qty} × ${l.name}`, state: input.captured ? "delivered" : "pending", input_hash: `sha256:${input.id}:${index}`, price: dollars(l.unit_cents * l.qty) })),
    purchase: {
      merchant: input.merchant, buyer: "wallet", allowance_id: input.allowance.id, mode: input.allowance.mode,
      approval: input.approval, approval_requested_at: input.approval ? input.at : null, approval_decided_at: input.approval === "approved" ? input.at + 90 : null,
      approved_by: input.approval === "approved" ? "you" : null, lines: input.lines.map(({ id, name, qty, unit_cents }) => ({ id, name, qty, unit_cents })), policy: input.policy,
    },
  };
}

function seed(now: number): FixtureState {
  const groceries: Allowance = {
    id: "al-groceries", name: "Weekly groceries", status: "Active", mode: "agent_pays", ask_above_cents: null, categories: ["grocery"],
    agent: "pantry-bot", merchants: ["grocer"], total_cap_cents: 6000, per_purchase_cap_cents: 1500,
    // 20.30 paid plus 11.30 refunded: refunds do not replenish the lifetime cap.
    spent_cents: 3160, remaining_cents: 2840, purchases_today: 1, max_per_day: 3, cooldown_seconds: 60,
    last_purchase_at: now - 2 * HOUR, expires_at: now + 26 * DAY, created_at: now - 4 * DAY, vault: { source: "paypal", status: "ready" }, sandbox: true,
  };
  const outings: Allowance = {
    id: "al-outings", name: "Weekend outings", status: "Active", mode: "ask_above", ask_above_cents: 2000, categories: ["events", "booking"],
    agent: "weekend-planner", merchants: ["box-office", "tours"], total_cap_cents: 15000, per_purchase_cap_cents: 6000,
    spent_cents: 2500, remaining_cents: 12500, purchases_today: 0, max_per_day: 2, cooldown_seconds: 300,
    last_purchase_at: now - 3 * DAY, expires_at: now + 12 * DAY, created_at: now - 6 * DAY, vault: { source: "paypal", status: "ready" }, sandbox: true,
  };
  const line = (merchantId: string, id: string, qty: number) => {
    const found = MERCHANTS.find((m) => m.id === merchantId)!.items.find((i) => i.id === id)!;
    return { id, name: found.name, qty, unit_cents: found.price_cents };
  };
  const total = (lines: { qty: number; unit_cents: number }[]) => lines.reduce((s, l) => s + l.qty * l.unit_cents, 0);

  const pendingLines = [line("box-office", "evening", 1), line("box-office", "programme", 1)];
  const pending = purchaseTask({ id: "task-pending-show", merchant: "box-office", allowance: outings, lines: pendingLines, amount: total(pendingLines), at: now - 12 * 60, approval: "requested", captured: false });

  const groceryLines = [line("grocer", "oat-milk", 2), line("grocer", "coffee-beans", 1)];
  const grocery = purchaseTask({ id: "task-groceries", merchant: "grocer", allowance: groceries, lines: groceryLines, amount: total(groceryLines), at: now - 2 * HOUR, approval: null, captured: true });

  const tourLines = [line("tours", "walking-tour", 1)];
  const tour = purchaseTask({ id: "task-walking-tour", merchant: "tours", allowance: outings, lines: tourLines, amount: total(tourLines), at: now - 3 * DAY, approval: "approved", captured: true });

  const refundedLines = [line("grocer", "sourdough", 1), line("grocer", "eggs", 1)];
  const refunded = purchaseTask({ id: "task-bakery-refund", merchant: "grocer", allowance: groceries, lines: refundedLines, amount: total(refundedLines), at: now - DAY - 5 * HOUR, approval: null, captured: true });
  refunded.refund = refunded.gross;
  refunded.refund_confirmed = true;
  refunded.net = "0.00";
  refunded.refund_id = "REF-BAKERY-01";
  refunded.refund_state = "COMPLETED";
  refunded.units = refunded.units.map((u) => ({ ...u, state: "failed", reason: "Sold out at pickup" }));
  refunded.refunds = [{ request_id: "rr-bakery", bindings: [], reason: "Sold out at pickup", amount: refunded.gross, digest: "sha256:rr-bakery", confirmed: true, state: "COMPLETED" }];

  const dispute: Dispute = {
    id: "PP-D-27183", task_id: tour.id, capture_id: tour.capture_id!, status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount_cents: 2500, amount: "25.00", currency: "USD",
    created_at: now - DAY, updated_at: now - 20 * HOUR, seller_response_due: now + 9 * DAY,
    evidence: "none", evidence_submitted_at: null, evidence_digest: null, sandbox: true,
  };
  tour.dispute = { id: dispute.id, status: dispute.status };

  return { allowances: [groceries, outings], tasks: [pending, grocery, refunded, tour], disputes: [dispute] };
}

function evidence(d: Dispute, state: FixtureState): EvidencePack {
  if (!d.capture_id) throw new Error("Merchant evidence requires the capture record");
  const task = state.tasks.find((t) => t.id === d.task_id);
  const a = state.allowances.find((x) => x.id === task?.purchase?.allowance_id);
  return {
    dispute_id: d.id, task_id: d.task_id, capture_id: d.capture_id,
    allowance: { id: a?.id ?? null, name: a?.name ?? null, rule: null, checks: null },
    approval: task?.purchase?.approval ? { approval: task.purchase.approval, approved_by: task.purchase.approved_by ?? null, approval_requested_at: task.purchase.approval_requested_at ?? null, approval_decided_at: task.purchase.approval_decided_at ?? null } : null,
    delivery: (task?.units ?? []).map((u) => ({ unit: u.index, state: u.state, delivered_at: u.state === "delivered" ? task!.created_at + HOUR : null })),
    buyer_review: [], rework: [], refunds: [], receipt_digest: `sha256:${d.task_id}`, public_receipt_url: null,
    notes: "Illustrative sandbox evidence.", digest: `sha256:${d.id}`,
  };
}
