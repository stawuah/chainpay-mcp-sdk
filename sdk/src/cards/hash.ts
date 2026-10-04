/*
 * Domain-separated hashes the program and Axum agree on (contracts.md §1.2).
 * WebCrypto only, so the same code runs in the browser, Node and workers.
 */

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** sha256("chainpay-merchant:v1\n" || UPPER(trim(acceptor_id))). */
export async function merchantIdHash(acceptorId: string): Promise<Uint8Array> {
  const normalized = acceptorId.trim().toUpperCase();
  if (!normalized) throw new Error("merchant acceptor id is required");
  return sha256(utf8(`chainpay-merchant:v1\n${normalized}`));
}

/** sha256("chainpay-auth-id:v1\n" || issuer_u8 || lithic_txn_token_utf8). */
export async function authIdHash(issuer: number, issuerTransactionToken: string): Promise<Uint8Array> {
  if (!Number.isInteger(issuer) || issuer < 0 || issuer > 255) throw new Error("issuer must fit in u8");
  if (!issuerTransactionToken) throw new Error("issuer transaction token is required");
  return sha256(join(utf8("chainpay-auth-id:v1\n"), Uint8Array.of(issuer), utf8(issuerTransactionToken)));
}

/** sha256("chainpay-card-ref:v1\n" || lithic_card_token_utf8 || ref_salt32). */
export async function issuerCardRefHash(issuerCardToken: string, refSalt: Uint8Array): Promise<Uint8Array> {
  if (refSalt.length !== 32) throw new Error("refSalt must be exactly 32 bytes");
  if (!issuerCardToken) throw new Error("issuer card token is required");
  return sha256(join(utf8("chainpay-card-ref:v1\n"), utf8(issuerCardToken), refSalt));
}

/** `cpcap_v1_<base64url(32 random bytes)>` (contracts.md §6). Opaque; carries no card data. */
export const CHECKOUT_CAPABILITY_PATTERN = /^cpcap_v1_[A-Za-z0-9_-]{43}$/;

export function isCheckoutCapability(value: unknown): value is string {
  return typeof value === "string" && CHECKOUT_CAPABILITY_PATTERN.test(value);
}
