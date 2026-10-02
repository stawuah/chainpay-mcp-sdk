import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants.js";
import type { Address, TokenProgram } from "./types.js";

export const CROSSMINT_CONNECTOR = "crossmint-checkout/1.0" as const;
export const CROSSMINT_CONNECTOR_LABEL =
  "Crossmint checkout order settled through a ChainPay mandate. Proof is the settled signature and receipt PDA; Crossmint order state is read back from its Orders API.";
export const CROSSMINT_STAGING_BASE_URL = "https://staging.crossmint.com";
export const CROSSMINT_PRODUCTION_BASE_URL = "https://www.crossmint.com";
export const CROSSMINT_ORDERS_PATH = "/api/2022-06-09/orders";

/** Crossmint advances an order through these phases; only `payment` still owes money. */
export const CROSSMINT_PAYABLE_PHASE = "payment" as const;
export const CROSSMINT_SETTLED_PHASES = ["delivery", "completed"] as const;

const MAX_ORDER_ID_CHARS = 128;
const MAX_SERIALIZED_TRANSACTION_CHARS = 16 * 1024;
const MAX_LINE_ITEM_LOCATORS = 32;
const MAX_LOCATOR_CHARS = 256;
const MAX_U64 = 18_446_744_073_709_551_615n;
const SPL_TRANSFER_TAG = 3;
const SPL_TRANSFER_CHECKED_TAG = 12;

export type CrossmintOrderErrorCode =
  | "malformed"
  | "order_not_payable"
  | "terms_unavailable"
  | "terms_mismatch"
  | "unsupported_token_program";

export class CrossmintOrderError extends Error {
  readonly code: CrossmintOrderErrorCode;

  constructor(code: CrossmintOrderErrorCode, message: string) {
    super(message);
    this.name = "CrossmintOrderError";
    this.code = code;
  }
}

/**
 * The fields ChainPay reads from a Crossmint order. Everything except the order
 * id, the phase, and the payment preparation is optional: a field Crossmint
 * renames or drops must not stop a payment whose terms come from the
 * transaction Crossmint itself prepared.
 */
export type CrossmintOrderSummary = {
  orderId: string;
  phase: string;
  paymentStatus?: string;
  paymentMethod?: string;
  currency?: string;
  quotedTotal?: { amount: string; currency?: string };
  lineItemLocators: string[];
  serializedTransaction?: string;
  payerAddress?: string;
  preparationChain?: string;
  quoteExpiresAt?: string;
  quoteStatus?: string;
};

export type CrossmintQuoteCheck = "match" | "mismatch" | "unavailable";

export type CrossmintPaymentTerms = {
  connector: typeof CROSSMINT_CONNECTOR;
  connectorLabel: string;
  orderId: string;
  phase: string;
  mint: Address;
  recipient: Address;
  amount: string;
  decimals?: number;
  tokenProgram: TokenProgram;
  /**
   * Crossmint's own prepared transfer is the only authority on what is owed.
   * ChainPay reads it and never submits it: settlement goes through
   * `execute_payment` so the mandate and the receipt still apply.
   */
  termsSource: "serialized-transaction";
  quoteCheck: CrossmintQuoteCheck;
  quotedTotal?: { amount: string; currency?: string };
  lineItemLocators: string[];
  payerAddress?: string;
  crossmintSourceTokenAccount?: Address;
};

export type CrossmintTransferTerms = {
  mint: Address;
  recipient: Address;
  source: Address;
  amount: string;
  decimals?: number;
  tokenProgram: TokenProgram;
};

export type CrossmintPaymentReferences = {
  invoiceHash: string;
  paymentId: string;
  signatureReference: string;
};

function fail(code: CrossmintOrderErrorCode, message: string): never {
  throw new CrossmintOrderError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return undefined;
  return trimmed;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") fail("malformed", `${name} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail("malformed", `${name} is too long`);
  return trimmed;
}

function canonicalAddress(value: PublicKey, name: string): Address {
  const encoded = value.toBase58();
  if (encoded === PublicKey.default.toBase58()) fail("malformed", `${name} must not be the default address`);
  return encoded;
}

