import { bytesToHex, verifyPaymentRequest, type SignedPaymentRequest } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { requiredString, solanaAddress, toolResult } from "./common.js";
import { quotePayment } from "./quote_payment.js";
import { requireObject } from "./payment-input.js";
import { checkPaymentRequirements } from "./check_payment_requirements.js";
import { derivePaymentReferences } from "./payment-request-references.js";

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
  const { paymentId, signatureReference } = derivePaymentReferences(invoiceHash, requiredString(request.signature, "request.signature"));
  const paymentArgs = {
    mandate,
    agent,
    invoiceHash,
    paymentId,
    signatureReference,
    mint: verification.payload.mint,
    recipient: verification.payload.recipient,
    amount: verification.payload.amount,
    tokenProgram: verification.payload.tokenProgram,
  };
  const checked = await checkPaymentRequirements(context, paymentArgs);
  const checkedContent = checked.structuredContent && typeof checked.structuredContent === "object"
    ? checked.structuredContent as { requirements?: unknown }
    : undefined;
  if (checked.isError) {
    return toolResult({
      action: "payment_request_blocked",
      verification: {
        valid: true,
        invoiceHash,
        payload: verification.payload,
      },
      references: { invoiceHash, paymentId, signatureReference },
      requirements: checkedContent?.requirements,
      check: checkedContent,
      message: "The merchant request is valid, but the five payment checks did not pass.",
    }, true);
  }

  const quote = await quotePayment(context, paymentArgs);

  return toolResult({
    action: "payment_request_quoted",
    verification: {
      valid: true,
      invoiceHash,
      payload: verification.payload,
    },
    references: { invoiceHash, paymentId, signatureReference },
    requirements: checkedContent?.requirements ?? (quote.structuredContent && typeof quote.structuredContent === "object"
      ? (quote.structuredContent as { requirements?: unknown }).requirements
      : undefined),
    quote: quote.structuredContent,
    message: "The merchant request is valid and has been checked against the selected mandate. Wallet or approved-agent signing is still required before settlement.",
  }, quote.isError === true);
}
