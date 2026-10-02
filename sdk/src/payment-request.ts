import { PublicKey } from "@solana/web3.js";
import type {
  PaymentReceipt,
  PaymentRequestLineItem,
  PaymentRequestPayload,
  PaymentRequestVerification,
  SignedPaymentRequest,
} from "./types.js";
import { address, tokenProgramAddress } from "./encoding.js";

const MAX_U64 = 18_446_744_073_709_551_615n;

/** Bounds for the optional "what was bought" fields. The relay enforces the same. */
export const MAX_PAYMENT_REQUEST_DESCRIPTION_LENGTH = 280;
export const MAX_PAYMENT_REQUEST_LINE_ITEMS = 20;
export const MAX_PAYMENT_REQUEST_LINE_ITEM_LABEL_LENGTH = 120;
const MAX_QUANTITY_LENGTH = 32;

function orderedLineItem(item: PaymentRequestLineItem): PaymentRequestLineItem {
  // Canonical order is label, amount, quantity; absent fields are omitted.
  if (!item || typeof item !== "object") return item;
  return {
    label: item.label,
    ...(item.amount === undefined ? {} : { amount: item.amount }),
    ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
  };
}

function orderedPayload(payload: PaymentRequestPayload): PaymentRequestPayload {
  return {
    version: 1,
    cluster: payload.cluster,
    merchant: address(payload.merchant),
    invoice: payload.invoice,
    mint: address(payload.mint),
    tokenProgram: payload.tokenProgram,
    recipient: address(payload.recipient),
    amount: payload.amount,
    decimals: payload.decimals,
    nonce: payload.nonce,
    ...(payload.expiresAtSlot === undefined ? {} : { expiresAtSlot: payload.expiresAtSlot }),
    ...(payload.resource === undefined ? {} : { resource: payload.resource }),
    // Included only when present, after resource, so a request without them
    // keeps the exact canonical bytes and invoice hash it always had.
    ...(payload.description === undefined ? {} : { description: payload.description }),
    ...(payload.lineItems === undefined
      ? {}
      : { lineItems: Array.isArray(payload.lineItems) ? payload.lineItems.map(orderedLineItem) : payload.lineItems }),
  };
}

/** Length in Unicode code points, the unit the relay counts in. */
function codePoints(value: string): number {
  return Array.from(value).length;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Check the optional description and line items. Returns a reason when they
 * are out of bounds, otherwise undefined.
 */
export function paymentRequestPurposeError(payload: PaymentRequestPayload): string | undefined {
  if (payload.description !== undefined) {
    const description = payload.description;
    if (
      typeof description !== "string"
      || !description.trim()
      || codePoints(description) > MAX_PAYMENT_REQUEST_DESCRIPTION_LENGTH
    ) {
      return `Description must be 1 to ${MAX_PAYMENT_REQUEST_DESCRIPTION_LENGTH} characters`;
    }
    if (CONTROL_CHARACTER.test(description)) return "Description must be a single line of text";
  }
  if (payload.lineItems !== undefined) {
    const items = payload.lineItems;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_PAYMENT_REQUEST_LINE_ITEMS) {
      return `Line items must contain 1 to ${MAX_PAYMENT_REQUEST_LINE_ITEMS} items`;
    }
    for (const item of items) {
      if (!item || typeof item !== "object") return "Each line item must be an object";
      if (
        typeof item.label !== "string"
        || !item.label.trim()
        || codePoints(item.label) > MAX_PAYMENT_REQUEST_LINE_ITEM_LABEL_LENGTH
        || CONTROL_CHARACTER.test(item.label)
      ) {
        return `Each line item label must be one line of 1 to ${MAX_PAYMENT_REQUEST_LINE_ITEM_LABEL_LENGTH} characters`;
      }
      if (item.amount !== undefined) {
        if (typeof item.amount !== "string" || !/^\d+$/.test(item.amount) || BigInt(item.amount) > MAX_U64) {
          return "Line item amount must be an unsigned integer string in base units";
        }
      }
      if (item.quantity !== undefined) {
        if (
          typeof item.quantity !== "string"
          || item.quantity.length > MAX_QUANTITY_LENGTH
          || !/^\d+(\.\d+)?$/.test(item.quantity)
        ) {
          return "Line item quantity must be an unsigned decimal string";
        }
      }
    }
  }
  return undefined;
}

export function canonicalPaymentRequest(payload: PaymentRequestPayload): string {
  return JSON.stringify(orderedPayload(payload));
}

function base64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", value.slice().buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

function validationError(payload: PaymentRequestPayload, reason: string): PaymentRequestVerification {
  return { valid: false, payload, invoiceHash: new Uint8Array(32), reason };
}

