import { relayObservedPolicy } from "@chainpayhq/sdk";
import { BACKEND_URL } from "../config/client";
import { authorizedFetch } from "../session";
import { policyView } from "./load";
import { orderMatch, type OrderLinkState, type PolicyAtPaymentView, type PurchaseProofState, type ReceiptView } from "./model";
import { verifyOrderForReceipt } from "./order";
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
  /**
   * The signed mandate request (purchase order or budget request) the owner
   * accepted for this mandate, from GET /v1/mandates/{pda}/request, or null.
   */
  async mandateRequest(mandatePda: string): Promise<unknown> {
    const body = await relayJson(`/v1/mandates/${encodeURIComponent(mandatePda)}/request`);
    return body?.request ?? null;
  },
  /** PUT /v1/mandates/{pda}/request with the owner's session. May open sign-in. */
  async linkMandateRequest(path: string, init: RequestInit): Promise<Response> {
    return authorizedFetch(`${BACKEND_URL.replace(/\/$/, "")}${path}`, init);
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
  order: OrderLinkState;
};

/**
 * What the owner's session adds to a receipt: the relay's observed limits
 * when the receipt has no on-chain snapshot, and the merchant-signed request
 * once it verifies against the receipt. Each part fails closed.
 */
export async function loadOwnerReceiptContext(receipt: ReceiptView): Promise<OwnerReceiptContext> {
  const needsRelayPolicy = receipt.policy?.source !== "on-chain";
  const [policy, request, mandateRequest] = await Promise.all([
    needsRelayPolicy ? ownerReceiptRelay.policy(receipt.address).catch(() => null) : Promise.resolve(null),
    ownerReceiptRelay.request(receipt.address).catch(() => null),
    ownerReceiptRelay.mandateRequest(receipt.mandate).catch(() => null),
  ]);
  const observed = relayObservedPolicy(policy);
  const purchase: PurchaseProofState = request
    ? await verifyPurchaseForReceipt(receipt, request, "owner")
    : { status: "none" };
  const order: OrderLinkState = mandateRequest
    ? await verifyOrderForReceipt(receipt, mandateRequest, "owner")
    : { status: "none" };
  return {
    ...(observed ? { policy: policyView(observed) } : {}),
    purchase,
    order,
  };
}

/**
 * PO number and Order match pill for one receipt, for the CSV. The pill is
 * what the owner's receipt shows, or empty when it shows no Order match.
 * Mandate requests are cached per mandate by the caller's map.
 */
export async function ownerOrderSummary(
  receipt: ReceiptView,
  mandateRequests: Map<string, Promise<unknown>>,
): Promise<{ poNumber?: string; orderMatch?: string; description?: string }> {
  let mandateRequest = mandateRequests.get(receipt.mandate);
  if (!mandateRequest) {
    mandateRequest = ownerReceiptRelay.mandateRequest(receipt.mandate).catch(() => null);
    mandateRequests.set(receipt.mandate, mandateRequest);
  }
  const [request, signedOrder] = await Promise.all([
    ownerReceiptRelay.request(receipt.address).catch(() => null),
    mandateRequest,
  ]);
  const purchase: PurchaseProofState = request ? await verifyPurchaseForReceipt(receipt, request, "owner") : { status: "none" };
  const order: OrderLinkState = signedOrder ? await verifyOrderForReceipt(receipt, signedOrder, "owner") : { status: "none" };
  const match = orderMatch(purchase, "owner", order);
  return {
    ...(order.status === "linked" && order.poNumber ? { poNumber: order.poNumber } : {}),
    ...(match ? { orderMatch: match.pill } : {}),
    ...(purchase.status === "verified" && purchase.description ? { description: purchase.description } : {}),
  };
}
