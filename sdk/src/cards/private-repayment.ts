/*
 * Private statement repayment through MagicBlock Private Payments
 * (contracts.md §7.3). Devnet USDC only.
 *
 * The flow, in the owner's browser or CLI:
 *   1. `prepare` asks ChainPay for an attempt: the exact amount, the simulated
 *      partner, and an opaque `clientRefId`.
 *   2. The owner reads the vault model (`privateRepaymentDisclosure`) and opts in.
 *   3. `payStatementPrivately` signs in to MagicBlock with the wallet, deposits
 *      any shortfall into MagicBlock's vault (a private balance on the TEE
 *      rollup), then sends one private transfer to the partner tagged with the
 *      reference. The owner's wallet signs everything; ChainPay never holds
 *      the MagicBlock token or a key.
 *   4. `submit` asks ChainPay to verify the partner's settlement on Solana.
 *
 * What ChainPay can verify: a finalized MagicBlock settlement paid exactly the
 * amount due, in Devnet USDC, from MagicBlock's vault to the partner, tagged
 * with this attempt's reference. What it cannot: who paid. The vault hides
 * that link by design, so the method never claims "paid by your wallet".
 */

import { PublicKey } from "@solana/web3.js";

export const MAGICBLOCK_PAYMENTS_API = "https://payments.magicblock.app";
export const PRIVATE_REPAYMENT_METHOD = "magicblock_private_payments";
export const PRIVATE_REPAYMENT_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const EPHEMERAL_SPL_PROGRAM = "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2";

export type PrivateRepaymentAttempt = {
  attemptId: string;
  state: "awaiting_settlement" | "verified" | "mismatch";
  method: typeof PRIVATE_REPAYMENT_METHOD;
  statementId: string;
  cluster: "devnet";
  apiCluster: "devnet-private";
  api: string;
  mint: string;
  amountCents: string;
  amountBaseUnits: string;
  recipientWallet: string;
  recipientTokenAccount: string;
  clientRefId: string;
  transfer: {
    visibility: "private";
    fromBalance: "ephemeral";
    toBalance: "base";
    split: 1;
    exactOut: true;
    minDelayMs: string;
    maxDelayMs: string;
    memo: null;
  };
  vault: { program: string; vault: string; vaultTokenAccount: string; custody: string };
  verification: {
    kind: "magicblock_queue_settlement";
    commitment: "finalized";
    checks: string[];
    notVerifiable: string[];
    public: string[];
    hidden: string[];
  };
  label: string;
};

export type PrivateRepaymentResult =
  | { state: "discharged" | "partner_confirmed" | "repayment_observed"; statement: unknown }
  | { state: "repayment_mismatch"; mismatch: string[]; statement: unknown };

export class PrivateRepaymentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "PrivateRepaymentError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

type Fetch = typeof fetch;

/** Refuse anything but the Devnet USDC private route ChainPay verifies. */
export function assertPayableAttempt(attempt: PrivateRepaymentAttempt): void {
  const problems: string[] = [];
  if (attempt.method !== PRIVATE_REPAYMENT_METHOD) problems.push("method");
  if (attempt.cluster !== "devnet" || attempt.apiCluster !== "devnet-private") problems.push("network");
  if (attempt.mint !== PRIVATE_REPAYMENT_DEVNET_USDC) problems.push("mint (Devnet USDC only)");
  if (attempt.state !== "awaiting_settlement") problems.push("attempt state");
  const t = attempt.transfer;
  if (!t || t.visibility !== "private" || t.fromBalance !== "ephemeral" || t.toBalance !== "base" || t.split !== 1 || t.exactOut !== true || t.memo !== null) {
    problems.push("transfer route");
  }
  if (!/^[1-9][0-9]{0,11}$/.test(attempt.clientRefId)) problems.push("reference");
  // The two amounts must be the same money: USDC has 6 decimals, so cents x 10 000.
  // The disclosure shows amountCents; the wallet would sign amountBaseUnits.
  if (!/^[1-9][0-9]{0,18}$/.test(attempt.amountBaseUnits) || !/^[1-9][0-9]{0,14}$/.test(attempt.amountCents ?? "") || BigInt(attempt.amountBaseUnits) !== BigInt(attempt.amountCents) * 10_000n) problems.push("amount");
  if (!isAddress(attempt.recipientWallet)) problems.push("recipient");
  if (problems.length) {
    throw new PrivateRepaymentError(400, "attempt_not_payable", `This attempt can't be paid privately: ${problems.join(", ")}`);
  }
}

