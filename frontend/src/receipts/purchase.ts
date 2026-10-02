import {
  hexToBytes,
  verifyReceiptPurchase,
  type SignedPaymentRequest,
} from "@chainpay/sdk";
import { formatTokenUnits, type PurchaseProofState, type ReceiptView } from "./model";

/** Keeps a hostile audit link from making the page decode megabytes. */
const MAX_FRAGMENT_LENGTH = 16_384;

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** The `purchase=` fragment value for a merchant-signed request. */
export function encodePurchaseFragment(request: SignedPaymentRequest): string {
  return base64UrlEncode(JSON.stringify({ payload: request.payload, signature: request.signature }));
}

/**
 * Decode an audit-link fragment into something shaped like a signed request.
 * Shape only: nothing here is trusted until verifyPurchaseForReceipt passes.
 */
export function decodePurchaseFragment(fragment: string): SignedPaymentRequest | null {
  if (!fragment || fragment.length > MAX_FRAGMENT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(fragment)) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(fragment)) as unknown;
    return isSignedRequestShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSignedRequestShape(value: unknown): value is SignedPaymentRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { payload?: unknown; signature?: unknown };
  return typeof candidate.signature === "string"
    && Boolean(candidate.payload)
    && typeof candidate.payload === "object"
    && !Array.isArray(candidate.payload);
}

/**
 * Check a merchant-signed request against this receipt: the seller signature
 * verifies and its canonical hash is the receipt's on-chain invoice hash.
 * Only then is any of its content returned.
 */
export async function verifyPurchaseForReceipt(
  receipt: ReceiptView,
  request: unknown,
  via: "owner" | "link",
): Promise<PurchaseProofState> {
  if (!isSignedRequestShape(request)) {
    return { status: "failed", via, reason: "the invoice could not be read" };
  }
  if (!globalThis.crypto?.subtle) {
    return { status: "failed", via, reason: "this browser cannot check the seller signature" };
  }
  try {
    const result = await verifyReceiptPurchase({
      invoiceHash: hexToBytes(receipt.invoiceHash, "invoiceHash"),
      amount: BigInt(receipt.amount.baseUnits),
      mint: receipt.mint,
      recipientTokenAccount: receipt.recipientTokenAccount,
    }, request);
    if (!result.valid) {
      return {
        status: "failed",
        via,
        reason: result.signatureValid
          ? "it is not the invoice this receipt paid"
          : "the seller signature does not check out",
      };
    }
    const payload = result.payload;
    // Line-item amounts are base units of the request's mint. Show token
    // units only when that is the mint this receipt paid.
    const decimals = payload.mint === receipt.mint ? receipt.amount.decimals : null;
    const token = payload.mint === receipt.mint ? receipt.tokenLabel : "";
    return {
      status: "verified",
      via,
      merchant: payload.merchant,
      invoice: payload.invoice,
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.lineItems?.length
        ? {
            lineItems: payload.lineItems.map((item) => ({
              label: item.label,
              ...(item.amount === undefined ? {} : { amount: formatTokenUnits(item.amount, decimals, token) }),
              ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
            })),
          }
        : {}),
      mismatches: result.mismatches,
      ...(via === "owner" ? { shareFragment: encodePurchaseFragment(request) } : {}),
    };
  } catch {
    return { status: "failed", via, reason: "the invoice could not be checked" };
  }
}