function tokenProgramFrom(programId: Address): TokenProgram {
  if (programId === SPL_TOKEN_PROGRAM_ID) return "spl-token";
  if (programId === TOKEN_2022_PROGRAM_ID) return "token-2022";
  fail(
    "unsupported_token_program",
    `Crossmint prepared a transfer on ${programId}, which is neither SPL Token nor Token-2022`,
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value).slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Scale a decimal display amount to base units without floating point.
 * Returns undefined when the string is not a plain decimal number, because a
 * quote ChainPay cannot read must be reported as unchecked, never as agreeing.
 */
export function scaleDecimalString(value: string, decimals: number): bigint | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 20) return undefined;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    // More precision than the mint can hold: only a trailing-zero tail is safe
    // to drop, anything else would silently round the merchant's price.
    if (!/^0*$/.test(fraction.slice(decimals))) return undefined;
  }
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

function lineItemLocators(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const locators: string[] = [];
  for (const item of value.slice(0, MAX_LINE_ITEM_LOCATORS)) {
    const record = optionalRecord(item);
    if (!record) continue;
    const locator =
      optionalString(record.tokenLocator, MAX_LOCATOR_CHARS) ??
      optionalString(record.collectionLocator, MAX_LOCATOR_CHARS);
    if (locator) locators.push(locator);
  }
  return locators;
}

function quotedTotal(order: Record<string, unknown>): { amount: string; currency?: string } | undefined {
  const total = optionalRecord(optionalRecord(order.quote)?.totalPrice);
  if (!total) return undefined;
  const amount = optionalString(total.amount, 64);
  if (!amount) return undefined;
  return { amount, ...(optionalString(total.currency, 32) ? { currency: optionalString(total.currency, 32)! } : {}) };
}

/**
 * Read a Crossmint create-order or get-order response. Accepts the documented
 * `{ order }` envelope and a bare order object, because the same order shape is
 * returned by both endpoints.
 */
export function parseCrossmintOrder(value: unknown): CrossmintOrderSummary {
  const envelope = optionalRecord(value);
  if (!envelope) fail("malformed", "Crossmint order must be a JSON object");
  const order = optionalRecord(envelope.order) ?? envelope;
  const orderId = boundedString(order.orderId ?? order.id, "Crossmint orderId", MAX_ORDER_ID_CHARS);
  const phase = boundedString(order.phase, "Crossmint order phase", 64);
  const payment = optionalRecord(order.payment);
  const preparation = optionalRecord(payment?.preparation);
  const serializedTransaction = optionalString(
    preparation?.serializedTransaction,
    MAX_SERIALIZED_TRANSACTION_CHARS,
  );
  const currency = optionalString(payment?.currency, 32);
  const payerAddress = optionalString(preparation?.payerAddress, 64);
  const total = quotedTotal(order);
  return {
    orderId,
    phase,
    lineItemLocators: lineItemLocators(order.lineItems),
    ...(optionalString(payment?.status, 64) ? { paymentStatus: optionalString(payment?.status, 64)! } : {}),
    ...(optionalString(payment?.method, 64) ? { paymentMethod: optionalString(payment?.method, 64)! } : {}),
    ...(currency ? { currency } : {}),
    ...(total ? { quotedTotal: total } : {}),
    ...(serializedTransaction ? { serializedTransaction } : {}),
    ...(payerAddress ? { payerAddress } : {}),
    preparationChain: optionalString(preparation?.chain, 64),
    quoteExpiresAt: optionalString(optionalRecord(order.quote)?.expiresAt, 64),
    quoteStatus: optionalString(optionalRecord(order.quote)?.status, 32),
  };
}

type NormalizedInstruction = {
  programIdIndex: number;
  accountKeyIndexes: number[];
  data: Uint8Array;
};

