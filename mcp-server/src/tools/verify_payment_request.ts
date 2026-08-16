import { bytesToHex, verifyPaymentRequest as verifySignedPaymentRequest, type SignedPaymentRequest } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { toolResult } from "./common.js";
import { requireObject } from "./payment-input.js";
import { derivePaymentReferences } from "./payment-request-references.js";

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
    if (payload.valid !== true) return toolResult({ source: "chainpay-backend", ...payload }, true);
    const invoiceHash = typeof payload.invoice_hash === "string" ? payload.invoice_hash : undefined;
    if (!invoiceHash) return toolResult({ source: "chainpay-backend", ...payload, action: "verification_incomplete", message: "The backend verified the request but did not return an invoice hash." }, true);
    const references = derivePaymentReferences(invoiceHash, request.signature);
    return toolResult({
      source: "chainpay-backend",
      ...payload,
      invoiceHash,
      ...references,
      references: { invoiceHash, ...references },
    });
  }
  const currentSlot = await context.client.getCurrentSlot();
  const verification = await verifySignedPaymentRequest(request, currentSlot);
  if (!verification.valid) return toolResult(verification, true);
  const invoiceHash = bytesToHex(verification.invoiceHash);
  const references = derivePaymentReferences(invoiceHash, request.signature);
  return toolResult({
    ...verification,
    invoiceHash,
    ...references,
    references: { invoiceHash, ...references },
  });
}
