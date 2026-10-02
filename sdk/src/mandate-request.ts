import { PublicKey } from "@solana/web3.js";
import type { Address, TokenProgram } from "./types.js";
import { address } from "./encoding.js";
import { assetLabel } from "./known-assets.js";

/**
 * A signed ask for a spending permission. A vendor sends one to say "let your
 * agent pay me up to these limits"; a builder sends one to say "fund my agent".
 *
 * The request is a proposal only. It moves no money and creates nothing on
 * chain. The owner reviews it, may change every limit, and signs the mandate in
 * their own wallet. The requester signature proves which key asked; the stated
 * name is not verified by anything.
 */
export type MandateRequestRole = "vendor" | "grantee";

export type MandateRequestPayload = {
  version: 1;
  cluster: "devnet" | "mainnet-beta";
  role: MandateRequestRole;
  /** Ed25519 public key that signs the request. */
  requester: Address;
  /** Stated by the requester, not verified. At most 64 characters. */
  requesterName?: string;
  /** Grantee only: the agent key that will sign payments. */
  agent?: Address;
  mint: Address;
  tokenProgram: TokenProgram;
  /** Vendor only: the expected payee. Not enforced on chain for nonce mandates. */
  recipient?: Address;
  /** Base units, u64. */
  suggestedMaxPerPayment: string;
  /** Base units, u64, at least suggestedMaxPerPayment. */
  suggestedTotal: string;
  decimals: number;
  suggestedExpirySlot?: string;
  /** The slot after which the link should no longer be accepted. */
  validUntilSlot?: string;
  /** At most 280 characters. */
  description: string;
  /** At most 64 characters. */
  poNumber?: string;
  nonce: string;
};

export type SignedMandateRequest = {
  payload: MandateRequestPayload;
  /** Ed25519 signature over the canonical payload, base64url without padding. */
  signature: string;
};

export type MandateRequestVerification = {
  valid: boolean;
  payload: MandateRequestPayload;
  /** Lowercase hex SHA-256 of the canonical payload. Empty when the payload could not be read. */
  requestHash: string;
  reason?: string;
};

export const MANDATE_REQUEST_PATH = "/app/requests/permission";
export const MANDATE_REQUEST_FRAGMENT_KEY = "req";
export const MAX_REQUESTER_NAME_LENGTH = 64;
export const MAX_REQUEST_DESCRIPTION_LENGTH = 280;
export const MAX_PO_NUMBER_LENGTH = 64;
export const MAX_REQUEST_NONCE_LENGTH = 128;
/**
 * Nominal slots per day at 400 ms a slot. Real slot times drift, so durations
 * built from it are estimates and are worded as such.
 */
export const NOMINAL_SLOTS_PER_DAY = 216_000n;

const MAX_U64 = 18_446_744_073_709_551_615n;
const CANONICAL_UINT = /^(0|[1-9]\d*)$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const PAYLOAD_KEYS = [
  "version",
  "cluster",
  "role",
  "requester",
  "requesterName",
  "agent",
  "mint",
  "tokenProgram",
  "recipient",
  "suggestedMaxPerPayment",
  "suggestedTotal",
  "decimals",
  "suggestedExpirySlot",
  "validUntilSlot",
  "description",
  "poNumber",
  "nonce",
] as const;
const ENVELOPE_KEYS = ["payload", "signature"] as const;
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Fixed key order. Optional keys appear only when present. */
function orderedPayload(payload: MandateRequestPayload): MandateRequestPayload {
  return {
    version: payload.version,
    cluster: payload.cluster,
    role: payload.role,
    requester: payload.requester,
    ...(present(payload.requesterName) ? { requesterName: payload.requesterName } : {}),
    ...(present(payload.agent) ? { agent: payload.agent } : {}),
    mint: payload.mint,
    tokenProgram: payload.tokenProgram,
    ...(present(payload.recipient) ? { recipient: payload.recipient } : {}),
    suggestedMaxPerPayment: payload.suggestedMaxPerPayment,
    suggestedTotal: payload.suggestedTotal,
    decimals: payload.decimals,
    ...(present(payload.suggestedExpirySlot) ? { suggestedExpirySlot: payload.suggestedExpirySlot } : {}),
    ...(present(payload.validUntilSlot) ? { validUntilSlot: payload.validUntilSlot } : {}),
    description: payload.description,
    ...(present(payload.poNumber) ? { poNumber: payload.poNumber } : {}),
    nonce: payload.nonce,
  };
}

