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
import { ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT, WALLET_CHAIN } from "./config";
import { allocateIx, buildMemo, type SupportAccounts } from "./donation";
import { decodeJupiterSwap } from "./jupiter";
import { base58, supportConnection } from "./send";

const JUP = "https://lite-api.jup.ag";
export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const SLIPPAGE_BPS = 50;

// Fee limits. A route that asks for more is refused, not trimmed.
export const MAX_COMPUTE_UNITS = 1_400_000;
export const MAX_CU_PRICE_MICROLAMPORTS = 1_000_000n;
export const MAX_PRIORITY_FEE_LAMPORTS = 200_000n; // 0.0002 SOL
export const BASE_FEE_LAMPORTS = 5_000n; // one signature
// Rent for a new token account, which the donor pays and gets back if they close it.
const TOKEN_ACCOUNT_RENT: Record<string, bigint> = {
  [TOKEN_PROGRAM_ID.toBase58()]: 2_039_280n, // 165 bytes
  [TOKEN_2022_PROGRAM_ID]: 2_074_080n, // 170 bytes (immutable-owner extension)
};

export type SwapToken = { mint: string; symbol: string; name: string; decimals: number; icon?: string; verified: boolean };
export type SwapQuote = { inputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; raw: unknown };

type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export type JupSwapInstructions = {
  computeBudgetInstructions?: JupIx[];
  setupInstructions?: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction?: JupIx | null;
  otherInstructions?: JupIx[];
  tokenLedgerInstruction?: JupIx | null;
  addressLookupTableAddresses?: string[];
  error?: string;
};

/** What a checked swap costs the donor on top of the tip, before any account rent. */
export type SwapPlan = {
  priorityFeeLamports: bigint;
  /** Token accounts the setup creates for the donor (idempotent: no rent if they exist). */
  createsAccounts: { address: string; rentLamports: bigint }[];
};

/**
 * Verified tokens only, so a look-alike scam token can't sit next to the real one.
 * SOL and USDC have their own buttons, so they're left out here.
 */
export async function searchTokens(query: string, fetcher: typeof fetch = fetch): Promise<SwapToken[]> {
  const q = query.trim();
  if (!q) return [];
  const response = await fetcher(`${JUP}/tokens/v2/search?query=${encodeURIComponent(q)}`);
  if (!response.ok) throw new Error("token search failed");
  const list = (await response.json()) as { id: string; symbol: string; name: string; decimals: number; icon?: string; isVerified?: boolean }[];
  return list
    .filter((t) => t.isVerified && typeof t.id === "string" && Number.isInteger(t.decimals))
    .filter((t) => t.id !== WSOL_MINT && t.id !== USDC_MINT)
    .map((t) => ({ mint: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon, verified: true }))
    .slice(0, 12);
}

export async function quoteToUsdc(inputMint: string, amount: bigint, usdcMint: string, fetcher: typeof fetch = fetch): Promise<SwapQuote | null> {
  const url = `${JUP}/swap/v1/quote?inputMint=${inputMint}&outputMint=${usdcMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&swapMode=ExactIn`;
  const response = await fetcher(url);
  if (!response.ok) return null;
  const raw = (await response.json()) as {
    inputMint?: string; inAmount?: string; outputMint?: string; outAmount?: string; otherAmountThreshold?: string;
    swapMode?: string; slippageBps?: number; platformFee?: { amount?: string } | null;
  };
  if (raw.inputMint !== inputMint || raw.outputMint !== usdcMint || raw.swapMode !== "ExactIn") return null;
  if (raw.inAmount !== amount.toString() || !raw.outAmount || !raw.otherAmountThreshold) return null;
  if (typeof raw.slippageBps !== "number" || raw.slippageBps > SLIPPAGE_BPS) return null;
  if (raw.platformFee && raw.platformFee.amount !== "0") return null;
  // The "at least" line on the review card is this number, so it must match the slippage we allow.
  const out = BigInt(raw.outAmount);
  const minimum = BigInt(raw.otherAmountThreshold);
  if (minimum > out || minimum * 10_000n < out * BigInt(10_000 - SLIPPAGE_BPS)) return null;
  return { inputMint, inAmount: raw.inAmount, outAmount: raw.outAmount, otherAmountThreshold: raw.otherAmountThreshold, raw };
}

function toIx(ix: JupIx) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

