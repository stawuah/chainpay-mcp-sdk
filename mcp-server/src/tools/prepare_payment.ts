import type { ChainPayMcpContext } from "./context.js";
import { serializeTransaction, toolResult } from "./common.js";
import { parsePaymentInput, requireObject } from "./payment-input.js";

export async function preparePayment(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const parsed = parsePaymentInput(requireObject(args));
  const prepared = await context.client.preparePayment(parsed.input, parsed.agent);
  return toolResult(
    {
      action: "agent_signature_required",
      receiptAddress: prepared.receiptAddress,
      preflight: prepared.preflight,
      transaction: serializeTransaction(prepared.transaction),
    },
    !prepared.preflight.valid,
  );
}