export function canonicalMandateRequest(payload: MandateRequestPayload): string {
  return JSON.stringify(orderedPayload(payload));
}

function characterCount(value: string): number {
  return [...value].length;
}

function canonicalAddress(value: unknown, name: string): Address {
  if (typeof value !== "string") throw new Error(`${name} must be a Solana address`);
  let parsed: string;
  try {
    parsed = address(value);
  } catch {
    throw new Error(`${name} must be a Solana address`);
  }
  if (parsed !== value) throw new Error(`${name} must be a canonical Solana address`);
  return parsed;
}

function u64String(value: unknown, name: string, positive: boolean): bigint {
  if (typeof value !== "string" || !CANONICAL_UINT.test(value)) {
    throw new Error(`${name} must be an unsigned integer string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error(`${name} must fit in u64`);
  if (positive && parsed === 0n) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function boundedText(value: unknown, name: string, max: number, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  if (value !== value.trim()) throw new Error(`${name} must not start or end with spaces`);
  if (characterCount(value) > max) throw new Error(`${name} must be at most ${max} characters`);
  if (CONTROL_CHARACTER.test(value)) throw new Error(`${name} must not contain control characters`);
}

/**
 * Check every field and every role rule, without the signature or the clock.
 * Throws with a plain reason. Unknown fields are rejected so that nothing a
 * reader sees can sit outside what the requester signed.
 */
export function parseMandateRequestPayload(value: unknown): MandateRequestPayload {
  if (!isPlainObject(value)) throw new Error("Mandate request payload must be an object");
  const extra = Object.keys(value).filter((key) => !(PAYLOAD_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) throw new Error(`Unknown mandate request field: ${extra[0]}`);
  if (value.version !== 1) throw new Error("Unsupported mandate request version");
  if (value.cluster !== "devnet" && value.cluster !== "mainnet-beta") throw new Error("Unsupported Solana cluster");
  if (value.role !== "vendor" && value.role !== "grantee") throw new Error("Role must be vendor or grantee");
  if (value.tokenProgram !== "spl-token" && value.tokenProgram !== "token-2022") {
    throw new Error("Unsupported token program");
  }
  canonicalAddress(value.requester, "requester");
  canonicalAddress(value.mint, "mint");
  if (value.role === "vendor") {
    canonicalAddress(value.recipient, "recipient");
    if (value.agent !== undefined) throw new Error("A vendor request must not name an agent");
  } else {
    canonicalAddress(value.agent, "agent");
    if (value.recipient !== undefined) throw new Error("A budget request must not name a recipient");
  }
  boundedText(value.requesterName, "requesterName", MAX_REQUESTER_NAME_LENGTH, false);
  boundedText(value.description, "description", MAX_REQUEST_DESCRIPTION_LENGTH, true);
  boundedText(value.poNumber, "poNumber", MAX_PO_NUMBER_LENGTH, false);
  boundedText(value.nonce, "nonce", MAX_REQUEST_NONCE_LENGTH, true);
  const perPayment = u64String(value.suggestedMaxPerPayment, "suggestedMaxPerPayment", true);
  const total = u64String(value.suggestedTotal, "suggestedTotal", true);
  if (total < perPayment) throw new Error("suggestedTotal must be at least suggestedMaxPerPayment");
  if (typeof value.decimals !== "number" || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
    throw new Error("decimals must be an integer between 0 and 255");
  }
  if (value.suggestedExpirySlot !== undefined) u64String(value.suggestedExpirySlot, "suggestedExpirySlot", true);
  if (value.validUntilSlot !== undefined) u64String(value.validUntilSlot, "validUntilSlot", true);
  return orderedPayload(value as MandateRequestPayload);
}

export function parseSignedMandateRequest(value: unknown): SignedMandateRequest {
  if (!isPlainObject(value)) throw new Error("Mandate request must be an object");
  const extra = Object.keys(value).filter((key) => !(ENVELOPE_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) throw new Error(`Unknown mandate request envelope field: ${extra[0]}`);
  if (typeof value.signature !== "string") throw new Error("Mandate request signature is required");
  return { payload: parseMandateRequestPayload(value.payload), signature: value.signature };
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) throw new Error("Value must be base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

function invalid(payload: MandateRequestPayload, reason: string, requestHash = ""): MandateRequestVerification {
  return { valid: false, payload, requestHash, reason };
}

/**
 * Verify a signed request. With `currentSlot`, an expired link or a suggested
 * expiry already in the past is refused.
 */
export async function verifyMandateRequest(
  request: SignedMandateRequest | unknown,
  currentSlot?: bigint,
): Promise<MandateRequestVerification> {
  const raw = isPlainObject(request) ? request : {};
  const rawPayload = (isPlainObject(raw.payload) ? raw.payload : {}) as MandateRequestPayload;
  let signed: SignedMandateRequest;
  try {
    signed = parseSignedMandateRequest(request);
  } catch (error) {
    return invalid(rawPayload, error instanceof Error ? error.message : String(error));
  }
  const payload = signed.payload;
  const message = utf8(canonicalMandateRequest(payload));
  const requestHash = await sha256Hex(message);
  try {
    if (currentSlot !== undefined) {
      if (payload.validUntilSlot !== undefined && BigInt(payload.validUntilSlot) <= currentSlot) {
        return invalid(payload, "This request link has expired", requestHash);
      }
      if (payload.suggestedExpirySlot !== undefined && BigInt(payload.suggestedExpirySlot) <= currentSlot) {
        return invalid(payload, "The suggested expiry has already passed", requestHash);
      }
    }
    let signature: Uint8Array;
    try {
      signature = base64UrlToBytes(signed.signature);
    } catch {
      return invalid(payload, "Signature must be base64url", requestHash);
    }
    if (signature.length !== 64) return invalid(payload, "Ed25519 signature must be 64 bytes", requestHash);
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      new PublicKey(payload.requester).toBytes().slice().buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      signature.slice().buffer as ArrayBuffer,
      message.slice().buffer as ArrayBuffer,
    );
    if (!ok) return invalid(payload, "Mandate request signature is invalid", requestHash);
    return { valid: true, payload, requestHash };
  } catch (error) {
    return invalid(payload, error instanceof Error ? error.message : String(error), requestHash);
  }
}

function ed25519Seed(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length === 32) return new Uint8Array(secretKey);
  if (secretKey.length === 64) return new Uint8Array(secretKey.subarray(0, 32));
  throw new Error("Ed25519 secret key must be 32 or 64 bytes");
}

/**
 * Sign a request with the requester key. For the CLI and the demo merchant;
 * the key never leaves the caller. Refuses a key that is not the requester.
 */
export async function signMandateRequest(
  payload: MandateRequestPayload,
  secretKey: Uint8Array,
): Promise<SignedMandateRequest> {
  const parsed = parseMandateRequestPayload(payload);
  const seed = ed25519Seed(secretKey);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  const key = await globalThis.crypto.subtle.importKey("pkcs8", pkcs8.buffer, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", key);
  const signer = new PublicKey(base64UrlToBytes(jwk.x ?? "")).toBase58();
  if (signer !== parsed.requester) throw new Error("Signing key does not match the requester");
  const message = utf8(canonicalMandateRequest(parsed));
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("Ed25519", key, message.slice().buffer as ArrayBuffer),
  );
  return { payload: parsed, signature: bytesToBase64Url(signature) };
}

/** `${appBaseUrl}/app/requests/permission#req=<base64url(JSON)>`. The fragment never reaches a server. */
export function encodeMandateRequestLink(signed: SignedMandateRequest, appBaseUrl: string): string {
  const origin = appBaseUrl.trim().replace(/\/+$/, "");
  if (!origin) throw new Error("App URL is required");
  const body = JSON.stringify({ payload: orderedPayload(signed.payload), signature: signed.signature });
  return `${origin}${MANDATE_REQUEST_PATH}#${MANDATE_REQUEST_FRAGMENT_KEY}=${bytesToBase64Url(utf8(body))}`;
}

/**
 * Read a request from a full link, a `#req=…` fragment, `req=…`, or the bare
 * encoded value. Checks the shape only; call {@link verifyMandateRequest} next.
 */
export function decodeMandateRequestLink(urlOrFragment: string): SignedMandateRequest {
  const value = urlOrFragment.trim();
  const hashIndex = value.indexOf("#");
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : value;
  let encoded = fragment;
  if (fragment.includes("=")) {
    const params = new URLSearchParams(fragment);
    encoded = params.get(MANDATE_REQUEST_FRAGMENT_KEY) ?? "";
  }
  if (!encoded) throw new Error("No mandate request in this link");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded)));
  } catch {
    throw new Error("This mandate request link is damaged");
  }
  return parseSignedMandateRequest(parsed);
}