function readUint(bytes: Uint8Array, offset: number, size: number) {
  let value = 0n;
  for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

/** SetComputeUnitLimit and SetComputeUnitPrice only, at most once each, within the caps. */
function checkComputeBudget(instructions: JupIx[]) {
  const computeBudget = ComputeBudgetProgram.programId.toBase58();
  let limit: bigint | null = null;
  let price: bigint | null = null;
  for (const ix of instructions) {
    const data = Buffer.from(ix.data, "base64");
    if (ix.programId !== computeBudget || ix.accounts.length) throw new Error("Unexpected compute instruction.");
    if (data[0] === 2 && data.length === 5 && limit === null) limit = readUint(data, 1, 4);
    else if (data[0] === 3 && data.length === 9 && price === null) price = readUint(data, 1, 8);
    else throw new Error("Unexpected compute instruction.");
  }
  if (limit !== null && limit > BigInt(MAX_COMPUTE_UNITS)) throw new Error("Swap asks for too much compute.");
  if (price !== null && price > MAX_CU_PRICE_MICROLAMPORTS) throw new Error("Swap asks for too high a priority fee.");
  const units = limit ?? BigInt(MAX_COMPUTE_UNITS);
  const priorityFeeLamports = ((price ?? 0n) * units + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > MAX_PRIORITY_FEE_LAMPORTS) throw new Error("Swap asks for too high a priority fee.");
  return priorityFeeLamports;
}

/**
 * Refuses anything other than: compute budget within the fee caps, creating the
 * donor's own token accounts, one Jupiter route that pays the quoted amount into
 * the vault's USDC account with no platform fee, and closing the donor's own
 * temporary account. Throws with a plain reason; returns what it costs.
 */
export function assertSafeSwap(response: JupSwapInstructions, donor: string, accounts: SupportAccounts, quote: SwapQuote): SwapPlan {
  if (response.error) throw new Error("Jupiter couldn't build this swap.");
  if (response.tokenLedgerInstruction) throw new Error("Unexpected token-ledger swap mode.");
  if (response.otherInstructions?.length) throw new Error("Swap included extra instructions.");
  const priorityFeeLamports = checkComputeBudget(response.computeBudgetInstructions ?? []);

  const createsAccounts: SwapPlan["createsAccounts"] = [];
  for (const ix of response.setupInstructions ?? []) {
    // ATA create / createIdempotent: [payer, ata, owner, mint, system, token program]
    const keys = ix.accounts.map((a) => a.pubkey);
    const data = Buffer.from(ix.data, "base64");
    const tokenProgram = keys[5];
    const ok =
      ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() &&
      ix.accounts.length === 6 &&
      (data.length === 0 || (data.length === 1 && data[0] <= 1)) &&
      keys[0] === donor && keys[2] === donor && keys[4] === SYSTEM_PROGRAM_ID &&
      TOKEN_ACCOUNT_RENT[tokenProgram] !== undefined &&
      ix.accounts.every((a, i) => !a.isSigner || i === 0) &&
      keys[1] === PublicKey.findProgramAddressSync(
        [new PublicKey(donor).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(keys[3]).toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )[0].toBase58();
    if (!ok) throw new Error("Swap setup touches an account that isn't yours.");
    createsAccounts.push({ address: keys[1], rentLamports: TOKEN_ACCOUNT_RENT[tokenProgram] });
  }

  const swap = response.swapInstruction;
  if (swap.programId !== JUPITER_PROGRAM_ID) throw new Error("Swap isn't routed through Jupiter.");
  const decoded = decodeJupiterSwap(Buffer.from(swap.data, "base64"));
  const at = (name: string) => swap.accounts[decoded.accounts[name]];
  if (swap.accounts.length < Object.keys(decoded.accounts).length) throw new Error("Swap is missing accounts.");
  const destination = at("destination_token_account");
  if (destination.pubkey !== accounts.vaultUsdc.toBase58() || !destination.isWritable) {
    throw new Error("Swap doesn't deliver to the support vault.");
  }
  if (at("destination_mint").pubkey !== accounts.usdcMint.toBase58()) throw new Error("Swap doesn't output USDC.");
  if (decoded.kind === "shared_accounts_route" && at("source_mint").pubkey !== quote.inputMint) throw new Error("Swap spends a different token.");
  const authority = at("user_transfer_authority");
  if (authority.pubkey !== donor || !authority.isSigner) throw new Error("Swap isn't signed by your wallet.");
  // An unused optional account is passed as the Jupiter program id itself.
  if (decoded.platformFeeBps !== 0 || at("platform_fee_account").pubkey !== JUPITER_PROGRAM_ID) throw new Error("Swap charges a platform fee.");
  if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID].includes(at("token_program").pubkey)) throw new Error("Swap uses an unknown token program.");
  if (at("event_authority").pubkey !== JUPITER_EVENT_AUTHORITY || at("program").pubkey !== JUPITER_PROGRAM_ID) throw new Error("Swap isn't routed through Jupiter.");
  if (decoded.inAmount !== BigInt(quote.inAmount)) throw new Error("Swap spends a different amount than you approved.");
  if (decoded.quotedOutAmount !== BigInt(quote.outAmount)) throw new Error("Swap doesn't match the price you saw.");
  if (decoded.slippageBps > SLIPPAGE_BPS) throw new Error("Swap allows more slippage than shown.");
  const signers = swap.accounts.filter((a) => a.isSigner).map((a) => a.pubkey);
  if (signers.some((s) => s !== donor)) throw new Error("Swap asks for an unexpected signer.");

  const cleanup = response.cleanupInstruction;
  if (cleanup) {
    // Only closing the donor's own wrapped-SOL account, with lamports back to the donor.
    const data = Buffer.from(cleanup.data, "base64");
    const tokenProgram = cleanup.programId === TOKEN_PROGRAM_ID.toBase58() || cleanup.programId === TOKEN_2022_PROGRAM_ID;
    if (!tokenProgram || data.length !== 1 || data[0] !== 9 || cleanup.accounts[1]?.pubkey !== donor || cleanup.accounts[2]?.pubkey !== donor) {
      throw new Error("Swap cleanup sends funds somewhere unexpected.");
    }
  }
  return { priorityFeeLamports, createsAccounts };
}

