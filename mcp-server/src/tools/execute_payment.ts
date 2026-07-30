import type { ChainPayMcpContext } from "./context.js";
import { serializeTransaction, toolResult } from "./common.js";
import { parsePaymentInput, requireObject } from "./payment-input.js";

export async function executePayment(
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
        transaction: serializeTransaction(prepared.transaction),
      },
      true,
    );
  }

  if (!context.paymentExecutor) {
    return toolResult(
      {
        action: "execution_adapter_required",
        message: "No transaction execution adapter is configured. Return this transaction to a wallet or approved signer service.",
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        transaction: serializeTransaction(prepared.transaction),
      },
      true,
    );
  }

  const result = await context.client.executePayment(prepared, context.paymentExecutor);
  return toolResult(result, result.status === "failed");
}
