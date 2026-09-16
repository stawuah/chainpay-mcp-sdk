import { buildCreateAssociatedTokenAccountInstruction, toWeb3Transaction, type ChainPayInstruction, type PreparedTransaction, type TokenProgram } from "@chainpay/sdk";
import type { Transaction } from "@solana/web3.js";
import { chainpayClient, submitSignedTransaction } from "../owner/runtime";

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
  const prepared: PreparedTransaction = {
    instructions: [review.createInstruction],
    requiredSigners: [payer],
    feePayer: payer,
  };
  const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
  const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
  const result = await submitSignedTransaction(
    `recipient-ata:${payer}:${review.tokenAccount}:${latest.blockhash}`,
    signed.serialize(),
  );
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