/** "5" or "5.25" in whole tokens to exact base units, without floating point. */
export function parseHumanTokenAmount(value: string, decimals: number): string {
  const normalized = value.trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("decimals must be an integer between 0 and 255");
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`Not a token amount: ${value}`);
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`This mint allows ${decimals} decimal places`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units > MAX_U64) throw new Error("Amount is too large for a token account");
  return units.toString();
}

/** Exact base units to whole tokens with trailing zeros dropped: "5000000", 6 → "5". */
export function formatHumanTokenAmount(baseUnits: string, decimals: number): string {
  const amount = BigInt(baseUnits);
  if (decimals === 0) return amount.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export type BuildMandateRequestInput = {
  role: MandateRequestRole;
  cluster?: "devnet" | "mainnet-beta";
  requester: Address;
  requesterName?: string;
  agent?: Address;
  mint: Address;
  tokenProgram: TokenProgram;
  recipient?: Address;
  /** Base units. Defaults to the total for a budget request. */
  maxPerPayment?: string;
  /** Base units. */
  total: string;
  decimals: number;
  currentSlot: bigint;
  /** Suggested mandate lifetime in days, from the current slot. */
  days: number;
  /** How long the link stays acceptable. Defaults to 7 days. */
  linkValidDays?: number;
  description: string;
  poNumber?: string;
  nonce?: string;
};

function wholeDays(value: number, name: string): bigint {
  if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error(`${name} must be a whole number of days from 1 to 3650`);
  return BigInt(value);
}

/** Build and check an unsigned payload. Slots come from nominal 400 ms slots. */
export function buildMandateRequestPayload(input: BuildMandateRequestInput): MandateRequestPayload {
  const days = wholeDays(input.days, "days");
  const linkDays = wholeDays(input.linkValidDays ?? 7, "link validity");
  const total = input.total;
  return parseMandateRequestPayload({
    version: 1,
    cluster: input.cluster ?? "devnet",
    role: input.role,
    requester: input.requester,
    ...(input.requesterName ? { requesterName: input.requesterName.trim() } : {}),
    ...(input.role === "grantee" ? { agent: input.agent } : {}),
    mint: input.mint,
    tokenProgram: input.tokenProgram,
    ...(input.role === "vendor" ? { recipient: input.recipient } : {}),
    suggestedMaxPerPayment: input.maxPerPayment ?? total,
    suggestedTotal: total,
    decimals: input.decimals,
    suggestedExpirySlot: (input.currentSlot + days * NOMINAL_SLOTS_PER_DAY).toString(),
    validUntilSlot: (input.currentSlot + linkDays * NOMINAL_SLOTS_PER_DAY).toString(),
    description: input.description.trim(),
    ...(input.poNumber ? { poNumber: input.poNumber.trim() } : {}),
    nonce: input.nonce ?? randomNonce(),
  });
}

function shortKey(value: string): string {
  return value.length < 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function daysFrom(slot: string | undefined, currentSlot: bigint): string | undefined {
  if (slot === undefined) return undefined;
  const remaining = BigInt(slot) - currentSlot;
  if (remaining <= 0n) return "0 days";
  const days = (remaining + NOMINAL_SLOTS_PER_DAY / 2n) / NOMINAL_SLOTS_PER_DAY;
  return days === 1n ? "1 day" : `${days} days`;
}

/**
 * One plain sentence pair for the requester, e.g.
 * "Asks for up to 5 USDC per payment, 50 USDC total, 30 days. Payee 9abc…wxyz. Link valid 7 days."
 */
export function mandateRequestSummary(payload: MandateRequestPayload, currentSlot: bigint): string {
  const symbol = assetLabel(payload.mint);
  const amount = (value: string) => `${formatHumanTokenAmount(value, payload.decimals)} ${symbol}`;
  const terms: string[] = [];
  if (payload.role === "vendor" || payload.suggestedMaxPerPayment !== payload.suggestedTotal) {
    terms.push(`up to ${amount(payload.suggestedMaxPerPayment)} per payment`);
    terms.push(`${amount(payload.suggestedTotal)} total`);
  } else {
    terms.push(`up to ${amount(payload.suggestedTotal)} total`);
  }
  const lifetime = daysFrom(payload.suggestedExpirySlot, currentSlot);
  if (lifetime) terms.push(lifetime);
  const who = payload.role === "vendor"
    ? `Payee ${shortKey(payload.recipient ?? "")}.`
    : `Agent ${shortKey(payload.agent ?? "")} signs the payments.`;
  const link = daysFrom(payload.validUntilSlot, currentSlot);
  return [`Asks for ${terms.join(", ")}.`, who, ...(link ? [`Link valid ${link}.`] : [])].join(" ");
}
