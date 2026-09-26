import type { AssociatedTokenAccountPreparation } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { serializeTransaction, solanaAddress, toolResult } from "./common.js";

function accountSummary(preparation: AssociatedTokenAccountPreparation) {
  return {
    mint: preparation.mint,
    tokenProgram: preparation.tokenProgram,
    tokenAccount: preparation.address,
    status: preparation.status,
  };
}

/**
 * Inspect one or every enabled registry asset and prepare the next missing ATA.
 * Each account stays a separate transaction so the relay can validate it and
 * the owner can see exactly which mint they are paying account rent for.
 */
export async function prepareTokenAccounts(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const preparations = args.mint === undefined
    ? await context.client.prepareRegisteredAssetTokenAccounts(owner, owner)
    : [await context.client.prepareAssociatedTokenAccount({
        owner,
        payer: owner,
        mint: solanaAddress(args.mint, "mint"),
      })];
  const missing = preparations.filter((item) => item.status === "missing");
  const next = missing[0];

  if (!next) {
    return toolResult({
      action: "token_accounts_ready",
      owner,
      accounts: preparations.map(accountSummary),
      message: args.mint === undefined
        ? "Canonical token accounts already exist for every enabled ChainPay registry asset."
        : "The canonical token account already exists for this enabled asset.",
    });
  }
  if (!next.transaction) throw new Error("Missing token account did not include a creation transaction");

  return toolResult({
    action: "token_account_signature_required",
    owner,
    mint: next.mint,
    tokenProgram: next.tokenProgram,
    tokenAccount: next.address,
    transaction: serializeTransaction(next.transaction),
    accounts: preparations.map(accountSummary),
    remainingMissing: missing.length,
    message: missing.length === 1
      ? "The owner wallet must review and sign this token-account creation. It spends Devnet SOL for account rent but does not fund the token account or grant spending permission."
      : `The owner wallet must review and sign this token-account creation. ${missing.length - 1} more enabled assets will still need separate wallet approvals.`,
  });
}
