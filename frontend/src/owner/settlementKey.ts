/**
 * The idempotency key a payment settles under.
 *
 * The browser derives the operation id it polls, and the relay derives the id it
 * stores, from this same string — but from different ends of the request. MCP
 * accepts an invoice hash with an `0x` prefix or in upper case and re-encodes it
 * as bare lower-case hex before the relay ever sees it. A browser that keys its
 * operation on the spelling it happened to send would then poll an id the relay
 * never wrote, and the payment would look stuck forever while having settled.
 *
 * So normalise here exactly as MCP does. A hash that is not 32 bytes of hex is
 * passed through untouched: MCP rejects it, and the failure should read as the
 * invalid hash it is rather than a mismatched key.
 */
export function settlementKey(mandate: string, invoiceHash: string): string {
  return `${mandate}:${normalizeInvoiceHash(invoiceHash)}`;
}

export function normalizeInvoiceHash(invoiceHash: string): string {
  const candidate = invoiceHash.trim().replace(/^0x/i, "");
  return /^[0-9a-fA-F]{64}$/.test(candidate) ? candidate.toLowerCase() : invoiceHash;
}
