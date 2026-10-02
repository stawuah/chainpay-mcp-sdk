import { relayObservedPolicy } from "@chainpay/sdk";
import { BACKEND_URL } from "../config/client";
import { authorizedFetch } from "../session";
import { policyView } from "./load";
import type { PolicyAtPaymentView, PurchaseProofState, ReceiptView } from "./model";
import { verifyPurchaseForReceipt } from "./purchase";

/**
 * Owner-session reads from the ChainPay relay. Both endpoints need the
 * owner's wallet session; "passive" never opens a sign-in prompt, so a
 * signed-out dashboard simply gets nothing. Exposed as an object so a
 * browser fixture can stand in for the relay.
 */
export const ownerReceiptRelay = {
  /** `policy` from GET /v1/receipts/{pda}, or null. */
  async policy(receiptPda: string): Promise<unknown> {
    const body = await relayJson(`/v1/receipts/${encodeURIComponent(receiptPda)}`);
    return body?.policy ?? null;
  },
  /** The merchant-signed request from GET /v1/receipts/{pda}/request, or null. */
  async request(receiptPda: string): Promise<unknown> {
    const body = await relayJson(`/v1/receipts/${encodeURIComponent(receiptPda)}/request`);
    return body?.request ?? null;
  },
};

async function relayJson(path: string): Promise<Record<string, unknown> | null> {
  const response = await authorizedFetch(`${BACKEND_URL.replace(/\/$/, "")}${path}`, {}, undefined, "passive");
  if (!response.ok) return null;
  const body = await response.json() as unknown;
  return body && typeof body === "object" ? body as Record<string, unknown> : null;
}

export type OwnerReceiptContext = {
  policy?: PolicyAtPaymentView;
  purchase: PurchaseProofState;
};

/**
 * What the owner's session adds to a receipt: the relay's observed limits
 * when the receipt has no on-chain snapshot, and the merchant-signed request
 * once it verifies against the receipt. Each part fails closed.
 */
export async function loadOwnerReceiptContext(receipt: ReceiptView): Promise<OwnerReceiptContext> {
  const needsRelayPolicy = receipt.policy?.source !== "on-chain";
  const [policy, request] = await Promise.all([
    needsRelayPolicy ? ownerReceiptRelay.policy(receipt.address).catch(() => null) : Promise.resolve(null),
    ownerReceiptRelay.request(receipt.address).catch(() => null),
  ]);
  const observed = relayObservedPolicy(policy);
  const purchase: PurchaseProofState = request
    ? await verifyPurchaseForReceipt(receipt, request, "owner")
    : { status: "none" };
  return {
    ...(observed ? { policy: policyView(observed) } : {}),
    purchase,
  };
}
