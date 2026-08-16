import type { ChainPayMcpContext } from "./context.js";
import { parsePaymentInput, requireObject } from "./payment-input.js";
import { toolResult } from "./common.js";
import { requirementsFromPreflight } from "./check_payment_requirements.js";

export async function quotePayment(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const parsed = parsePaymentInput(requireObject(args));
  const prepared = await context.client.preparePayment(parsed.input, parsed.agent);
  return toolResult({
    action: "payment_quote",
    receiptAddress: prepared.receiptAddress,
    preflight: prepared.preflight,
    requirements: requirementsFromPreflight(prepared.preflight),
    amount: prepared.request.amount,
    mint: prepared.request.mint,
    recipient: prepared.request.recipient,
  }, !prepared.preflight.valid);
}