/**
 * The vault and deposit model in plain words, for the opt-in step. Every line
 * is true of the route this module pays through; none claims more than
 * ChainPay verifies.
 */
export function privateRepaymentDisclosure(attempt: Pick<PrivateRepaymentAttempt, "amountBaseUnits" | "amountCents">): string[] {
  const dollars = formatCents(attempt.amountCents);
  return [
    `Your USDC moves into MagicBlock's shared vault first. Usually ChainPay leaves tokens in your account until a payment, but this one is different.`,
    `From the vault, ${dollars} goes privately to the card partner. The link between your wallet and that payout stays off the public chain.`,
    `What's still public: the deposit, the amount the partner receives, and when it lands. Matching amounts and times can still connect them.`,
    `ChainPay checks that the partner got exactly ${dollars} with this statement's reference. It can't check who paid, so it won't say "paid by your wallet."`,
    `Anything left in your private balance stays yours. You can withdraw it back to your wallet anytime.`,
    `Devnet test USDC only. No real money.`,
  ];
}

function formatCents(cents: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(cents)) return `${cents} cents`;
  const padded = cents.padStart(3, "0");
  return `$${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

// ------------------------------------------------------- ChainPay routes

export type ChainPayRoutesOptions = {
  /** Axum base URL, e.g. https://relay.example. */
  baseUrl: string;
  /** Owner session bearer. Never an MCP connection: agents can't repay. */
  ownerSession: string;
  fetch?: Fetch;
};

async function chainpay<T>(opts: ChainPayRoutesOptions, path: string, body: unknown): Promise<T> {
  const f = opts.fetch ?? fetch;
  const response = await f(`${opts.baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.ownerSession}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!response.ok) {
    throw new PrivateRepaymentError(response.status, json?.code ?? "chainpay_error", json?.message ?? `ChainPay request failed (${response.status})`, json?.retryable === true);
  }
  return json as T;
}

function statementPath(cardId: string, statementId: string): string {
  return `/v1/cards/${encodeURIComponent(cardId)}/statements/${encodeURIComponent(statementId)}`;
}

/** Get or create the open attempt (idempotent). */
export function preparePrivateRepayment(opts: ChainPayRoutesOptions, cardId: string, statementId: string, clientOperationId: string): Promise<PrivateRepaymentAttempt> {
  return chainpay(opts, `${statementPath(cardId, statementId)}/repayment/private`, { clientOperationId });
}

/**
 * Ask ChainPay to verify the settlement. A `settlement_pending` error is
 * retryable: MagicBlock's queue pays out after the transfer, usually within
 * seconds.
 */
export function submitPrivateRepayment(opts: ChainPayRoutesOptions, cardId: string, statementId: string, attemptId: string): Promise<PrivateRepaymentResult> {
  return chainpay(opts, `${statementPath(cardId, statementId)}/repayment`, { method: PRIVATE_REPAYMENT_METHOD, attemptId, cluster: "devnet" });
}

/** Poll `submit` until the settlement is found (or `timeoutMs` passes). */
export async function waitForPrivateRepayment(
  opts: ChainPayRoutesOptions,
  cardId: string,
  statementId: string,
  attemptId: string,
  { timeoutMs = 90_000, intervalMs = 4_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<PrivateRepaymentResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await submitPrivateRepayment(opts, cardId, statementId, attemptId);
    } catch (error) {
      const pending = error instanceof PrivateRepaymentError && error.code === "settlement_pending";
      if (!pending || Date.now() + intervalMs > deadline) throw error;
      await sleep(intervalMs);
    }
  }
}

// --------------------------------------------------- MagicBlock (hosted API)

