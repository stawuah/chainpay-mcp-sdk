import type { CreateMandateInput } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import {
  requiredString,
  serializeTransaction,
  solanaAddress,
  tokenProgram,
  toolResult,
  unsignedInteger,
} from "./common.js";

export async function createMandate(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const input: CreateMandateInput = {
    approvedAgent: solanaAddress(args.approvedAgent, "approvedAgent"),
    sourceTokenAccount: solanaAddress(args.sourceTokenAccount, "sourceTokenAccount"),
    allowedMint: solanaAddress(args.allowedMint, "allowedMint"),
    maxPerPayment: unsignedInteger(args.maxPerPayment, "maxPerPayment"),
    totalLimit: unsignedInteger(args.totalLimit, "totalLimit"),
    expiresAtSlot: unsignedInteger(args.expiresAtSlot, "expiresAtSlot"),
    maxPaymentCount: args.maxPaymentCount === undefined ? 0n : unsignedInteger(args.maxPaymentCount, "maxPaymentCount"),
    cooldownSlots: args.cooldownSlots === undefined ? 0n : unsignedInteger(args.cooldownSlots, "cooldownSlots"),
    tokenProgram: tokenProgram(args.tokenProgram),
    delegateAmount: args.delegateAmount === undefined
      ? undefined
      : unsignedInteger(args.delegateAmount, "delegateAmount"),
  };
  const owner = solanaAddress(args.owner, "owner");
  const prepared = await context.client.buildCreateMandate(input, owner);

  return toolResult({
    action: "owner_wallet_signature_required",
    mandateAddress: prepared.mandateAddress,
    configAddress: prepared.configAddress,
    transaction: serializeTransaction(prepared.transaction),
    message: "The owner wallet must review and sign this transaction. MCP does not hold wallet keys.",
  });
}
