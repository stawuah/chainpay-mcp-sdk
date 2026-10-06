import { CROSSMINT_STAGING_BASE_URL, crossmintOrderUrl, parseCrossmintOrder } from "@chainpayhq/sdk";

export function requireCrossmintEnabled() {
  if (process.env.CHAINPAY_CROSSMINT_ENABLED !== "true") throw new Error("Crossmint checkout is disabled pending provider acceptance. Nothing was submitted.");
}

/** Fixed staging origin; credentials and complete provider payloads never leave this server. */
export async function fetchCrossmintOrder(orderId: string, payer?: string) {
  requireCrossmintEnabled();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) throw new Error("Invalid Crossmint order ID");
  const key = process.env.CROSSMINT_API_KEY;
  if (!key) throw new Error("Crossmint staging credentials are not configured");
  const response = await fetch(crossmintOrderUrl(CROSSMINT_STAGING_BASE_URL, orderId), {
    method: payer ? "PATCH" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "X-API-KEY": key, ...(payer ? { "Content-Type": "application/json" } : {}) },
    ...(payer ? { body: JSON.stringify({ payment: { method: "solana", currency: "usdc", payerAddress: payer } }) } : {}),
  });
  if (!response.ok) throw new Error(`Crossmint order request failed (${response.status}); no payment was submitted`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Crossmint returned an empty response");
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 128_000) throw new Error("Crossmint order response exceeds the limit"); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid Crossmint order response"); }
  const order = parseCrossmintOrder(value);
  if (order.orderId !== orderId) throw new Error("Crossmint returned a different order ID");
  return order;
}
