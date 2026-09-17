import { PublicKey } from "@solana/web3.js";
import type { Address, PaymentReceipt } from "./types.js";
import { address } from "./encoding.js";
import { DEFAULT_PROGRAM_ID } from "./constants.js";

export const DELIVERY_STATEMENT = "chainpay.response-served";
export const DELIVERY_VERSION = 1;
export const DELIVERY_CLUSTER = "devnet";

const PAYLOAD_KEYS = [
  "version",
  "statement",
  "cluster",
  "programId",
  "receiptAddress",
  "seller",
  "contentHash",
  "servedAt",
] as const;

const ENVELOPE_KEYS = ["payload", "signature"] as const;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Exact UTF-8 body for the cross-language content-hash fixture.
 * Includes non-ASCII and whitespace that must hash as transmitted bytes.
 */
export const DELIVERY_HASH_FIXTURE_UTF8 = "ChainPay served body: café\n\t ";

/** SHA-256 lowercase hex of {@link DELIVERY_HASH_FIXTURE_UTF8}. */
export const DELIVERY_HASH_FIXTURE_SHA256 =
  "8e60b641218418bde0cde3b190a028e846ccebed8dc804901b8e6f87b9072eee";

/** Test-only seller seed (32 bytes of 0x07). Not a live merchant key. */
export const DELIVERY_FIXTURE_SELLER_SEED = Uint8Array.from({ length: 32 }, () => 7);

export const DELIVERY_FIXTURE_RECEIPT_ADDRESS = "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1";
export const DELIVERY_FIXTURE_SELLER_ADDRESS = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";

/** Exact canonical JSON bytes for cross-language signature fixtures. */
export const DELIVERY_CANONICAL_FIXTURE_JSON =
  '{"version":1,"statement":"chainpay.response-served","cluster":"devnet","programId":"3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4","receiptAddress":"2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1","seller":"GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB","contentHash":"8e60b641218418bde0cde3b190a028e846ccebed8dc804901b8e6f87b9072eee","servedAt":"2026-09-15T04:16:00.000Z"}';

/** Deterministic Ed25519 signature over {@link DELIVERY_CANONICAL_FIXTURE_JSON}. */
export const DELIVERY_CANONICAL_FIXTURE_SIGNATURE =
  "K+hQlY/7U7cbhE2229fk/C2g5MHUahSrhBZz4F3SUxTqyVvLgfV0gZkPosZKdFZzIXbawLS3xJQ3XsrtYXqIDg==";

export type DeliveryAttestationPayload = {
  version: 1;
  statement: typeof DELIVERY_STATEMENT;
  cluster: typeof DELIVERY_CLUSTER;
  programId: Address;
  receiptAddress: Address;
  seller: Address;
  contentHash: string;
  servedAt: string;
};

export type SignedDeliveryAttestation = {
  payload: DeliveryAttestationPayload;
  signature: string;
};

export type TrustedSellerMapping = {
  cluster: typeof DELIVERY_CLUSTER;
  programId: Address;
  /** Seller signing public keys. These are identities, not ATA addresses. */
  sellers: readonly Address[];
  recipientTokenAccount?: Address;
};

export type DeliveryVerification = {
  valid: boolean;
  payload?: DeliveryAttestationPayload;
  reason?: string;
  code?: string;
};

