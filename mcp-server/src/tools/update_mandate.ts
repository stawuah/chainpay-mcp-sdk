import type { ChainPayMcpContext } from "./context.js";
import { serializeTransaction, solanaAddress, toolResult, unsignedInteger } from "./common.js";

export async function updateMandate(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const owner = solanaAddress(args.owner, "owner");
  const mandate = args.mandate === undefined ? undefined : solanaAddress(args.mandate, "mandate");
  const transaction = context.client.buildUpdateMandate({
    approvedAgent: solanaAddress(args.approvedAgent, "approvedAgent"),
    maxPerPayment: unsignedInteger(args.maxPerPayment, "maxPerPayment"),
    totalLimit: unsignedInteger(args.totalLimit, "totalLimit"),
    expiresAtSlot: unsignedInteger(args.expiresAtSlot, "expiresAtSlot"),
    maxPaymentCount: unsignedInteger(args.maxPaymentCount, "maxPaymentCount"),
    cooldownSlots: unsignedInteger(args.cooldownSlots, "cooldownSlots"),
    paused: args.paused === true,
  }, owner, mandate);
  return toolResult({
    action: "owner_wallet_signature_required",
    transaction: serializeTransaction(transaction),
    message: "The owner wallet must review and sign this mandate update.",
  });
}
