import {
  relayObservedPolicy,
  verifyReceiptPurchase,
  type OpsReceiptContext,
  type OpsReceiptPurpose,
  type PaymentReceipt,
  type ReceiptPolicy,
  type SignedPaymentRequest,
} from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";

const RELAY_TIMEOUT_MS = 10_000;

async function relayJson(context: ChainPayMcpContext, path: string): Promise<Record<string, unknown> | null> {
  if (!context.backendUrl || !context.backendAuthToken) return null;
  const response = await fetch(`${context.backendUrl.replace(/\/$/, "")}${path}`, {
    headers: { Authorization: `Bearer ${context.backendAuthToken}` },
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = await response.json() as unknown;
  return body && typeof body === "object" ? body as Record<string, unknown> : null;
}

/** The relay's post-payment observation of the limits, if it made one. */
export async function relayReceiptPolicy(
  context: ChainPayMcpContext,
  receiptAddress: string,
): Promise<ReceiptPolicy | null> {
  const body = await relayJson(context, `/v1/receipts/${encodeURIComponent(receiptAddress)}`);
  return relayObservedPolicy(body?.policy);
}

/**
 * What was bought, read from the merchant-signed request the relay kept for
 * this receipt. Owner wallet sessions only: the relay refuses scoped agent
 * connections, so they are not asked. The request is used only after its hash
 * and signature check out against the receipt itself.
 */
export async function verifiedReceiptPurpose(
  context: ChainPayMcpContext,
  receipt: PaymentReceipt,
): Promise<OpsReceiptPurpose | undefined> {
  if (context.principal?.scope) return undefined;
  const body = await relayJson(context, `/v1/receipts/${encodeURIComponent(receipt.address)}/request`);
  const request = body?.request as SignedPaymentRequest | undefined;
  if (!request || typeof request !== "object" || !request.payload) return undefined;
  const verification = await verifyReceiptPurchase(receipt, request);
  if (!verification.valid) return undefined;
  const { invoice, description, lineItems } = verification.payload;
  return {
    invoice,
    ...(description === undefined ? {} : { description }),
    ...(lineItems === undefined ? {} : { lineItems }),
    matched: verification.matched,
  };
}

/** Off-chain context for one receipt. Each part fails closed to "absent". */
export async function receiptContext(
  context: ChainPayMcpContext,
  receipt: PaymentReceipt,
): Promise<OpsReceiptContext> {
  const [relayPolicy, purpose] = await Promise.all([
    receipt.policySnapshot ? Promise.resolve(null) : relayReceiptPolicy(context, receipt.address).catch(() => null),
    verifiedReceiptPurpose(context, receipt).catch(() => undefined),
  ]);
  return { relayPolicy, ...(purpose ? { purpose } : {}) };
}
