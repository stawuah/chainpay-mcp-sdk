import type { ChainPayMcpContext } from "./context.js";
import { hex32, solanaAddress, toolResult } from "./common.js";

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
  return receipt
    ? toolResult({ found: true, receipt })
    : toolResult({ found: false, receiptAddress }, true);
}
