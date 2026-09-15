/**
 * MCP-local x402 challenge parsers.
 *
 * Discriminants match demo-merchant/src/proof.ts: `x402Version === 2` is standard
 * v2; `version === "x402/1.0"` is ChainPay's custom receipt-proof flow. That
 * merchant module verifies proofs. This file parses PAYMENT-REQUIRED / custom
 * challenge envelopes. SDK challenge helpers were not present when this slice
 * landed — import them later if they appear. Header names are not a protocol
 * signal. Never treat a custom receipt proof as a standard sponsored transaction.
 */

import { publicKey } from "@chainpay/sdk";

export const CUSTOM_X402_VERSION = "x402/1.0" as const;
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const CUSTOM_NETWORK = "solana-devnet" as const;
export const CUSTOM_PROTOCOL = "chainpay-custom-x402/1.0" as const;
export const STANDARD_V2_PROTOCOL = "x402-v2" as const;

export const CUSTOM_PROTOCOL_LABEL =
  "ChainPay custom receipt-proof flow (x402/1.0). Proof is a settled signature and receipt PDA, not a standard x402 v2 sponsor countersign.";
export const STANDARD_V2_PROTOCOL_LABEL =
  "Standard x402 v2 exact SVM. Proof is a partially signed transaction for sponsor countersign. ChainPay does not operate a facilitator.";

const MAX_HEADER_CHARS = 16 * 1024;
const MAX_DECODED_CHARS = 16 * 1024;
const MAX_ACCEPTS = 16;
const MAX_RESOURCE_CHARS = 2048;
const MAX_NONCE_CHARS = 128;
const MAX_U64 = 18_446_744_073_709_551_615n;

export type X402ProtocolCode =
  | "malformed"
  | "unsupported_network"
  | "unsupported_scheme"
  | "resource_mismatch"
  | "conflicting_protocols";

export class X402ProtocolError extends Error {
  readonly code: X402ProtocolCode;

  constructor(code: X402ProtocolCode, message: string) {
    super(message);
    this.name = "X402ProtocolError";
    this.code = code;
  }
}

export type CustomChallengeOption = {
  protocol: typeof CUSTOM_PROTOCOL;
  protocolLabel: string;
  proofKind: "settled-receipt-pda";
  network: typeof CUSTOM_NETWORK;
  scheme: "exact";
  mint: string;
  recipient: string;
  amount: string;
  resource: string;
  tokenProgram?: "spl-token" | "token-2022";
  nonce?: string;
  expiresAtSlot?: string;
};

export type StandardV2Option = {
  protocol: typeof STANDARD_V2_PROTOCOL;
  protocolLabel: string;
  proofKind: "partially-signed-sponsored-transaction";
  network: typeof SOLANA_DEVNET_CAIP2;
  scheme: "exact";
  amount: string;
  asset: string;
  merchantOwner: string;
  resource: string;
  maxTimeoutSeconds?: number;
  feePayer?: string;
};

