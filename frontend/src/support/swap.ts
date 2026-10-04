// "Tip with any token": Jupiter swaps the donor's token to USDC inside the same
// transaction, delivering it straight into the vault's USDC account; then our
// memo + allocate_usdc run. The splitter program still only ever receives USDC.
//
// Jupiter's API is a third party, so its instructions are checked before the
// wallet is asked to sign (see assertSafeSwap). Mainnet only.
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { ChainPayWallet, SolanaChain } from "../wallet/connect";
import { ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, WALLET_CHAIN } from "./config";
import { allocateIx, buildMemo, type SupportAccounts } from "./donation";
import { base58, supportConnection } from "./send";

const JUP = "https://lite-api.jup.ag";
export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SLIPPAGE_BPS = 50;

export type SwapToken = { mint: string; symbol: string; name: string; decimals: number; icon?: string; verified: boolean };
export type SwapQuote = { inAmount: string; outAmount: string; otherAmountThreshold: string; raw: unknown };

type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
type JupSwapInstructions = {
  computeBudgetInstructions?: JupIx[];
  setupInstructions?: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction?: JupIx | null;
  otherInstructions?: JupIx[];
  tokenLedgerInstruction?: JupIx | null;
  addressLookupTableAddresses?: string[];
  error?: string;
};

/** Verified tokens only, so a look-alike scam token can't sit next to the real one. */
export async function searchTokens(query: string, fetcher: typeof fetch = fetch): Promise<SwapToken[]> {
  const q = query.trim();
  if (!q) return [];
  const response = await fetcher(`${JUP}/tokens/v2/search?query=${encodeURIComponent(q)}`);
  if (!response.ok) throw new Error("token search failed");
  const list = (await response.json()) as { id: string; symbol: string; name: string; decimals: number; icon?: string; isVerified?: boolean }[];
  return list
    .filter((t) => t.isVerified && typeof t.id === "string" && Number.isInteger(t.decimals))
    .map((t) => ({ mint: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon, verified: true }))
    .slice(0, 12);
}

export async function quoteToUsdc(inputMint: string, amount: bigint, usdcMint: string, fetcher: typeof fetch = fetch): Promise<SwapQuote | null> {
  const url = `${JUP}/swap/v1/quote?inputMint=${inputMint}&outputMint=${usdcMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&swapMode=ExactIn`;
  const response = await fetcher(url);
  if (!response.ok) return null;
  const raw = (await response.json()) as { inAmount?: string; outAmount?: string; otherAmountThreshold?: string; outputMint?: string };
  if (raw.outputMint !== usdcMint || !raw.outAmount || !raw.otherAmountThreshold || !raw.inAmount) return null;
  return { inAmount: raw.inAmount, outAmount: raw.outAmount, otherAmountThreshold: raw.otherAmountThreshold, raw };
}

function toIx(ix: JupIx) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/**
 * Refuses anything other than: compute budget, creating the donor's own token
 * accounts, one Jupiter swap that pays into the vault's USDC account, and
 * closing the donor's own temporary account. Throws with a plain reason.
 */
