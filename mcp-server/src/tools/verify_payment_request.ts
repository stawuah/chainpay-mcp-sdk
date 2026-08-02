import { verifyPaymentRequest as verifySignedPaymentRequest, type SignedPaymentRequest } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { toolResult } from "./common.js";
import { requireObject } from "./payment-input.js";

export async function verifyPaymentRequest(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const request = requireObject(args.request) as unknown as SignedPaymentRequest;
  if (context.backendUrl) {
    const response = await fetch(`${context.backendUrl.replace(/\/$/, "")}/v1/payment-requests/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(context.backendAuthToken
          ? { Authorization: `Bearer ${context.backendAuthToken}` }
          : {}),
      },
      body: JSON.stringify(request),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) return toolResult({ action: "backend_rejected", ...payload }, true);
    return toolResult({ source: "chainpay-backend", ...payload }, payload.valid !== true);
  }
  const currentSlot = await context.client.getCurrentSlot();
  const verification = await verifySignedPaymentRequest(request, currentSlot);
  return toolResult(verification, !verification.valid);
}