export type VerifyDeliveryOptions = {
  trustedSellers?: TrustedSellerMapping;
  receipt?: Pick<PaymentReceipt, "address" | "recipientTokenAccount">;
  programId?: Address;
  now?: Date;
  maxFutureSkewMs?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function validationError(reason: string, code: string, payload?: DeliveryAttestationPayload): DeliveryVerification {
  return { valid: false, reason, code, ...(payload ? { payload } : {}) };
}

function isCanonicalUtcIso(value: string): boolean {
  if (!CANONICAL_UTC_ISO.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

function ed25519Seed(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length === 32) return new Uint8Array(secretKey);
  if (secretKey.length === 64) return new Uint8Array(secretKey.subarray(0, 32));
  throw new Error("Ed25519 secret key must be 32 or 64 bytes");
}

function pkcs8FromSeed(seed: Uint8Array): ArrayBuffer {
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  return pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength);
}

export function bytesToCanonicalBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function canonicalBase64ToBytes(value: string): Uint8Array {
  if (!CANONICAL_BASE64.test(value) || value.length % 4 !== 0) {
    throw new Error("Delivery signature must be canonical base64");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reject unsupported version and unknown fields before any
 * canonical JSON is produced. This ordering is load-bearing.
 */
export function parseDeliveryPayload(value: unknown): DeliveryAttestationPayload {
  if (!isPlainObject(value)) {
    throw new Error("Delivery payload must be an object");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "version") || value.version !== DELIVERY_VERSION) {
    throw new Error("Unsupported delivery attestation version");
  }
  const extra = unknownKeys(value, PAYLOAD_KEYS);
  if (extra.length > 0) {
    throw new Error(`Unknown delivery attestation field: ${extra[0]}`);
  }
  if (value.statement !== DELIVERY_STATEMENT) {
    throw new Error("Unsupported delivery statement");
  }
  if (value.cluster !== DELIVERY_CLUSTER) {
    throw new Error("Unsupported delivery cluster");
  }
  if (typeof value.contentHash !== "string" || !CONTENT_HASH_PATTERN.test(value.contentHash)) {
    throw new Error("contentHash must be 64-char lowercase SHA-256 hex");
  }
  if (typeof value.servedAt !== "string" || !isCanonicalUtcIso(value.servedAt)) {
    throw new Error("servedAt must be a canonical UTC ISO-8601 timestamp");
  }
  if (typeof value.programId !== "string" || typeof value.receiptAddress !== "string" || typeof value.seller !== "string") {
    throw new Error("programId, receiptAddress, and seller must be Solana addresses");
  }
  return {
    version: 1,
    statement: DELIVERY_STATEMENT,
    cluster: DELIVERY_CLUSTER,
    programId: address(value.programId),
    receiptAddress: address(value.receiptAddress),
    seller: address(value.seller),
    contentHash: value.contentHash,
    servedAt: value.servedAt,
  };
}

export function parseDeliveryEnvelope(value: unknown): SignedDeliveryAttestation {
  if (!isPlainObject(value)) {
    throw new Error("Delivery attestation must be an object");
  }
  const extra = unknownKeys(value, ENVELOPE_KEYS);
  if (extra.length > 0) {
    throw new Error(`Unknown delivery envelope field: ${extra[0]}`);
  }
  if (typeof value.signature !== "string") {
    throw new Error("Delivery signature is required");
  }
  return {
    payload: parseDeliveryPayload(value.payload),
    signature: value.signature,
  };
}

export function canonicalDeliveryPayload(payload: DeliveryAttestationPayload): string {
  const parsed = parseDeliveryPayload(payload);
  return JSON.stringify({
    version: 1,
    statement: DELIVERY_STATEMENT,
    cluster: DELIVERY_CLUSTER,
    programId: parsed.programId,
    receiptAddress: parsed.receiptAddress,
    seller: parsed.seller,
    contentHash: parsed.contentHash,
    servedAt: parsed.servedAt,
  });
}

export async function signDeliveryAttestation(
  payload: unknown,
  secretKey: Uint8Array,
): Promise<SignedDeliveryAttestation> {
  const parsed = parseDeliveryPayload(payload);
  const message = new TextEncoder().encode(canonicalDeliveryPayload(parsed));
  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    pkcs8FromSeed(ed25519Seed(secretKey)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("Ed25519", key, message.slice().buffer as ArrayBuffer),
  );
  return { payload: parsed, signature: bytesToCanonicalBase64(signature) };
}

function trustedSellerAllows(payload: DeliveryAttestationPayload, mapping: TrustedSellerMapping): string | undefined {
  if (mapping.cluster !== payload.cluster) return "Delivery cluster is not trusted";
  if (address(mapping.programId) !== payload.programId) return "Delivery programId is not trusted";
  const allowed = new Set(mapping.sellers.map((seller) => address(seller)));
  if (!allowed.has(payload.seller)) return "Unknown delivery seller";
  return undefined;
}

export async function verifyDeliveryAttestation(
  envelope: unknown,
  options: VerifyDeliveryOptions = {},
): Promise<DeliveryVerification> {
  let parsed: SignedDeliveryAttestation;
  try {
    parsed = parseDeliveryEnvelope(envelope);
  } catch (error) {
    return validationError(error instanceof Error ? error.message : String(error), "invalid_payload");
  }

  try {
    // Fail closed on identity. Without a trusted-seller mapping the only thing
    // left to check is that the payload is signed by the key the payload itself
    // names, which any anonymous poster can satisfy with a throwaway keypair.
    // Every caller in this repo already passes a mapping; this stops the next
    // one from accidentally accepting a self-signed statement.
    if (!options.trustedSellers) {
      return validationError(
        "A trusted seller mapping is required to verify a delivery attestation.",
        "unknown_seller",
        parsed.payload,
      );
    }

    {
      const trustError = trustedSellerAllows(parsed.payload, options.trustedSellers);
      if (trustError) return validationError(trustError, "unknown_seller", parsed.payload);
      if (
        options.trustedSellers.recipientTokenAccount
        && options.receipt
        && address(options.trustedSellers.recipientTokenAccount) !== address(options.receipt.recipientTokenAccount)
      ) {
        return validationError("Trusted seller does not match receipt recipient", "recipient_mismatch", parsed.payload);
      }
    }

    if (options.programId && address(options.programId) !== parsed.payload.programId) {
      return validationError("Delivery programId does not match expected program", "program_mismatch", parsed.payload);
    }
    if (options.receipt && address(options.receipt.address) !== parsed.payload.receiptAddress) {
      return validationError("Delivery receiptAddress does not match the receipt", "receipt_mismatch", parsed.payload);
    }

    const now = options.now ?? new Date();
    const servedAt = Date.parse(parsed.payload.servedAt);
    const maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60_000;
    if (servedAt - now.getTime() > maxFutureSkewMs) {
      return validationError("Delivery servedAt is unreasonably far in the future", "invalid_timestamp", parsed.payload);
    }

    const signature = canonicalBase64ToBytes(parsed.signature);
    if (signature.length !== 64) return validationError("Ed25519 signature must be 64 bytes", "invalid_signature", parsed.payload);

    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      new PublicKey(parsed.payload.seller).toBytes().slice().buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(canonicalDeliveryPayload(parsed.payload));
    const validSignature = await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      signature.slice().buffer as ArrayBuffer,
      message.slice().buffer as ArrayBuffer,
    );
    if (!validSignature) return validationError("Delivery signature is invalid", "invalid_signature", parsed.payload);

    return { valid: true, payload: parsed.payload };
  } catch (error) {
    return validationError(error instanceof Error ? error.message : String(error), "invalid_payload", parsed.payload);
  }
}

export function defaultTrustedSellerMapping(sellers: readonly Address[], programId: Address = DEFAULT_PROGRAM_ID): TrustedSellerMapping {
  return {
    cluster: DELIVERY_CLUSTER,
    programId: address(programId),
    sellers: sellers.map((seller) => address(seller)),
  };
}