/** The owner's wallet. Transactions travel as base64 wire bytes. */
export type PrivateRepaymentSigner = {
  publicKey: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Sign (not send) a serialized transaction; return the signed base64. */
  signTransaction(transactionBase64: string): Promise<string>;
};

export type MagicBlockOptions = { api?: string; fetch?: Fetch };

type Built = {
  kind: string;
  transactionBase64: string;
  sendTo: "base" | "ephemeral";
  sendRpcEndpoint?: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  requiredSigners: string[];
  fees?: { lamports: string; tokens: string };
};

async function magicblock<T>(opts: MagicBlockOptions, method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<T> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await f(`${(opts.api ?? MAGICBLOCK_PAYMENTS_API).replace(/\/$/, "")}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!response.ok) {
    // Never echo URLs or headers: a tokenized RPC URL must not reach logs.
    throw new PrivateRepaymentError(response.status, json?.error?.code ?? "magicblock_error", json?.error?.message ?? `MagicBlock request failed (${response.status})`, response.status >= 500);
  }
  return json as T;
}

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/**
 * Wallet challenge login for private reads and rollup sends. The token lives
 * in memory only: never store it, log it or send it to ChainPay.
 */
export async function magicblockLogin(signer: PrivateRepaymentSigner, opts: MagicBlockOptions = {}): Promise<string> {
  const q = new URLSearchParams({ pubkey: signer.publicKey, cluster: "devnet-private" });
  const { challenge } = await magicblock<{ challenge: string }>(opts, "GET", `/v1/spl/challenge?${q}`);
  const signature = base58(await signer.signMessage(new TextEncoder().encode(challenge)));
  const { token } = await magicblock<{ token: string }>(opts, "POST", "/v1/spl/login", { pubkey: signer.publicKey, challenge, signature, cluster: "devnet-private" });
  return token;
}

export async function privateBalance(owner: string, mint: string, token: string, opts: MagicBlockOptions = {}): Promise<bigint> {
  const q = new URLSearchParams({ address: owner, mint, cluster: "devnet-private" });
  const row = await magicblock<{ balance: string }>(opts, "GET", `/v1/spl/private-balance?${q}`, undefined, token);
  return BigInt(row.balance);
}

function checkBuilt(built: Built, owner: string, kind: string): void {
  if (built.kind !== kind || built.requiredSigners.length !== 1 || built.requiredSigners[0] !== owner) {
    throw new PrivateRepaymentError(502, "unexpected_transaction", `MagicBlock returned an unexpected ${kind} transaction; nothing was signed`);
  }
}

// ------------------------------------------ what the owner is asked to sign

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const PERMISSION_PROGRAM = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";
const MAGIC_PROGRAM = "Magic11111111111111111111111111111111111111";
/** Rent and fees only: a built transaction may move at most this much SOL. */
const MAX_LAMPORTS = 50_000_000n;

/**
 * Ephemeral SPL Token instruction tags (magicblock-labs/ephemeral-spl-token,
 * e-token-api/src/instruction.rs). Anything else in a built transaction is
 * refused: withdrawals, shuttles to a cleartext destination, stealth pools.
 */
const ESPL = {
  initializeEphemeralAta: 0,
  initializeGlobalVault: 1,
  depositSplTokens: 2,
  delegateEphemeralAta: 4,
  createEphemeralAtaPermission: 6,
  delegateEphemeralAtaPermission: 7,
  initializeShuttleEphemeralAta: 11,
  delegateShuttleEphemeralAta: 13,
  depositAndQueueTransfer: 16,
  setupAndDelegateShuttleEphemeralAtaWithMerge: 24,
  ensureTransferQueueCrank: 17,
  depositAndDelegateShuttleWithMergeToEncryptedDestination: 34,
} as const;
const DEPOSIT_TAGS: readonly number[] = [0, 1, 2, 4, 6, 7, 11, 13, 24, 34];
const TRANSFER_TAGS: readonly number[] = [0, 16, 17];

type DecodedInstruction = { programId: string; accounts: string[]; data: Uint8Array };
type DecodedTransaction = { signers: string[]; instructions: DecodedInstruction[] };

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text: string): Uint8Array | null {
  let n = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const char of text) { if (char !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

function isAddress(value: unknown): boolean {
  return typeof value === "string" && base58Decode(value)?.length === 32;
}

function fromBase64(text: string): Uint8Array {
  const binary = globalThis.atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function u64(data: Uint8Array, at: number): bigint {
  if (data.length < at + 8) throw new Error("truncated");
  let out = 0n;
  for (let i = 7; i >= 0; i -= 1) out = (out << 8n) | BigInt(data[at + i]);
  return out;
}

/**
 * Decode a serialized legacy (or v0 without lookup tables) transaction: its
 * signers and every instruction with resolved account keys. Lookup tables
 * can't be checked offline, so they are refused.
 */
export function decodeBuiltTransaction(base64: string): DecodedTransaction {
  const bytes = fromBase64(base64);
  let at = 0;
  const byte = () => { if (at >= bytes.length) throw new Error("truncated"); return bytes[at++]; };
  const compact = () => { let value = 0; for (let shift = 0; shift < 21; shift += 7) { const b = byte(); value |= (b & 0x7f) << shift; if (!(b & 0x80)) return value; } throw new Error("bad length"); };
  const take = (n: number) => { if (at + n > bytes.length) throw new Error("truncated"); const out = bytes.slice(at, at + n); at += n; return out; };
  take(compact() * 64);
  const versioned = (bytes[at] & 0x80) !== 0;
  if (versioned && byte() !== 0x80) throw new Error("unsupported version");
  const [required] = [byte(), byte(), byte()];
  const keys = Array.from({ length: compact() }, () => base58(take(32)));
  take(32); // recent blockhash
  const instructions = Array.from({ length: compact() }, () => {
    const program = keys[byte()];
    const accounts = Array.from({ length: compact() }, () => keys[byte()]);
    const data = take(compact());
    if (!program || accounts.some((key) => key === undefined)) throw new Error("account index out of range");
    return { programId: program, accounts, data };
  });
  if (versioned && compact() !== 0) throw new Error("address lookup tables can't be checked");
  if (at !== bytes.length) throw new Error("trailing bytes");
  return { signers: keys.slice(0, required), instructions };
}

function refuse(kind: string, why: string): never {
  throw new PrivateRepaymentError(502, "unexpected_transaction", `MagicBlock's ${kind} transaction ${why}; nothing was signed`);
}

/**
 * Before the owner signs a MagicBlock-built transaction, check it does
 * exactly what the statement says (review F1): only the expected programs,
 * the owner as the only signer, and the one amount-bearing instruction moving
 * the expected amount of the attempt's mint (to the attempt's recipient, for
 * the transfer).
 */
export function verifyBuiltTransaction(
  built: Pick<Built, "transactionBase64">,
  expect: { kind: "deposit" | "transfer"; owner: string; mint: string; amountBaseUnits: bigint; recipientWallet?: string; clientRefId?: string; minDelayMs?: string; maxDelayMs?: string },
): void {
  const { kind } = expect;
  let tx: DecodedTransaction;
  try { tx = decodeBuiltTransaction(built.transactionBase64); } catch { refuse(kind, "could not be read"); }
  if (tx.signers.length !== 1 || tx.signers[0] !== expect.owner) refuse(kind, "asks for a signer other than your wallet");
  const allowed = new Set([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, EPHEMERAL_SPL_PROGRAM, DELEGATION_PROGRAM, PERMISSION_PROGRAM, MAGIC_PROGRAM]);
  const tags = kind === "deposit" ? DEPOSIT_TAGS : TRANSFER_TAGS;
  let lamports = 0n;
  const moves: DecodedInstruction[] = [];
  for (const ix of tx.instructions) {
    // SPL Token at the top level could transfer or approve anything: never.
    if (!allowed.has(ix.programId)) refuse(kind, "calls a program ChainPay doesn't expect");
    if (ix.programId === SYSTEM_PROGRAM && ix.data.length >= 12 && ix.data[0] === 2 && ix.data[1] === 0 && ix.data[2] === 0 && ix.data[3] === 0) lamports += u64(ix.data, 4);
    if (ix.programId !== EPHEMERAL_SPL_PROGRAM) continue;
    if (!ix.data.length || !tags.includes(ix.data[0])) refuse(kind, "includes a token instruction ChainPay doesn't expect");
    if ([ESPL.depositSplTokens, ESPL.depositAndQueueTransfer, ESPL.setupAndDelegateShuttleEphemeralAtaWithMerge, ESPL.depositAndDelegateShuttleWithMergeToEncryptedDestination].includes(ix.data[0] as 2)) moves.push(ix);
  }
  if (lamports > MAX_LAMPORTS) refuse(kind, "moves more SOL than rent needs");
  if (moves.length !== 1) refuse(kind, "doesn't move exactly one amount");
  const [move] = moves;
  try {
    if (move.data[0] === ESPL.depositSplTokens) {
      // [tag][amount u64]; accounts: eata, vault, mint, source, vault token, authority, token program
      if (move.data.length !== 9 || move.accounts[2] !== expect.mint || move.accounts[5] !== expect.owner) refuse(kind, "deposits from the wrong account or mint");
      if (u64(move.data, 1) !== expect.amountBaseUnits) refuse(kind, "deposits a different amount");
    } else if (move.data[0] === ESPL.setupAndDelegateShuttleEphemeralAtaWithMerge) {
      if (kind !== "deposit") refuse(kind, "is not a transfer");
      checkShuttleDepositWithMerge(move, expect, kind);
    } else if (move.data[0] === ESPL.depositAndDelegateShuttleWithMergeToEncryptedDestination) {
      // [tag][shuttle u32][amount u64]...; accounts: payer .. shuttle owner(5) .. mint(13)
      if (move.accounts[0] !== expect.owner || move.accounts[5] !== expect.owner || move.accounts[13] !== expect.mint) refuse(kind, "deposits from the wrong account or mint");
      if (u64(move.data, 5) !== expect.amountBaseUnits) refuse(kind, "deposits a different amount");
    } else {
      // [tag][amount u64][group 3][min u64][max u64][split u32][flags u8?][clientRefId u64?]
      // accounts: queue, vault, mint(2), source, vault token, destination owner(5), sender(6), ...
      if (kind !== "transfer") refuse(kind, "is not a deposit");
      if (move.accounts[2] !== expect.mint || move.accounts[5] !== expect.recipientWallet || move.accounts[6] !== expect.owner) refuse(kind, "pays a different recipient or mint");
      if (u64(move.data, 1) !== expect.amountBaseUnits) refuse(kind, "pays a different amount");
      const split = move.data[28] | (move.data[29] << 8) | (move.data[30] << 16) | (move.data[31] << 24);
      if (split !== 1) refuse(kind, "splits the payment");
      if (expect.minDelayMs !== undefined && u64(move.data, 12) !== BigInt(expect.minDelayMs)) refuse(kind, "uses a different delay");
      if (expect.maxDelayMs !== undefined && u64(move.data, 20) !== BigInt(expect.maxDelayMs)) refuse(kind, "uses a different delay");
      if (move.data.length !== 40 && move.data.length !== 41) refuse(kind, "carries no statement reference");
      if (u64(move.data, move.data.length - 8).toString() !== expect.clientRefId) refuse(kind, "carries a different statement reference");
    }
  } catch (error) {
    if (error instanceof PrivateRepaymentError) throw error;
    refuse(kind, "could not be read");
  }
}

function associatedTokenAccount(owner: string, mint: string, allowOffCurve = false): string {
  const ownerKey = new PublicKey(owner);
  if (!allowOffCurve && !PublicKey.isOnCurve(ownerKey.toBytes())) throw new Error("owner is off curve");
  return PublicKey.findProgramAddressSync(
    [ownerKey.toBuffer(), new PublicKey(SPL_TOKEN_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  )[0].toBase58();
}

/**
 * Ephemeral SPL tag 24, `SetupAndDelegateShuttleEphemeralAtaWithMerge`
 * (e-token/src/processor/deposit_and_delegate_shuttle_ephemeral_ata_with_merge.rs;
 * built by `delegateSpl` in @magicblock-labs/ephemeral-rollups-sdk 0.17.3).
 * It moves `amount` from the owner's token account into MagicBlock's vault and
 * merges it, on the rollup, into `destination`. For a deposit to the owner's
 * own private balance, source and destination are both the owner's USDC ATA.
 *
 * Data: [24][shuttle_id u32][amount u64][validator 32?] (13 or 45 bytes).
 * Accounts: 0 payer (signer), 1 rent PDA, 2 shuttle metadata, 3 shuttle EATA,
 * 4 shuttle wallet ATA, 5 shuttle owner (signer), 6 owner program (ESPL),
 * 7 buffer, 8 delegation record, 9 delegation metadata, 10 delegation program,
 * 11 associated token program, 12 system program, 13 destination token account,
 * 14 mint, 15 token program, 16 global vault, 17 owner source token account,
 * 18 vault token account.
 */
function checkShuttleDepositWithMerge(move: DecodedInstruction, expect: { owner: string; mint: string; amountBaseUnits: bigint }, kind: string): void {
  if (move.data.length !== 13 && move.data.length !== 45) refuse(kind, "has an unexpected deposit layout");
  if (move.accounts.length !== 19) refuse(kind, "has an unexpected deposit layout");
  const a = move.accounts;
  if (a[0] !== expect.owner || a[5] !== expect.owner) refuse(kind, "deposits for a different owner");
  if (a[14] !== expect.mint || a[15] !== SPL_TOKEN_PROGRAM) refuse(kind, "deposits from the wrong account or mint");
  if (a[6] !== EPHEMERAL_SPL_PROGRAM || a[10] !== DELEGATION_PROGRAM || a[11] !== ASSOCIATED_TOKEN_PROGRAM || a[12] !== SYSTEM_PROGRAM) refuse(kind, "has an unexpected deposit layout");
  const ownerAta = associatedTokenAccount(expect.owner, expect.mint);
  // The rollup merge credits `destination`: anything but the owner's own
  // account would hand the deposit to someone else.
  if (a[17] !== ownerAta) refuse(kind, "deposits from the wrong account or mint");
  if (a[13] !== ownerAta) refuse(kind, "deposits into someone else's balance");
  const vault = PublicKey.findProgramAddressSync([new PublicKey(expect.mint).toBuffer()], new PublicKey(EPHEMERAL_SPL_PROGRAM))[0].toBase58();
  if (a[16] !== vault || a[18] !== associatedTokenAccount(vault, expect.mint, true)) refuse(kind, "deposits into a vault ChainPay doesn't expect");
  if (u64(move.data, 5) !== expect.amountBaseUnits) refuse(kind, "deposits a different amount");
}

export type PayStep =
  | { step: "login" }
  | { step: "balance"; privateBalance: string }
  | { step: "deposit"; amountBaseUnits: string; signature?: string }
  | { step: "transfer"; signature?: string; outcome: "sent" | "unknown" };

export type PayPrivatelyInput = {
  attempt: PrivateRepaymentAttempt;
  signer: PrivateRepaymentSigner;
  /**
   * Submit a signed base-layer (Devnet) transaction and resolve with its
   * signature once confirmed. The browser passes its wallet adapter's
   * connection; MagicBlock's own send endpoint is the fallback.
   */
  sendBase?: (signedBase64: string, built: { recentBlockhash: string; lastValidBlockHeight: number }) => Promise<string>;
  onStep?: (step: PayStep) => void;
  magicblock?: MagicBlockOptions;
  /** Poll for the deposit to show up as private balance. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

async function sendViaApi(opts: MagicBlockOptions, built: Built, signed: string, token: string): Promise<string> {
  const result = await magicblock<{ signature: string; confirmed?: boolean }>(opts, "POST", "/v1/transaction/send", {
    transactionBase64: signed,
    sendTo: built.sendTo,
    sendRpcEndpoint: built.sendRpcEndpoint,
    confirm: true,
    recentBlockhash: built.recentBlockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
  }, token);
  return result.signature;
}

/**
 * Pay the attempt privately: deposit any shortfall into MagicBlock's vault,
 * then one private transfer to the partner tagged with the attempt reference.
 * Call only after the owner opted in on `privateRepaymentDisclosure`.
 *
 * A rollup send can report an error even though the transfer landed (seen
 * live on Devnet: "block height exceeded" for a transfer that settled), so a
 * failed transfer send resolves as `outcome: "unknown"`; ask ChainPay
 * (`waitForPrivateRepayment`) before paying again.
 */
export async function payStatementPrivately(input: PayPrivatelyInput): Promise<{ depositSignature?: string; transferSignature?: string; transferOutcome: "sent" | "unknown" }> {
  const { attempt, signer, onStep } = input;
  assertPayableAttempt(attempt);
  const opts = input.magicblock ?? {};
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const owner = signer.publicKey;
  const amount = BigInt(attempt.amountBaseUnits);

  onStep?.({ step: "login" });
  const token = await magicblockLogin(signer, opts);
  let balance = await privateBalance(owner, attempt.mint, token, opts);
  onStep?.({ step: "balance", privateBalance: balance.toString() });

  let depositSignature: string | undefined;
  if (balance < amount) {
    const shortfall = amount - balance;
    const built = await magicblock<Built>(opts, "POST", "/v1/spl/deposit", {
      owner,
      amount: Number(shortfall),
      mint: attempt.mint,
      cluster: "devnet-private",
      initIfMissing: true,
      initVaultIfMissing: true,
      initAtasIfMissing: true,
      idempotent: true,
      private: true,
    }, token);
    checkBuilt(built, owner, "deposit");
    verifyBuiltTransaction(built, { kind: "deposit", owner, mint: attempt.mint, amountBaseUnits: shortfall });
    onStep?.({ step: "deposit", amountBaseUnits: shortfall.toString() });
    const signed = await signer.signTransaction(built.transactionBase64);
    depositSignature = built.sendTo === "base" && input.sendBase
      ? await input.sendBase(signed, built)
      : await sendViaApi(opts, built, signed, token);
    onStep?.({ step: "deposit", amountBaseUnits: shortfall.toString(), signature: depositSignature });
    const deadline = Date.now() + (input.waitMs ?? 60_000);
    while (balance < amount) {
      if (Date.now() > deadline) {
        throw new PrivateRepaymentError(504, "deposit_pending", "Your deposit hasn't reached your private balance yet. Nothing was paid; try again in a minute.", true);
      }
      await sleep(2_000);
      balance = await privateBalance(owner, attempt.mint, token, opts);
    }
  }

  const t = attempt.transfer;
  const built = await magicblock<Built>(opts, "POST", "/v1/spl/transfer", {
    from: owner,
    to: attempt.recipientWallet,
    mint: attempt.mint,
    amount: Number(amount),
    visibility: t.visibility,
    fromBalance: t.fromBalance,
    toBalance: t.toBalance,
    cluster: "devnet-private",
    initIfMissing: true,
    initAtasIfMissing: true,
    initVaultIfMissing: false,
    clientRefId: attempt.clientRefId,
    exactOut: t.exactOut,
    split: t.split,
    minDelayMs: t.minDelayMs,
    maxDelayMs: t.maxDelayMs,
    legacy: true,
  }, token);
  checkBuilt(built, owner, "transfer");
  verifyBuiltTransaction(built, { kind: "transfer", owner, mint: attempt.mint, amountBaseUnits: amount, recipientWallet: attempt.recipientWallet, clientRefId: attempt.clientRefId, minDelayMs: t.minDelayMs, maxDelayMs: t.maxDelayMs });
  if (built.fees && built.fees.tokens !== "0") {
    throw new PrivateRepaymentError(502, "unexpected_fee", "MagicBlock quoted a token fee for this transfer; nothing was signed");
  }
  const signed = await signer.signTransaction(built.transactionBase64);
  try {
    const transferSignature = built.sendTo === "base" && input.sendBase
      ? await input.sendBase(signed, built)
      : await sendViaApi(opts, built, signed, token);
    onStep?.({ step: "transfer", signature: transferSignature, outcome: "sent" });
    return { depositSignature, transferSignature, transferOutcome: "sent" };
  } catch {
    onStep?.({ step: "transfer", outcome: "unknown" });
    return { depositSignature, transferOutcome: "unknown" };
  }
}