export type DetectedChallenge =
  | { kind: "custom"; option: CustomChallengeOption; envelope: Record<string, unknown> }
  | { kind: "standard-v2"; option: StandardV2Option; envelope: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(code: X402ProtocolCode, message: string): never {
  throw new X402ProtocolError(code, message);
}

export function canonicalU64String(value: unknown, name: string, allowZero = false): string {
  if (typeof value !== "string") {
    fail("malformed", `${name} must be a canonical decimal u64 string`);
  }
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(value)) {
    fail("malformed", `${name} must be a canonical decimal u64 string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64 || parsed.toString() !== value) {
    fail("malformed", `${name} must fit in an unsigned 64-bit integer`);
  }
  return value;
}

function canonicalAddress(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("malformed", `${name} is required`);
  }
  let encoded: string;
  try {
    encoded = publicKey(value).toBase58();
  } catch {
    fail("malformed", `${name} must be a canonical Solana address`);
  }
  if (encoded !== value) fail("malformed", `${name} must be a canonical Solana address`);
  return encoded;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") fail("malformed", `${name} is required`);
  if (value.length > max) fail("malformed", `${name} is too long`);
  return value;
}

export function decodePaymentRequiredWire(value: string): unknown {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HEADER_CHARS) {
    fail("malformed", "x402 payment-required payload is missing or too large");
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (value.length > MAX_DECODED_CHARS) fail("malformed", "x402 payment-required payload is too large");
    return parsed;
  } catch (error) {
    if (error instanceof X402ProtocolError) throw error;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    fail("malformed", "x402 payment-required header is neither JSON nor base64 JSON");
  }
  if (!decoded || decoded.length > MAX_DECODED_CHARS) {
    fail("malformed", "x402 payment-required payload is too large");
  }
  try {
    return JSON.parse(decoded);
  } catch {
    fail("malformed", "x402 payment-required header is neither JSON nor base64 JSON");
  }
}

export function paymentRequiredDocumentsFromResponse(
  headers: { get(name: string): string | null },
  body?: { parsed?: unknown },
): unknown[] {
  const documents: unknown[] = [];
  const seen = new Set<string>();
  for (const name of ["payment-required", "x-payment-required"]) {
    const header = headers.get(name);
    if (!header) continue;
    const document = decodePaymentRequiredWire(header);
    const key = JSON.stringify(document);
    if (!seen.has(key)) {
      seen.add(key);
      documents.push(document);
    }
  }
  if (body && "parsed" in body && body.parsed !== undefined) {
    const key = JSON.stringify(body.parsed);
    if (!seen.has(key)) documents.push(body.parsed);
  }
  return documents;
}

function resourceBinding(value: string, expectedResource?: string): string {
  const resource = boundedString(value, "resource", MAX_RESOURCE_CHARS);
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    fail("malformed", "resource must be an absolute URL");
  }
  if (url.username || url.password) {
    fail("malformed", "x402 resource URLs must not contain credentials");
  }
  const normalized = url.toString();
  if (expectedResource && normalized !== expectedResource && resource !== expectedResource) {
    fail("resource_mismatch", "x402 challenge resource does not match the requested resource URL");
  }
  return resource;
}

function customAmount(option: Record<string, unknown>): string {
  const amount = option.amount;
  const maxAmountRequired = option.maxAmountRequired;
  if (amount !== undefined && maxAmountRequired !== undefined && amount !== maxAmountRequired) {
    fail("malformed", "custom x402 amount and maxAmountRequired must be identical canonical strings");
  }
  return canonicalU64String(amount ?? maxAmountRequired, "amount");
}

function parseCustomOption(option: Record<string, unknown>, expectedResource?: string): CustomChallengeOption {
  if (option.scheme !== "exact") fail("unsupported_scheme", "Only the x402 exact scheme is enabled");
  if (option.network !== CUSTOM_NETWORK) {
    fail("unsupported_network", "Custom ChainPay x402/1.0 requires network solana-devnet");
  }
  const mintValue = option.asset ?? option.mint;
  if (option.asset !== undefined && option.mint !== undefined && option.asset !== option.mint) {
    fail("malformed", "custom x402 asset and mint must match");
  }
  const payTo = option.payTo ?? option.recipient;
  if (option.payTo !== undefined && option.recipient !== undefined && option.payTo !== option.recipient) {
    fail("malformed", "custom x402 payTo and recipient must match");
  }
  const resource = resourceBinding(
    typeof option.resource === "string" ? option.resource : "",
    expectedResource,
  );
  const parsed: CustomChallengeOption = {
    protocol: CUSTOM_PROTOCOL,
    protocolLabel: CUSTOM_PROTOCOL_LABEL,
    proofKind: "settled-receipt-pda",
    network: CUSTOM_NETWORK,
    scheme: "exact",
    mint: canonicalAddress(mintValue, "asset"),
    recipient: canonicalAddress(payTo, "payTo"),
    amount: customAmount(option),
    resource,
  };
  if (option.tokenProgram !== undefined) {
    if (option.tokenProgram !== "spl-token" && option.tokenProgram !== "token-2022") {
      fail("malformed", "tokenProgram must be spl-token or token-2022");
    }
    parsed.tokenProgram = option.tokenProgram;
  }
  if (option.nonce !== undefined) {
    parsed.nonce = boundedString(option.nonce, "nonce", MAX_NONCE_CHARS).trim();
  }
  if (option.expiresAtSlot !== undefined) {
    parsed.expiresAtSlot = canonicalU64String(option.expiresAtSlot, "expiresAtSlot", true);
  }
  return parsed;
}

function v2Resource(envelope: Record<string, unknown>, option: Record<string, unknown>, expectedResource?: string): string {
  const envelopeUrl = isRecord(envelope.resource) && typeof envelope.resource.url === "string"
    ? envelope.resource.url
    : undefined;
  const optionUrl = typeof option.resource === "string" ? option.resource : undefined;
  if (envelopeUrl && optionUrl && envelopeUrl !== optionUrl) {
    fail("resource_mismatch", "x402 v2 resource.url does not match the selected requirement resource");
  }
  const resource = envelopeUrl ?? optionUrl;
  if (!resource) fail("malformed", "standard x402 v2 resource.url is required");
  return resourceBinding(resource, expectedResource);
}

function parseV2Option(
  option: Record<string, unknown>,
  resource: string,
): StandardV2Option {
  if (option.scheme !== "exact") fail("unsupported_scheme", "Only the x402 exact scheme is enabled");
  if (option.network !== SOLANA_DEVNET_CAIP2) {
    fail("unsupported_network", `Standard x402 v2 Solana Devnet must use CAIP-2 ${SOLANA_DEVNET_CAIP2}`);
  }
  if (option.maxAmountRequired !== undefined && option.amount !== undefined && option.maxAmountRequired !== option.amount) {
    fail("malformed", "standard x402 v2 amount fields must be identical canonical strings");
  }
  if (option.amount === undefined) fail("malformed", "standard x402 v2 amount is required");
  const extra = option.extra === undefined ? undefined : option.extra;
  if (extra !== undefined && !isRecord(extra)) fail("malformed", "standard x402 v2 extra must be an object");
  const parsed: StandardV2Option = {
    protocol: STANDARD_V2_PROTOCOL,
    protocolLabel: STANDARD_V2_PROTOCOL_LABEL,
    proofKind: "partially-signed-sponsored-transaction",
    network: SOLANA_DEVNET_CAIP2,
    scheme: "exact",
    amount: canonicalU64String(option.amount, "amount"),
    asset: canonicalAddress(option.asset, "asset"),
    merchantOwner: canonicalAddress(option.payTo, "payTo"),
    resource,
  };
  if (option.maxTimeoutSeconds !== undefined) {
    if (typeof option.maxTimeoutSeconds !== "number" || !Number.isInteger(option.maxTimeoutSeconds)
      || option.maxTimeoutSeconds < 1 || option.maxTimeoutSeconds > 86_400) {
      fail("malformed", "maxTimeoutSeconds must be an integer between 1 and 86400");
    }
    parsed.maxTimeoutSeconds = option.maxTimeoutSeconds;
  }
  if (extra && extra.feePayer !== undefined) {
    parsed.feePayer = canonicalAddress(extra.feePayer, "extra.feePayer");
  }
  return parsed;
}

function acceptRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACCEPTS) {
    fail("malformed", "x402 accepts must be a bounded non-empty array");
  }
  if (!value.every(isRecord)) fail("malformed", "x402 accepts entries must be objects");
  return value;
}

function selectCustomAccept(accepts: Record<string, unknown>[]): Record<string, unknown> {
  const selected = accepts.find((option) => option.network === CUSTOM_NETWORK && option.scheme === "exact");
  if (selected) return selected;
  if (accepts.some((option) => option.scheme === "exact" && typeof option.network === "string")) {
    fail("unsupported_network", "Custom ChainPay x402/1.0 requires network solana-devnet");
  }
  fail("malformed", "x402/1.0 response has no Solana Devnet exact payment option");
}

function selectV2Accept(accepts: Record<string, unknown>[]): Record<string, unknown> {
  const selected = accepts.find((option) => option.network === SOLANA_DEVNET_CAIP2 && option.scheme === "exact");
  if (selected) return selected;
  if (accepts.some((option) => typeof option.network === "string")) {
    fail("unsupported_network", `Standard x402 v2 Solana Devnet must use CAIP-2 ${SOLANA_DEVNET_CAIP2}`);
  }
  fail("malformed", "standard x402 v2 response has no Solana Devnet exact payment option");
}

function parseCustomEnvelope(value: Record<string, unknown>, expectedResource?: string): DetectedChallenge {
  const option = Array.isArray(value.accepts)
    ? selectCustomAccept(acceptRecords(value.accepts))
    : value;
  return { kind: "custom", option: parseCustomOption(option, expectedResource), envelope: value };
}

function parseV2Envelope(value: Record<string, unknown>, expectedResource?: string): DetectedChallenge {
  const option = Array.isArray(value.accepts)
    ? selectV2Accept(acceptRecords(value.accepts))
    : isRecord(value.accepted)
      ? value.accepted
      : value;
  const resource = v2Resource(value, option, expectedResource);
  return { kind: "standard-v2", option: parseV2Option(option, resource), envelope: value };
}

function parseBareOption(value: Record<string, unknown>, expectedResource?: string): DetectedChallenge {
  if (value.network === SOLANA_DEVNET_CAIP2) {
    return parseV2Envelope(value, expectedResource);
  }
  if (value.network === CUSTOM_NETWORK) {
    return parseCustomEnvelope(value, expectedResource);
  }
  if (typeof value.network === "string") {
    fail("unsupported_network", "Unsupported x402 network");
  }
  fail("malformed", "x402 challenge is missing an explicit protocol version or network");
}

export function parsePaymentRequiredDocument(value: unknown, expectedResource?: string): DetectedChallenge {
  if (!isRecord(value)) fail("malformed", "x402 payment requirements must be an object");
  if (value.x402Version === 2 && value.version === CUSTOM_X402_VERSION) {
    fail("malformed", "x402 document must not mix x402Version 2 with custom x402/1.0");
  }
  if (value.paymentRequired !== undefined) {
    return parsePaymentRequiredDocument(value.paymentRequired, expectedResource);
  }
  if (value.x402Version === 2) return parseV2Envelope(value, expectedResource);
  if (value.version === CUSTOM_X402_VERSION) return parseCustomEnvelope(value, expectedResource);
  if (value.x402Version !== undefined) fail("malformed", "unsupported x402Version");
  if (value.version !== undefined) fail("malformed", "unsupported x402 version");
  return parseBareOption(value, expectedResource);
}

export function detectAndParsePaymentRequired(documents: unknown[], expectedResource?: string): DetectedChallenge {
  if (documents.length === 0) {
    fail("malformed", "HTTP 402 response did not include payment requirements");
  }
  const parsed: DetectedChallenge[] = [];
  const errors: X402ProtocolError[] = [];
  for (const document of documents) {
    try {
      parsed.push(parsePaymentRequiredDocument(document, expectedResource));
    } catch (error) {
      if (error instanceof X402ProtocolError) errors.push(error);
      else throw error;
    }
  }
  if (parsed.length === 0) {
    throw errors[0] ?? new X402ProtocolError("malformed", "HTTP 402 response did not include payment requirements");
  }
  const kinds = new Set(parsed.map((item) => item.kind));
  if (kinds.size > 1) {
    fail("conflicting_protocols", "PAYMENT-REQUIRED sources disagree on custom vs standard v2");
  }
  return parsed[0];
}

export function parsePaymentRequiredFromResponse(
  headers: { get(name: string): string | null },
  body: { parsed?: unknown },
  expectedResource?: string,
): DetectedChallenge {
  return detectAndParsePaymentRequired(paymentRequiredDocumentsFromResponse(headers, body), expectedResource);
}

export function customReceiptProofDocument(signature: string, receiptPDA: string) {
  return {
    version: CUSTOM_X402_VERSION,
    scheme: "exact" as const,
    network: CUSTOM_NETWORK,
    payload: { signature, receiptPDA },
  };
}

export function unsupportedSponsorResult(option: StandardV2Option) {
  return {
    action: "x402_unsupported_sponsor" as const,
    mode: "unsupported-sponsor" as const,
    protocol: option.protocol,
    protocolLabel: option.protocolLabel,
    proofKind: option.proofKind,
    network: option.network,
    scheme: option.scheme,
    amount: option.amount,
    asset: option.asset,
    merchantOwner: option.merchantOwner,
    resource: option.resource,
    sponsorAvailable: false,
    message:
      "Standard x402 v2 exact SVM requires a sponsor or facilitator to countersign a partially signed transaction. ChainPay's custom x402/1.0 flow uses a settled receipt-PDA proof and a one-signer approved-agent fee payer. This challenge is recognized but unavailable until a reviewed sponsor accepts ChainPay CPI.",
  };
}