function normalizedInstructions(message: unknown): NormalizedInstruction[] {
  const candidate = message as {
    compiledInstructions?: Array<{
      programIdIndex: number;
      accountKeyIndexes: readonly number[];
      data: Uint8Array;
    }>;
  };
  if (!Array.isArray(candidate.compiledInstructions)) {
    fail("terms_unavailable", "Crossmint transaction message could not be decoded into instructions");
  }
  return candidate.compiledInstructions.map((item) => ({
    programIdIndex: item.programIdIndex,
    accountKeyIndexes: [...item.accountKeyIndexes],
    data: item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data),
  }));
}

function accountKeyResolver(message: unknown): (index: number) => PublicKey {
  const candidate = message as {
    getAccountKeys?: (args?: unknown) => { get(index: number): PublicKey | undefined };
    addressTableLookups?: unknown[];
    staticAccountKeys?: PublicKey[];
  };
  if (Array.isArray(candidate.addressTableLookups) && candidate.addressTableLookups.length > 0) {
    fail(
      "terms_unavailable",
      "Crossmint transaction resolves accounts through address lookup tables, so its transfer terms cannot be read offline",
    );
  }
  const keys = candidate.staticAccountKeys;
  if (!Array.isArray(keys) || keys.length === 0) {
    fail("terms_unavailable", "Crossmint transaction message has no static account keys");
  }
  return (index: number) => {
    const key = keys[index];
    if (!key) fail("terms_unavailable", "Crossmint transaction references an account index it does not define");
    return key;
  };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value: string): Uint8Array | undefined {
  const bytes: number[] = [];
  for (const char of value) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) return undefined;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function base64Decode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Crossmint documents its Solana `serializedTransaction` as base58 and parses
 * it as a legacy transaction. Base64 is still accepted because a payload that
 * decodes as a valid transaction under either encoding is unambiguous, and
 * fixtures and other tooling commonly use base64.
 */
