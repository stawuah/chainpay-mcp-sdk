import type { ChainPayMcpContext } from "./context.js";
import { bytesToHex } from "@chainpay/sdk";
import { materializeUnsignedTransaction, serializeTransaction, toolResult } from "./common.js";
import { parsePaymentInput, requireObject } from "./payment-input.js";
import { requirementsFromPreflight } from "./check_payment_requirements.js";

export async function preparePayment(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const parsed = parsePaymentInput(requireObject(args));
  const prepared = await context.client.preparePayment(parsed.input, parsed.agent);
  if (!prepared.preflight.valid) {
    return toolResult(
      {
        action: "rejected_by_preflight",
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        capabilityProfile: prepared.capabilityProfile,
        requirements: requirementsFromPreflight(prepared.preflight),
        transaction: serializeTransaction(prepared.transaction),
      },
      true,
    );
  }
  const unsignedTransaction = await materializeUnsignedTransaction(context.client, prepared.transaction);
  return toolResult(
    {
      action: "agent_signature_required",
      payment: {
        mandate: parsed.input.mandate,
        agent: parsed.agent,
        invoiceHash: bytesToHex(parsed.input.invoiceHash),
        paymentId: bytesToHex(parsed.input.paymentId),
        signatureReference: bytesToHex(parsed.input.signatureReference),
        mint: parsed.input.mint,
        recipient: parsed.input.recipient,
        amount: parsed.input.amount,
        ...(parsed.input.tokenProgram ? { tokenProgram: parsed.input.tokenProgram } : {}),
      },
      receiptAddress: prepared.receiptAddress,
      preflight: prepared.preflight,
      capabilityProfile: prepared.capabilityProfile,
      requirements: requirementsFromPreflight(prepared.preflight),
      transaction: serializeTransaction(prepared.transaction),
      unsignedTransaction,
    },
  );
}
