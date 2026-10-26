export type Service = { id: string; name: string; unit_price: string; min_documents: number; max_documents: number; delivery: string; requires_requirements: boolean };
export type Unit = { buyer_review?: "accept" | "challenge" | null; revision?: number; index: number; state: "pending" | "processing" | "delivered" | "failed" | "unknown"; name?: string; input_hash: string; output_hash?: string; reason?: string; result?: { model: string; output: { summary: string; facts: { claim: string; evidence: string; document_index?: number }[]; assessment?: { requirements: string; conclusion: string; missing_evidence: string[] } } } };
export type Receipt = { refund_pending?:boolean; legacy_refund_units?:number[]; resolution?: ResolutionEvent[]; revisions?: {revision:number; output_hash?:string; result:unknown;state:string;reason?:string}[][]; refunds?: ResolutionRefund[]; reserved_refunds?:string; confirmed_refunds?:string; funded?: boolean; funding_method?: string; allowance_units?: number; subscription_funding?: {units:number;payment_id:string;period_end:number}; id: string; offer_version?: string; service_name?: string; requirements?: string | null; sandbox: true; currency: "USD"; gross: string; refund: string; net: string | null; captured: boolean; payment_review?: string; refund_confirmed: boolean; units: Unit[]; quote_digest?: string; quote_expires_at?: number; approval_url?: string; order_id?: string; capture_id?: string; refund_id?: string; share_token?: string; order_state?: string; capture_state?: string; refund_state?: string; created_at: number };
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
/** A mutation may have reached the service; retain its original request ID and inputs. */
export class PayPalRequestUncertainError extends Error {}
export function client(origin: string, token: string) {
  return async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path");
    let response: Response;
    try {
      response = await fetch(`${origin}/v1/paypal${path}`, { method, redirect: "error", credentials: "omit", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(100_000)]) : AbortSignal.timeout(100_000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (cause) {
      // A timeout is not a failure: the payment may have gone through. Say so instead of "signal timed out".
      if (method !== "GET" || (cause instanceof Error && cause.name === "TimeoutError")) throw new PayPalRequestUncertainError("No response yet. Keep the original request and check it again; do not create another.");
      throw cause;
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = error.error || `Request unavailable (${response.status}). Keep the original task.`;
      if (method !== "GET" && (response.status >= 500 || response.status === 409)) throw new PayPalRequestUncertainError(message);
      throw new Error(message);
    }
    if (response.status === 204 || response.status === 202) return undefined as T;
    try { return await response.json() as T; }
    catch (cause) {
      if (method !== "GET") throw new PayPalRequestUncertainError("The response could not be read. Keep the original request and check it again; do not create another.");
      throw cause;
    }
  };
}

export type OutputBinding = { unit: number; revision: number; output_hash: string | null };
export type ResolutionEvent = { actor: string; role: string; timestamp: number; intent: { request_id: string; binding: OutputBinding; action: string; reason: string } };
export type ResolutionRefund = { request_id: string; bindings: OutputBinding[]; reason: string; amount: string; digest: string; confirmed: boolean; state?: string | null };
