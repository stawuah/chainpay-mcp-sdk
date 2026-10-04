// A narrow JSON-RPC relay for the /support page. Browsers can't use Solana's
// public mainnet RPC (it answers 403), and an RPC URL with an API key must never
// ship to the browser, so the page talks to this route instead. It forwards only
// the calls the tip card needs. Nothing here can sign or move funds: the wallet
// signs, and the transaction's contents are fixed by the page before signing.

export const ALLOWED_METHODS = new Set([
  "getBalance",
  "getTokenAccountBalance",
  "getLatestBlockhash",
  "getAccountInfo", // vault ledger + address lookup tables for swaps
  "sendTransaction",
  "getSignatureStatuses",
  "getBlockHeight",
]);

export const MAX_BODY_BYTES = 8_192; // a full signed transaction is ~1.7 KB base64

export type RelayCheck = { ok: true; body: { jsonrpc: "2.0"; id: unknown; method: string; params: unknown[] } } | { ok: false; status: number; message: string };

/** Accepts one JSON-RPC request with an allowed method; rejects batches and junk. */
export function checkRelayRequest(text: string): RelayCheck {
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, status: 413, message: "Request too large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400, message: "One request at a time" };
  const { method, params, id } = parsed as { method?: unknown; params?: unknown; id?: unknown };
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) return { ok: false, status: 403, message: "Method not allowed" };
  if (params !== undefined && !Array.isArray(params)) return { ok: false, status: 400, message: "params must be an array" };
  if (method === "getSignatureStatuses" && Array.isArray(params) && Array.isArray(params[0]) && params[0].length > 10) {
    return { ok: false, status: 400, message: "Too many signatures" };
  }
  return { ok: true, body: { jsonrpc: "2.0", id: id ?? 1, method, params: (params as unknown[] | undefined) ?? [] } };
}