export async function verifyPaymentRequest(
  request: SignedPaymentRequest,
  currentSlot?: bigint,
): Promise<PaymentRequestVerification> {
  if (request.payload.version !== 1) return validationError(request.payload, "Unsupported payment request version");
  const payload = orderedPayload(request.payload);
  try {
    if (payload.version !== 1) return validationError(payload, "Unsupported payment request version");
    if (payload.cluster !== "devnet" && payload.cluster !== "mainnet-beta") {
      return validationError(payload, "Unsupported Solana cluster");
    }
    if (!payload.invoice.trim() || !payload.nonce.trim()) {
      return validationError(payload, "Payment request invoice and nonce are required");
    }
    if (!/^\d+$/.test(payload.amount)) return validationError(payload, "Amount must be an unsigned integer string");
    const amount = BigInt(payload.amount);
    if (amount <= 0n || amount > MAX_U64) return validationError(payload, "Amount must fit in u64 and be positive");
    if (!Number.isInteger(payload.decimals) || payload.decimals < 0 || payload.decimals > 255) {
      return validationError(payload, "Decimals must be between 0 and 255");
    }
    if (payload.tokenProgram !== "spl-token" && payload.tokenProgram !== "token-2022") {
      return validationError(payload, "Unsupported token program");
    }
    address(payload.merchant);
    address(payload.mint);
    address(payload.recipient);
    const purposeError = paymentRequestPurposeError(payload);
    if (purposeError) return validationError(payload, purposeError);
    if (payload.expiresAtSlot !== undefined) {
      if (!/^\d+$/.test(payload.expiresAtSlot)) return validationError(payload, "Expiry slot must be an unsigned integer");
      if (currentSlot !== undefined && BigInt(payload.expiresAtSlot) <= currentSlot) {
        return validationError(payload, "Payment request has expired");
      }
    }

    const signature = base64Bytes(request.signature);
    if (signature.length !== 64) return validationError(payload, "Ed25519 signature must be 64 bytes");
    const merchant = new PublicKey(payload.merchant).toBytes();
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      merchant.slice().buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(canonicalPaymentRequest(payload));
    const validSignature = await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      signature.slice().buffer as ArrayBuffer,
      message.slice().buffer as ArrayBuffer,
    );
    if (!validSignature) return validationError(payload, "Payment request signature is invalid");

    const invoiceHash = await sha256(message);
    return { valid: true, payload, invoiceHash };
  } catch (error) {
    return validationError(payload, error instanceof Error ? error.message : String(error));
  }
}

export function paymentRequestTokenProgramAddress(request: PaymentRequestPayload): string {
  return tokenProgramAddress(request.tokenProgram);
}

export type ReceiptPurchaseMismatch = "amount" | "mint" | "recipient";

export type ReceiptPurchaseVerification = {
  /** Merchant signature is valid and the request hashes to the receipt's invoice hash. */
  valid: boolean;
  /** `valid`, and the receipt paid the amount, mint, and recipient the request named. */
  matched: boolean;
  signatureValid: boolean;
  hashMatches: boolean;
  /** Fields the receipt paid differently from the request. Empty when matched. */
  mismatches: ReceiptPurchaseMismatch[];
  payload: PaymentRequestPayload;
  invoiceHash: Uint8Array;
  reason?: string;
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Check that a merchant-signed request is the one a settled receipt paid:
 * the signature verifies, and sha256 of its canonical form equals the
 * receipt's invoice hash. Request expiry is not enforced, because a request
 * that has since expired is still the request that was paid.
 *
 * The program binds the invoice hash, not the request's amount, mint, or
 * recipient, so those are compared too and reported as mismatches.
 */
export async function verifyReceiptPurchase(
  receipt: Pick<PaymentReceipt, "invoiceHash" | "amount" | "mint" | "recipientTokenAccount">,
  signedRequest: SignedPaymentRequest,
): Promise<ReceiptPurchaseVerification> {
  const verification = await verifyPaymentRequest(signedRequest);
  const base = {
    payload: verification.payload,
    invoiceHash: verification.invoiceHash,
    mismatches: [] as ReceiptPurchaseMismatch[],
  };
  if (!verification.valid) {
    return {
      ...base,
      valid: false,
      matched: false,
      signatureValid: false,
      hashMatches: false,
      reason: verification.reason,
    };
  }
  if (!bytesEqual(verification.invoiceHash, receipt.invoiceHash)) {
    return {
      ...base,
      valid: false,
      matched: false,
      signatureValid: true,
      hashMatches: false,
      reason: "This request is not the one this receipt paid: its hash differs from the receipt's invoice hash",
    };
  }
  const payload = verification.payload;
  const mismatches: ReceiptPurchaseMismatch[] = [];
  if (BigInt(payload.amount) !== receipt.amount) mismatches.push("amount");
  if (payload.mint !== receipt.mint) mismatches.push("mint");
  if (payload.recipient !== receipt.recipientTokenAccount) mismatches.push("recipient");
  return {
    ...base,
    valid: true,
    matched: mismatches.length === 0,
    signatureValid: true,
    hashMatches: true,
    mismatches,
    ...(mismatches.length ? { reason: `The receipt paid a different ${mismatches.join(", ")} than the request named` } : {}),
  };
}