function deserializeCrossmintTransaction(wire: string): VersionedTransaction {
  let lastError: unknown;
  for (const decode of [base58Decode, base64Decode]) {
    const bytes = decode(wire);
    if (!bytes || bytes.length === 0) continue;
    try {
      return VersionedTransaction.deserialize(bytes);
    } catch (error) {
      lastError = error;
    }
  }
  fail(
    "malformed",
    lastError === undefined
      ? "Crossmint serializedTransaction is neither base58 nor base64"
      : `Crossmint serializedTransaction is not a Solana transaction: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Derive what a Crossmint order actually charges from the transaction Crossmint
 * prepared for its own payer. Exactly one SPL Token or Token-2022 transfer must
 * be present: an order that moves money in more than one transfer has no single
 * set of terms a mandate can be checked against.
 */
export function decodeCrossmintTransferTerms(
  serializedTransaction: string,
  expected: { mint?: Address; tokenProgram?: TokenProgram; strict?: boolean } = {},
): CrossmintTransferTerms {
  const wire = serializedTransaction.trim();
  if (wire === "" || wire.length > MAX_SERIALIZED_TRANSACTION_CHARS) {
    fail("malformed", "Crossmint serializedTransaction is missing or too large");
  }
  const transaction = deserializeCrossmintTransaction(wire);
  const message = transaction.message;
  const keyAt = accountKeyResolver(message);
  const transfers: CrossmintTransferTerms[] = [];
  for (const compiled of normalizedInstructions(message)) {
    let programId: Address;
    try {
      programId = keyAt(compiled.programIdIndex).toBase58();
    } catch (error) {
      if (error instanceof CrossmintOrderError) throw error;
      continue;
    }
    if (programId !== SPL_TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) {
      if (expected.strict) fail("terms_unavailable", "Crossmint preparation requires instructions the mandate adapter cannot preserve");
      continue;
    }
    const tag = compiled.data[0];
    if (tag !== SPL_TRANSFER_TAG && tag !== SPL_TRANSFER_CHECKED_TAG) {
      if (expected.strict) fail("terms_unavailable", "Crossmint preparation contains unsupported token instructions");
      continue;
    }
    const checked = tag === SPL_TRANSFER_CHECKED_TAG;
    const expectedLength = checked ? 10 : 9;
    if (compiled.data.length !== expectedLength) {
      fail("malformed", "Crossmint transfer instruction has an unexpected data length");
    }
    const minimumAccounts = checked ? 4 : 3;
    if (compiled.accountKeyIndexes.length < minimumAccounts) {
      fail("malformed", "Crossmint transfer instruction is missing required accounts");
    }
    if (expected.strict && (!checked || compiled.accountKeyIndexes.length !== minimumAccounts)) {
      fail("terms_unavailable", "Checkout requires exactly one TransferChecked without extra reference accounts");
    }
    const view = new DataView(compiled.data.buffer, compiled.data.byteOffset, compiled.data.byteLength);
    const amount = view.getBigUint64(1, true);
    if (amount <= 0n || amount > MAX_U64) {
      fail("malformed", "Crossmint transfer amount must be a positive unsigned 64-bit integer");
    }
    const source = canonicalAddress(keyAt(compiled.accountKeyIndexes[0]), "Crossmint transfer source");
    const recipient = canonicalAddress(
      keyAt(compiled.accountKeyIndexes[checked ? 2 : 1]),
      "Crossmint transfer destination",
    );
    const tokenProgram = tokenProgramFrom(programId);
    if (!checked) {
      if (!expected.mint) {
        fail(
          "terms_unavailable",
          "Crossmint prepared an unchecked SPL transfer, which does not name a mint; supply the order's mint explicitly before settling",
        );
      }
      transfers.push({
        mint: expected.mint,
        recipient,
        source,
        amount: amount.toString(),
        tokenProgram,
      });
      continue;
    }
    transfers.push({
      mint: canonicalAddress(keyAt(compiled.accountKeyIndexes[1]), "Crossmint transfer mint"),
      recipient,
      source,
      amount: amount.toString(),
      decimals: compiled.data[9],
      tokenProgram,
    });
  }
  if (transfers.length === 0) {
    fail("terms_unavailable", "Crossmint transaction contains no SPL Token or Token-2022 transfer to read terms from");
  }
  if (transfers.length > 1) {
    fail(
      "terms_unavailable",
      "Crossmint transaction contains more than one token transfer, so it has no single amount a mandate can authorize",
    );
  }
  const terms = transfers[0];
  if (expected.mint && expected.mint !== terms.mint) {
    fail(
      "terms_mismatch",
      `Crossmint transfer pays mint ${terms.mint}, which is not the expected ${expected.mint}`,
    );
  }
  if (expected.tokenProgram && expected.tokenProgram !== terms.tokenProgram) {
    fail(
      "terms_mismatch",
      `Crossmint transfer uses ${terms.tokenProgram}, which is not the expected ${expected.tokenProgram}`,
    );
  }
  return terms;
}

function quoteCheckFor(order: CrossmintOrderSummary, terms: CrossmintTransferTerms): CrossmintQuoteCheck {
  if (!order.quotedTotal || terms.decimals === undefined) return "unavailable";
  if (!order.currency || order.quotedTotal.currency !== order.currency) return "unavailable";
  const scaled = scaleDecimalString(order.quotedTotal.amount, terms.decimals);
  if (scaled === undefined) return "unavailable";
  return scaled === BigInt(terms.amount) ? "match" : "mismatch";
}

/** Narrow, fail-closed staging checkout contract; generic decoding is not checkout authorization. */
export function validateCrossmintCheckoutOrder(
  order: CrossmintOrderSummary,
  expected: { orderId: string; owner: Address; source: Address; mint: Address; now?: number },
): CrossmintPaymentTerms {
  if (order.orderId !== expected.orderId || order.payerAddress !== expected.owner) fail("terms_mismatch", "Order or payer differs from the authenticated owner");
  if (order.paymentMethod !== "solana" || order.preparationChain !== "solana") fail("terms_unavailable", "Only Solana staging preparation is supported");
  if (order.currency !== "usdc" || expected.mint !== "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") fail("terms_unavailable", "Checkout currently supports only canonical Devnet USDC");
  const expires = Date.parse(order.quoteExpiresAt ?? "");
  if (order.quoteStatus !== "valid" || !Number.isFinite(expires) || expires <= (expected.now ?? Date.now())) fail("order_not_payable", "Crossmint quote is expired or unavailable");
  if (order.paymentStatus !== "awaiting-payment") fail("order_not_payable", "Crossmint order is not awaiting payment");
  const transfer = decodeCrossmintTransferTerms(order.serializedTransaction ?? "", { mint: expected.mint, tokenProgram: "spl-token", strict: true });
  if (transfer.source !== expected.source || transfer.decimals !== 6) fail("terms_mismatch", "Prepared transfer differs from the mandate source or USDC decimals");
  const terms = crossmintPaymentTerms(order, { mint: expected.mint, tokenProgram: "spl-token" });
  if (terms.quoteCheck !== "match") fail("terms_mismatch", "Quote amount or currency does not match the prepared transfer");
  return terms;
}

/**
 * Turn a Crossmint order into the terms ChainPay will check against a mandate.
 * A phase that no longer owes money is rejected here rather than at settlement,
 * so an already-paid order cannot be charged a second time by mistake.
 */
export function crossmintPaymentTerms(
  order: CrossmintOrderSummary,
  expected: { mint?: Address; tokenProgram?: TokenProgram } = {},
): CrossmintPaymentTerms {
  if (order.phase !== CROSSMINT_PAYABLE_PHASE) {
    const settled = (CROSSMINT_SETTLED_PHASES as readonly string[]).includes(order.phase);
    fail(
      "order_not_payable",
      settled
        ? `Crossmint order ${order.orderId} is already in the ${order.phase} phase and owes nothing`
        : `Crossmint order ${order.orderId} is in the ${order.phase} phase, which does not accept payment`,
    );
  }
  if (!order.serializedTransaction) {
    fail(
      "terms_unavailable",
      `Crossmint order ${order.orderId} carries no prepared transaction, so ChainPay cannot read what it charges`,
    );
  }
  const terms = decodeCrossmintTransferTerms(order.serializedTransaction, expected);
  return {
    connector: CROSSMINT_CONNECTOR,
    connectorLabel: CROSSMINT_CONNECTOR_LABEL,
    orderId: order.orderId,
    phase: order.phase,
    mint: terms.mint,
    recipient: terms.recipient,
    amount: terms.amount,
    ...(terms.decimals === undefined ? {} : { decimals: terms.decimals }),
    tokenProgram: terms.tokenProgram,
    termsSource: "serialized-transaction",
    quoteCheck: quoteCheckFor(order, terms),
    ...(order.quotedTotal ? { quotedTotal: order.quotedTotal } : {}),
    lineItemLocators: order.lineItemLocators,
    ...(order.payerAddress ? { payerAddress: order.payerAddress } : {}),
    crossmintSourceTokenAccount: terms.source,
  };
}

/**
 * Payment references for a Crossmint order.
 *
 * The invoice hash commits to the connector and the order id and nothing else.
 * The receipt PDA is derived from it, so one Crossmint order can be settled at
 * most once under a given mandate however its price or recipient later change —
 * a repriced order cannot become a second charge.
 */
export async function deriveCrossmintPaymentReferences(orderId: string): Promise<CrossmintPaymentReferences> {
  const canonical = JSON.stringify({ connector: CROSSMINT_CONNECTOR, orderId: boundedString(orderId, "orderId", MAX_ORDER_ID_CHARS) });
  const invoiceHash = await sha256Hex(canonical);
  return {
    invoiceHash,
    paymentId: await sha256Hex(`payment:${invoiceHash}`),
    signatureReference: await sha256Hex(`crossmint:${invoiceHash}`),
  };
}

/** Orders API URL for one order id, against the staging or production host. */
export function crossmintOrderUrl(baseUrl: string, orderId: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}${CROSSMINT_ORDERS_PATH}/${encodeURIComponent(boundedString(orderId, "orderId", MAX_ORDER_ID_CHARS))}`);
  if (url.protocol !== "https:") fail("malformed", "Crossmint base URL must use HTTPS");
  return url.toString();
}
