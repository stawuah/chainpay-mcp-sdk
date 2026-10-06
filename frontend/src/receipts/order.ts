import {
  deriveAssociatedTokenAddress,
  parseSignedMandateRequest,
  verifyMandateRequest,
  type SignedMandateRequest,
} from "@chainpayhq/sdk";
import type { OrderLinkState, ReceiptView } from "./model";

/** Keeps a hostile audit link from making the page decode megabytes. */
const MAX_FRAGMENT_LENGTH = 8_192;

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

/** The `order=` fragment value for a requester-signed mandate request. */
export function encodeOrderFragment(request: SignedMandateRequest): string {
  return base64UrlEncode(JSON.stringify({ payload: request.payload, signature: request.signature }));
}

/** Shape only. Nothing from it is trusted until verifyOrderForReceipt passes. */
export function decodeOrderFragment(fragment: string): unknown {
  if (!fragment || fragment.length > MAX_FRAGMENT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(fragment)) return null;
  try {
    return JSON.parse(base64UrlDecode(fragment)) as unknown;
  } catch {
    return null;
  }
}

/**
 * True when the receipt paid the payee's associated token account for this
 * mint (or the payee address itself). ChainPay prepares canonical associated
 * accounts, so this is the account a payment to that payee lands in.
 */
export function paidToPayee(receipt: Pick<ReceiptView, "recipientTokenAccount" | "mint">, payee: string, tokenProgram: "spl-token" | "token-2022"): boolean {
  if (receipt.recipientTokenAccount === payee) return true;
  try {
    return deriveAssociatedTokenAddress(payee, receipt.mint, tokenProgram) === receipt.recipientTokenAccount;
  } catch {
    return false;
  }
}

/**
 * Check a signed mandate request against a receipt: the requester signature
 * verifies, it is for the token this receipt paid, and a budget request names
 * the agent that signed. Only then is any of its content returned. The link
 * expiry is not applied: the request was accepted before the payment.
 */
export async function verifyOrderForReceipt(
  receipt: ReceiptView,
  request: unknown,
  via: "owner" | "link",
): Promise<OrderLinkState> {
  let signed: SignedMandateRequest;
  try {
    signed = parseSignedMandateRequest(request);
  } catch {
    return { status: "failed", via, reason: "the order could not be read" };
  }
  if (!globalThis.crypto?.subtle) return { status: "failed", via, reason: "this browser cannot check the requester signature" };
  const verification = await verifyMandateRequest(signed);
  if (!verification.valid) return { status: "failed", via, reason: "the requester signature does not check out" };
  const payload = verification.payload;
  if (payload.mint !== receipt.mint) return { status: "failed", via, reason: "it is for a different token than this payment" };
  if (payload.role === "grantee" && payload.agent !== receipt.agent) {
    return { status: "failed", via, reason: "it names a different agent than the one that paid" };
  }
  return {
    status: "linked",
    via,
    role: payload.role,
    requester: payload.requester,
    ...(payload.requesterName ? { requesterName: payload.requesterName } : {}),
    ...(payload.poNumber ? { poNumber: payload.poNumber } : {}),
    description: payload.description,
    ...(payload.recipient ? { expectedPayee: payload.recipient } : {}),
    payeeMatches: payload.role === "vendor" && payload.recipient
      ? paidToPayee(receipt, payload.recipient, payload.tokenProgram)
      : null,
    ...(via === "owner" ? { shareFragment: encodeOrderFragment({ payload, signature: signed.signature }) } : {}),
  };
}