/** Network fee + priority fee + rent for any new token account, in lamports. */
export function swapFeeLamports(plan: SwapPlan, existing: ReadonlySet<string>) {
  const rent = plan.createsAccounts.filter((a) => !existing.has(a.address)).reduce((sum, a) => sum + a.rentLamports, 0n);
  const newAccounts = plan.createsAccounts.filter((a) => !existing.has(a.address)).length;
  return { totalLamports: BASE_FEE_LAMPORTS + plan.priorityFeeLamports + rent, rentLamports: rent, newAccounts };
}

export type PreparedSwap = {
  quote: SwapQuote;
  instructions: TransactionInstruction[];
  lookupTables: string[];
  feeLamports: bigint;
  /** Part of the fee that opens token accounts in the donor's wallet (refundable by closing them). */
  rentLamports: bigint;
  newAccounts: number;
  preparedAt: number;
};

/**
 * Returns why a freshly built swap is worse for the donor than the one on screen,
 * or null when it's at least as good (same or higher minimum, same or lower fee).
 */
export function worseThanShown(shown: Pick<PreparedSwap, "quote" | "feeLamports">, fresh: Pick<PreparedSwap, "quote" | "feeLamports">) {
  if (BigInt(fresh.quote.otherAmountThreshold) < BigInt(shown.quote.otherAmountThreshold)) return "The price moved since you reviewed it.";
  if (fresh.feeLamports > shown.feeLamports) return "The network fee went up since you reviewed it.";
  return null;
}

export async function buildSwapTip(input: {
  donor: PublicKey;
  quote: SwapQuote;
  note: string;
  hideAddress: boolean;
  accounts: SupportAccounts;
  fetcher?: typeof fetch;
  /** Which of these addresses already exist on-chain (for the rent estimate). */
  existingAccounts?: (addresses: string[]) => Promise<Set<string>>;
  now?: () => number;
}): Promise<PreparedSwap> {
  const fetcher = input.fetcher ?? fetch;
  // Keep in step with frontend/test/fixtures/jupiter/capture.mjs.
  const response = await fetcher(`${JUP}/swap/v1/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: input.quote.raw,
      userPublicKey: input.donor.toBase58(),
      destinationTokenAccount: input.accounts.vaultUsdc.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Number(MAX_PRIORITY_FEE_LAMPORTS), priorityLevel: "medium" } },
    }),
  });
  if (!response.ok) throw new Error("Jupiter couldn't build this swap.");
  const body = (await response.json()) as JupSwapInstructions;
  const plan = assertSafeSwap(body, input.donor.toBase58(), input.accounts, input.quote);

  // Jupiter also creates token accounts the swap never touches (the donor's own
  // USDC account, when the output goes to the vault). Skip those: they only cost rent.
  const swapKeys = new Set(body.swapInstruction.accounts.map((a) => a.pubkey));
  const setup = (body.setupInstructions ?? []).filter((ix) => swapKeys.has(ix.accounts[1].pubkey));
  const used = { ...plan, createsAccounts: plan.createsAccounts.filter((a) => swapKeys.has(a.address)) };
  let existing = new Set<string>();
  if (used.createsAccounts.length && input.existingAccounts) {
    try {
      existing = await input.existingAccounts(used.createsAccounts.map((a) => a.address));
    } catch {
      // Unknown: show the worst case (rent for every account).
    }
  }
  const fee = swapFeeLamports(used, existing);

  const memo = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: input.donor, isSigner: true, isWritable: false }],
    data: Buffer.from(new TextEncoder().encode(buildMemo(input.note, input.hideAddress))),
  });
  const instructions = [
    ...(body.computeBudgetInstructions ?? []).map(toIx),
    ...setup.map(toIx),
    toIx(body.swapInstruction),
    ...(body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : []),
    memo,
    allocateIx("USDC", input.accounts),
  ];
  return {
    quote: input.quote,
    instructions,
    lookupTables: body.addressLookupTableAddresses ?? [],
    feeLamports: fee.totalLamports,
    rentLamports: fee.rentLamports,
    newAccounts: fee.newAccounts,
    preparedAt: (input.now ?? Date.now)(),
  };
}

/** Which of these accounts already exist, read through the support RPC (no account data). */
export async function existingAccounts(addresses: string[]) {
  const rpc = supportConnection();
  const found = new Set<string>();
  for (const address of addresses) {
    const info = await rpc.getAccountInfo(new PublicKey(address), { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } });
    if (info) found.add(address);
  }
  return found;
}

export async function signVersionedForSupport(
  wallet: ChainPayWallet,
  built: Pick<PreparedSwap, "instructions" | "lookupTables">,
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
