import { createHash } from "node:crypto";
import { bytesToHex, verifyPaymentRequest, type SignedPaymentRequest } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { requiredString, solanaAddress, toolResult } from "./common.js";
import { quotePayment } from "./quote_payment.js";
import { requireObject } from "./payment-input.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function quotePaymentRequest(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const request = requireObject(args.request) as unknown as SignedPaymentRequest;
  const mandate = solanaAddress(args.mandate, "mandate");
  const agent = solanaAddress(args.agent, "agent");
  const currentSlot = await context.client.getCurrentSlot();
  const verification = await verifyPaymentRequest(request, currentSlot);
  if (!verification.valid) return toolResult({ action: "payment_request_rejected", verification }, true);

  const invoiceHash = bytesToHex(verification.invoiceHash);
  const paymentId = sha256Hex(`payment:${invoiceHash}`);
  const signatureReference = sha256Hex(`merchant-signature:${requiredString(request.signature, "request.signature")}`);
  const quote = await quotePayment(context, {
    mandate,
    agent,
    invoiceHash,
    paymentId,
    signatureReference,
    mint: verification.payload.mint,
    recipient: verification.payload.recipient,
    amount: verification.payload.amount,
    tokenProgram: verification.payload.tokenProgram,
  });

  return toolResult({
    action: "payment_request_quoted",
    verification: {
      valid: true,
      invoiceHash,
      payload: verification.payload,
    },
    references: { invoiceHash, paymentId, signatureReference },
    quote: quote.structuredContent,
    message: "The merchant request is valid and has been checked against the selected mandate. Wallet or approved-agent signing is still required before settlement.",
  }, quote.isError === true);
}
