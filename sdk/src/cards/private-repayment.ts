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
  if (!/^[1-9][0-9]{0,18}$/.test(attempt.amountBaseUnits)) problems.push("amount");
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
