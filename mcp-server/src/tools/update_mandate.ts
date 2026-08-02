import type { ChainPayMcpContext } from "./context.js";
import { serializeTransaction, solanaAddress, tokenProgram, toolResult, unsignedInteger } from "./common.js";

export async function updateMandate(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const owner = solanaAddress(args.owner, "owner");
  const transaction = context.client.buildUpdateMandate({
    approvedAgent: solanaAddress(args.approvedAgent, "approvedAgent"),
    allowedRecipient: solanaAddress(args.allowedRecipient, "allowedRecipient"),
    maxPerPayment: unsignedInteger(args.maxPerPayment, "maxPerPayment"),
    totalLimit: unsignedInteger(args.totalLimit, "totalLimit"),
    expiresAtSlot: unsignedInteger(args.expiresAtSlot, "expiresAtSlot"),
    maxPaymentCount: unsignedInteger(args.maxPaymentCount, "maxPaymentCount"),
    cooldownSlots: unsignedInteger(args.cooldownSlots, "cooldownSlots"),
    paused: args.paused === true,
    tokenProgram: tokenProgram(args.tokenProgram),
  }, owner);
  return toolResult({
    action: "owner_wallet_signature_required",
    transaction: serializeTransaction(transaction),
    message: "The owner wallet must review and sign this mandate update.",
  });
}