export function assertSafeSwap(response: JupSwapInstructions, donor: string, accounts: SupportAccounts) {
  if (response.error) throw new Error("Jupiter couldn't build this swap.");
  if (response.tokenLedgerInstruction) throw new Error("Unexpected token-ledger swap mode.");
  if (response.otherInstructions?.length) throw new Error("Swap included extra instructions.");
  const computeBudget = ComputeBudgetProgram.programId.toBase58();
  for (const ix of response.computeBudgetInstructions ?? []) {
    if (ix.programId !== computeBudget) throw new Error("Unexpected compute instruction.");
  }
  for (const ix of response.setupInstructions ?? []) {
    // ATA create(Idempotent): [payer, ata, owner, mint, system, token program]
    const ownerIsDonor = ix.accounts[2]?.pubkey === donor && ix.accounts[0]?.pubkey === donor;
    if (ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() || !ownerIsDonor) {
      throw new Error("Swap setup touches an account that isn't yours.");
    }
  }
  const swap = response.swapInstruction;
  if (swap.programId !== JUPITER_PROGRAM_ID) throw new Error("Swap isn't routed through Jupiter.");
  if (!swap.accounts.some((a) => a.pubkey === accounts.vaultUsdc.toBase58() && a.isWritable)) {
    throw new Error("Swap doesn't deliver to the support vault.");
  }
  if (!swap.accounts.some((a) => a.pubkey === accounts.usdcMint.toBase58())) throw new Error("Swap doesn't output USDC.");
  const signers = swap.accounts.filter((a) => a.isSigner).map((a) => a.pubkey);
  if (signers.some((s) => s !== donor)) throw new Error("Swap asks for an unexpected signer.");
  const cleanup = response.cleanupInstruction;
  if (cleanup) {
    // Only closing the donor's own wrapped-SOL account, with lamports back to the donor.
    const closeAccount = Buffer.from(cleanup.data, "base64")[0] === 9;
    const tokenProgram = cleanup.programId === TOKEN_PROGRAM_ID.toBase58() || cleanup.programId === TOKEN_2022_PROGRAM_ID;
    if (!tokenProgram || !closeAccount || cleanup.accounts[1]?.pubkey !== donor || cleanup.accounts[2]?.pubkey !== donor) {
      throw new Error("Swap cleanup sends funds somewhere unexpected.");
    }
  }
}

export async function buildSwapTip(input: {
  donor: PublicKey;
  quote: SwapQuote;
  note: string;
  hideAddress: boolean;
  accounts: SupportAccounts;
  fetcher?: typeof fetch;
}) {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`${JUP}/swap/v1/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: input.quote.raw,
      userPublicKey: input.donor.toBase58(),
      destinationTokenAccount: input.accounts.vaultUsdc.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!response.ok) throw new Error("Jupiter couldn't build this swap.");
  const body = (await response.json()) as JupSwapInstructions;
  assertSafeSwap(body, input.donor.toBase58(), input.accounts);

  const memo = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: input.donor, isSigner: true, isWritable: false }],
    data: Buffer.from(new TextEncoder().encode(buildMemo(input.note, input.hideAddress))),
  });
  const instructions = [
    ...(body.computeBudgetInstructions ?? []).map(toIx),
    ...(body.setupInstructions ?? []).map(toIx),
    toIx(body.swapInstruction),
    ...(body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : []),
    memo,
    allocateIx("USDC", input.accounts),
  ];
  return { instructions, lookupTables: body.addressLookupTableAddresses ?? [] };
}

export async function signVersionedForSupport(
  wallet: ChainPayWallet,
  built: { instructions: TransactionInstruction[]; lookupTables: string[] },
  accounts: SupportAccounts,
) {
  const rpc = supportConnection();
  const tables = (
    await Promise.all(built.lookupTables.map((address) => rpc.getAddressLookupTable(new PublicKey(address))))
  )
    .map((result) => result.value)
    .filter((table): table is AddressLookupTableAccount => table !== null);
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: new PublicKey(wallet.address),
    recentBlockhash: blockhash,
    instructions: built.instructions,
  }).compileToV0Message(tables);
  // Lookup tables come from an RPC answer. Our own critical accounts must be
  // literal keys in the message, never indexes into a table we were told about.
  const literal = new Set(message.staticAccountKeys.map((key) => key.toBase58()));
  for (const critical of [accounts.vault, accounts.vaultUsdc, accounts.programId, MEMO_PROGRAM_ID]) {
    if (!literal.has(critical.toBase58())) throw new Error("Swap resolved a support account through a lookup table.");
  }
  const signed = await wallet.signVersionedTransaction(new VersionedTransaction(message), { chain: WALLET_CHAIN as SolanaChain });
  const signature = signed.signatures[0];
  if (!signature || signature.every((byte) => byte === 0)) throw new Error("The wallet didn't sign the transaction.");
  return { raw: signed.serialize(), signature: base58(signature), lastValidBlockHeight };
}
