import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, toolResult } from "./common.js";
import { displayTokenAmounts } from "./token-amount.js";

export async function getMandate(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const address = solanaAddress(args.address, "address");
  const mandate = await context.client.getMandate(address);
  if (!mandate) return toolResult({ found: false, address }, true);
  const display = await displayTokenAmounts(context.client, mandate.allowedMint, {
    maxPerPayment: mandate.maxPerPayment,
    totalLimit: mandate.totalLimit,
    amountSpent: mandate.amountSpent,
  });
  return toolResult({ found: true, mandate, display });
}
