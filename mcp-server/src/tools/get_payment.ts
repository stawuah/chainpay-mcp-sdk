import type { ChainPayMcpContext } from "./context.js";
import { hex32, solanaAddress, toolResult } from "./common.js";
import { displayTokenAmounts } from "./token-amount.js";

export async function getPayment(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const receiptAddress = args.receiptAddress === undefined
    ? undefined
    : solanaAddress(args.receiptAddress, "receiptAddress");
  const mandate = args.mandate === undefined ? undefined : solanaAddress(args.mandate, "mandate");
  const invoiceHash = args.invoiceHash === undefined ? undefined : hex32(args.invoiceHash, "invoiceHash");

  if (!receiptAddress && (!mandate || !invoiceHash)) {
    throw new Error("Provide receiptAddress or both mandate and invoiceHash");
  }
  const receipt = await context.client.getPayment(
    receiptAddress ?? { mandate: mandate as string, invoiceHash: invoiceHash as Uint8Array },
  );
  if (!receipt) return toolResult({ kind: "payment_lookup", found: false, receiptAddress }, true);

  const display = await displayTokenAmounts(context.client, receipt.mint, {
    amount: receipt.amount,
  });
  let offChain: Record<string, unknown> | null = null;
  if (context.backendUrl) {
    const response = await fetch(
      `${context.backendUrl.replace(/\/$/, "")}/v1/receipts/${encodeURIComponent(receipt.address)}`,
      {
        headers: context.backendAuthToken
          ? { Authorization: `Bearer ${context.backendAuthToken}` }
          : undefined,
      },
    );
    if (response.ok) {
      const payment = await response.json() as Record<string, unknown>;
      offChain = {
        paymentId: payment.payment_id,
        transactionSignature: payment.signature,
        slot: payment.slot,
        status: payment.status,
        finalizedAtMs: payment.updated_at_ms,
      };
    } else if (response.status !== 404) {
      const error = await response.text();
      throw new Error(`Axum receipt lookup failed (${response.status}): ${error}`);
    }
  }
  return toolResult({
    kind: "payment_lookup",
    found: true,
    receiptAddress: receipt.address,
    onChain: receipt,
    offChain,
    display,
  });
}
