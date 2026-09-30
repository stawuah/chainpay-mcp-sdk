import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  buildCreateAssociatedTokenAccountInstruction,
  deriveAssociatedTokenAddress,
  toWeb3Transaction,
  type PreparedTransaction,
  type TokenProgram,
} from "@chainpay/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";
import {
  chainpayClient,
  getAccountInfoOrNull,
  submitSignedTransaction,
  tokenAccountValidationError,
} from "../owner/runtime";

const CLASSIC_TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_2022_ACCOUNT_SIZE = 170;
const NETWORK_FEE_LAMPORTS = 5_000;

export async function tokenProgramForMint(mint: string): Promise<TokenProgram> {
  let address: PublicKey;
  try {
    address = new PublicKey(mint.trim());
  } catch {
    throw new Error("Enter a valid mint address.");
  }
  const info = await getAccountInfoOrNull(address);
  if (!info) throw new Error("That mint was not found on this network.");
  const owner = info.owner.toBase58();
  if (owner === TOKEN_2022_PROGRAM_ID) return "token-2022";
  if (owner === SPL_TOKEN_PROGRAM_ID) return "spl-token";
  throw new Error("That address is not an SPL Token or Token-2022 mint.");
}

export async function assertCanPayTokenAccountRent(payer: string, tokenProgram: TokenProgram) {
  const size = tokenProgram === "token-2022" ? TOKEN_2022_ACCOUNT_SIZE : CLASSIC_TOKEN_ACCOUNT_SIZE;
  const rent = await chainpayClient.connection.getMinimumBalanceForRentExemption(size);
  const balance = await chainpayClient.connection.getBalance(new PublicKey(payer), "confirmed");
  if (balance < rent + NETWORK_FEE_LAMPORTS) {
    throw new Error("Add Devnet SOL to this wallet before creating the token account. Rent and the network fee come from SOL, not the stablecoin.");
  }
}

export type EnsuredTokenAccount = {
  address: string;
  signature?: string;
};

export async function ensureAssociatedTokenAccount(input: {
  payer: string;
  owner: string;
  mint: string;
  tokenProgram: TokenProgram;
  walletSigner: (transaction: Transaction) => Promise<Transaction>;
  idempotencyPrefix: string;
}): Promise<EnsuredTokenAccount> {
  const mint = input.mint.trim();
  const mintInfo = await getAccountInfoOrNull(new PublicKey(mint));
  if (!mintInfo) {
    throw new Error(`The selected ${input.tokenProgram === "token-2022" ? "Token-2022" : "SPL Token"} mint was not found on this network.`);
  }
  const expectedProgram = input.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  if (mintInfo.owner.toBase58() !== expectedProgram) {
    throw new Error("The selected mint does not belong to the selected token program.");
  }

  const address = deriveAssociatedTokenAddress(input.owner, mint, input.tokenProgram);
  const existing = await getAccountInfoOrNull(new PublicKey(address));
  if (existing) {
    const issue = tokenAccountValidationError(existing, mint, input.owner, input.tokenProgram);
    if (issue) throw new Error(issue);
    return { address };
  }

  await assertCanPayTokenAccountRent(input.payer, input.tokenProgram);

  const prepared: PreparedTransaction = {
    instructions: [buildCreateAssociatedTokenAccountInstruction({
      payer: input.payer,
      owner: input.owner,
      mint,
      tokenProgram: input.tokenProgram,
    })],
    requiredSigners: [input.payer],
    feePayer: input.payer,
  };
  const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
  const signed = await input.walletSigner(toWeb3Transaction(prepared, latest.blockhash));
  const result = await submitSignedTransaction(
    `${input.idempotencyPrefix}:${latest.blockhash}`,
    signed.serialize(),
  );
  return { address, signature: result.signature };
}
