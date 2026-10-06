import { buildCreateAssociatedTokenAccountInstruction, type ChainPayInstruction, type TokenProgram } from "@chainpayhq/sdk";
import type { Transaction } from "@solana/web3.js";
import { ensureAssociatedTokenAccount } from "./tokenAccount";

export type RecipientAtaReview = {
  ownerWallet: string;
  tokenAccount: string;
  mint: string;
  tokenProgram: TokenProgram;
  createInstruction: ChainPayInstruction;
};

export async function createRecipientTokenAccount(
  review: RecipientAtaReview,
  walletSigner: (transaction: Transaction) => Promise<Transaction>,
  payer: string,
): Promise<string | undefined> {
  const result = await ensureAssociatedTokenAccount({
    payer,
    owner: review.ownerWallet,
    mint: review.mint,
    tokenProgram: review.tokenProgram,
    walletSigner,
    idempotencyPrefix: `recipient-ata:${payer}:${review.tokenAccount}`,
  });
  return result.signature;
}

export function buildRecipientAtaReview(
  ownerWallet: string,
  tokenAccount: string,
  mint: string,
  tokenProgram: TokenProgram,
  payer: string,
  createInstruction: ChainPayInstruction,
): RecipientAtaReview {
  return {
    ownerWallet,
    tokenAccount,
    mint,
    tokenProgram,
    createInstruction: createInstruction ?? buildCreateAssociatedTokenAccountInstruction({
      payer,
      owner: ownerWallet,
      mint,
      tokenProgram,
    }),
  };
}
