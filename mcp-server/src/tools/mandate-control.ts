import type { ChainPayMcpContext } from "./context.js";
import { serializeTransaction, solanaAddress, toolResult } from "./common.js";

export async function pauseMandate(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const transaction = context.client.buildPauseMandate(owner);
  return toolResult({
    action: "owner_wallet_signature_required",
    transaction: serializeTransaction(transaction),
    message: "The owner wallet must sign this pause transaction.",
  });
}

export async function revokeMandate(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const transaction = context.client.buildRevokeMandate(owner);
  return toolResult({
    action: "owner_wallet_signature_required",
    transaction: serializeTransaction(transaction),
    message: "The owner wallet must sign this revocation transaction.",
  });
}

