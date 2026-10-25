export type Service = { id: string; name: string; unit_price: string; min_documents: number; max_documents: number; delivery: string; requires_requirements: boolean };
export type Unit = { buyer_review?: "accept" | "challenge" | null; revision?: number; index: number; state: "pending" | "processing" | "delivered" | "failed" | "unknown"; name?: string; input_hash: string; output_hash?: string; reason?: string; result?: { model: string; output: { summary: string; facts: { claim: string; evidence: string; document_index?: number }[]; assessment?: { requirements: string; conclusion: string; missing_evidence: string[] } } } };
export type Receipt = { purchase?: Purchase | null; dispute?: DisputeMark | null; refund_pending?:boolean; legacy_refund_units?:number[]; resolution?: ResolutionEvent[]; revisions?: {revision:number; output_hash?:string; result:unknown;state:string;reason?:string}[][]; refunds?: ResolutionRefund[]; reserved_refunds?:string; confirmed_refunds?:string; funded?: boolean; funding_method?: string; allowance_units?: number; subscription_funding?: {units:number;payment_id:string;period_end:number}; id: string; offer_version?: string; service_name?: string; requirements?: string | null; sandbox: true; currency: "USD"; gross: string; refund: string; net: string | null; captured: boolean; payment_review?: string; refund_confirmed: boolean; units: Unit[]; quote_digest?: string; quote_expires_at?: number; approval_url?: string; order_id?: string; capture_id?: string; refund_id?: string; share_token?: string; order_state?: string; capture_state?: string; refund_state?: string; created_at: number };
export type Principal = { id: string; workspace: string; role: "buyer" | "merchant" | "agent" };
export type Proposal = { amount: string; digest: string; reason: string };

export function apiOrigin(value: string | undefined): string {
  if (!value) throw new Error("The separate PayPal API origin has not been configured.");
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.hostname.endsWith(".") || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname === "chainpay-relay.vercel.app" || url.hostname === "chainpayai.app" || url.hostname.endsWith(".chainpayai.app")) throw new Error("PayPal requires its own API origin.");
  return url.origin;
}
export function checkoutUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.sandbox.paypal.com" || url.hostname.endsWith(".") || url.username || url.password || url.port) throw new Error("Unexpected PayPal checkout address.");
  return url.href;
}
export function money(value: string | null): string {
  if (value === null) return "Not established";
  if (!/^\d+\.\d{2}$/.test(value)) throw new Error("Invalid USD amount");
  return `$${value}`;
}
export function shownMoney(value: string | null | undefined): string {
  if (value == null || value === "") return "Not established";
  try { return money(value); } catch { return "Not established"; }
}
export function exportReceipt(receipt: Receipt): string {
  const cell = (s: string) => `"${s.replaceAll('"', '""')}"`;
  return ["task_id,currency,gross,captured,confirmed_refund,net_buyer_cost", [receipt.id, receipt.currency, receipt.gross, String(receipt.captured), receipt.refund_confirmed ? receipt.refund : "0.00", receipt.net ?? ""].map(cell).join(",")].join("\r\n");
}
export function client(origin: string, token: string) {
  return async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path");
    let response: Response;
    try {
      response = await fetch(`${origin}/v1/paypal${path}`, { method, redirect: "error", credentials: "omit", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(100_000)]) : AbortSignal.timeout(100_000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (cause) {
      // A timeout is not a failure: the payment may have gone through. Say so instead of "signal timed out".
      if (cause instanceof Error && cause.name === "TimeoutError") throw new Error("No response yet. Keep this task and use Check original payment; do not create another.");
      throw cause;
    }
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `Request unavailable (${response.status}). Keep the original task.`); }
    if (response.status === 204 || response.status === 202) return undefined as T;
    return await response.json() as T;
  };
}

// Allowances, catalog purchases and disputes. Amounts on the wire are integer cents.
export type CatalogItem = { id: string; name: string; price_cents: number; price: string; availability: string };
export type Merchant = { id: string; name: string; kind: string; items: CatalogItem[] };
export type Vault = { source: "paypal" | "card"; status: "none" | "pending_approval" | "ready"; approval_url?: string };
export type Allowance = { id: string; name: string; status: "Active" | "Paused" | "Revoked"; mode: "agent_pays" | "ask_first"; agent: string | null; merchants: string[]; total_cap_cents: number; per_purchase_cap_cents: number; spent_cents: number; remaining_cents: number; purchases_today: number; max_per_day: number; cooldown_seconds: number; last_purchase_at: number | null; expires_at: number; created_at: number; vault?: Vault; sandbox: true };
export type PolicyCheck = { rule: string; limit_cents?: number; observed_cents?: number; allowed?: boolean; observed?: string | number | boolean };
export type Policy = { allowed: boolean; rule?: string; allowance_id?: string; reason_code?: string; checks?: PolicyCheck[] };
export type Quote = { merchant: string; lines: { id: string; name: string; qty: number; unit_cents: number; line_cents: number }[]; amount_cents: number; amount: string; policy?: Policy };
export type Purchase = { merchant: string; buyer?: string; allowance_id?: string; mode?: "agent_pays" | "ask_first"; approval?: "requested" | "approved" | "denied" | null; approval_requested_at?: number; approval_decided_at?: number; approved_by?: string; lines?: { id: string; name: string; qty: number; unit_cents: number }[]; policy?: Policy; refund_request?: { amount: string; digest: string; reason: string; failed_units: number[] } | null };
export type DisputeMark = { id: string; status: string; evidence?: string };
export type Dispute = { id: string; task_id: string; capture_id: string; status: string; stage: string; reason: string; amount_cents: number; amount: string; created_at: number; updated_at: number; seller_response_due?: number | null; evidence: "none" | "submitted" | "unknown"; evidence_submitted_at?: number | null; evidence_digest?: string | null };
export type EvidencePack = { dispute_id: string; task_id: string; capture_id: string; allowance: { id: string; name: string; rule: string; checks: PolicyCheck[] }; approval: { approved_by?: string; approval_decided_at?: number } | null; delivery: { unit: number; state: string; delivered_at?: number }[]; buyer_review: unknown[]; rework: unknown[]; refunds: { id: string; amount: string; confirmed: boolean }[]; receipt_digest: string; public_receipt_url: string | null; notes: string; digest: string };

// "12.5" typed by a person becomes the cents string "1250". Pure string work, no float.
export function centsFromDollars(text: string): string | null {
  const match = /^\s*\$?(\d{1,7})(?:\.(\d{0,2}))?\s*$/.exec(text);
  if (!match) return null;
  const cents = (match[1] + (match[2] ?? "").padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  return cents === "0" ? null : cents;
}
export function dollars(cents: number | string | bigint | null | undefined): string | null {
  if (cents == null || cents === "") return null;
  const whole = BigInt(cents);
  return `${whole / 100n}.${(whole % 100n).toString().padStart(2, "0")}`;
}
// JSON.stringify writes this as a bare integer, so cents never pass through Number.
export function jsonInt(cents: string): unknown {
  return (JSON as unknown as { rawJSON: (s: string) => unknown }).rawJSON(cents);
}

export type OutputBinding = { unit: number; revision: number; output_hash: string | null };
export type ResolutionEvent = { actor: string; role: string; timestamp: number; intent: { request_id: string; binding: OutputBinding; action: string; reason: string } };
export type ResolutionRefund = { request_id: string; bindings: OutputBinding[]; reason: string; amount: string; digest: string; confirmed: boolean; state?: string | null };
