import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, toolResult } from "./common.js";
import { displayTokenAmounts } from "./token-amount.js";

/**
 * `get_mandate` historically takes `address`; the x402 and payment tools call
 * the same PDA `mandate`. Accept either, and refuse two different values so
 * the authorized mandate and the one read can never differ.
 */
export function getMandateAddressArgument(args: Record<string, unknown>): unknown {
  if (args.address !== undefined && args.mandate !== undefined && args.address !== args.mandate) {
    throw new Error("Pass the mandate PDA once: address and mandate differ");
  }
  return args.address ?? args.mandate;
}

export async function getMandate(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const address = solanaAddress(getMandateAddressArgument(args), "address");
  const mandate = await context.client.getMandate(address);
  if (!mandate) return toolResult({ found: false, address }, true);
  const display = await displayTokenAmounts(context.client, mandate.allowedMint, {
    maxPerPayment: mandate.maxPerPayment,
    totalLimit: mandate.totalLimit,
    amountSpent: mandate.amountSpent,
  });
  return toolResult({ found: true, mandate, display });
}
