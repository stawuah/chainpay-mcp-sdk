// Pure parsing for the support tracker. No Convex imports, so every rule here
// is unit-tested with plain fixtures.
//
// Rules (from the splitter audit):
// - Only finalized, successful transactions count. Failed ones are ignored.
// - Amounts come from the vault's pre/post balances, never from memos.
// - Payout sides come from `Paid` events, accepted only when the splitter
//   program itself emitted them (a forged log line from another program counts for nothing).
// - The donor is the transfer source (SOL) or transfer authority (USDC), never the fee payer.
//   Exception: a swapped tip's USDC comes from a pool, so it's credited to the tx's single
//   signer when our memo is present, and to nobody otherwise.

export type Asset = "SOL" | "USDC";
export type Side = "A" | "B";
export type SupportEvent = {
  kind: "contribution" | "payout" | "funding" | "anomaly";
  asset: Asset;
  /** Exact base units (lamports or USDC micro-units) as a decimal string. */
  amount: string;
  donor: string | null;
  note: string | null;
  side: Side | null;
};
export type ParsedSupportTx = { signature: string; slot: number; blockTime: number | null; events: SupportEvent[] };
export type SupportAccounts = { programId: string; vault: string; vaultUsdc: string };

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_PREFIX = "chainpay-support:v1";
export const NOTE_MAX = 80;

// sha256("event:<Name>")[0..8]
const PAID = [240, 193, 17, 238, 238, 210, 129, 235];
const VAULT_INITIALIZED = [180, 43, 207, 2, 18, 71, 3, 75];

// Minimal shape of getTransaction(..., { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).
type ParsedIx = { program?: string; programId?: string; parsed?: unknown };
type TokenBalance = { accountIndex: number; mint?: string; uiTokenAmount?: { amount?: string } };
export type RpcTransaction = {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    preBalances: (number | string)[];
    postBalances: (number | string)[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    innerInstructions?: { index: number; instructions: ParsedIx[] }[] | null;
    logMessages?: string[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: ({ pubkey: string; signer?: boolean } | string)[]; instructions: ParsedIx[] };
  };
};

const key = (k: { pubkey: string } | string) => (typeof k === "string" ? k : k.pubkey);
const big = (v: number | string | undefined) => BigInt(typeof v === "number" ? Math.trunc(v) : (v ?? "0"));

/** `chainpay-support:v1[ anon=1][ note=<text>]` → flags. Anything else → no note, not anonymous. */
export function parseSupportMemo(memo: string | null | undefined): { anon: boolean; note: string | null } {
  if (typeof memo !== "string" || !(memo === MEMO_PREFIX || memo.startsWith(MEMO_PREFIX + " "))) return { anon: false, note: null };
  let rest = memo.slice(MEMO_PREFIX.length);
  let anon = false;
  if (rest.startsWith(" anon=1")) {
    anon = true;
    rest = rest.slice(" anon=1".length);
  }
  let note: string | null = null;
  if (rest.startsWith(" note=")) {
    // Strip C0/C1 controls (incl. newlines, bidi isn't stripped but React renders it as text).
    const clean = rest.slice(" note=".length).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
    note = clean ? Array.from(clean).slice(0, NOTE_MAX).join("") : null;
  }
  return { anon, note };
}

function base64Bytes(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b);

/** Anchor events emitted by `programId` itself, tracked through the invoke stack in the logs. */
export function splitterEvents(logs: string[], programId: string): { paid: { asset: Asset; side: Side; amount: bigint }[]; initialized: boolean } {
  const stack: string[] = [];
  const paid: { asset: Asset; side: Side; amount: bigint }[] = [];
  let initialized = false;
  for (const line of logs) {
    const invoke = line.match(/^Program (\w+) invoke \[\d+\]$/);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    const data = line.match(/^Program data: (.+)$/);
    if (!data || stack[stack.length - 1] !== programId) continue;
    const bytes = base64Bytes(data[1]);
    if (!bytes) continue;
    if (startsWith(bytes, PAID) && bytes.length >= 8 + 1 + 1 + 8 + 32 && bytes[8] <= 1 && bytes[9] <= 1) {
      paid.push({ asset: bytes[8] === 0 ? "SOL" : "USDC", side: bytes[9] === 0 ? "A" : "B", amount: readU64(bytes, 10) });
    } else if (startsWith(bytes, VAULT_INITIALIZED)) {
      initialized = true;
    }
  }
  return { paid, initialized };
}

function allInstructions(tx: RpcTransaction): ParsedIx[] {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  return [...tx.transaction.message.instructions, ...inner];
}

type Transfer = { asset: Asset; donor: string | null; amount: bigint };

/** Transfers into the vault found in top-level and inner instructions. */
export function transfersIntoVault(tx: RpcTransaction, accounts: SupportAccounts): Transfer[] {
  const found: Transfer[] = [];
  for (const ix of allInstructions(tx)) {
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    if (!parsed || typeof parsed !== "object" || !parsed.info) continue;
    const info = parsed.info;
    if (ix.program === "system" && parsed.type === "transfer" && info.destination === accounts.vault) {
      found.push({ asset: "SOL", donor: typeof info.source === "string" ? info.source : null, amount: big(info.lamports as number | string) });
    }
    if (ix.program === "spl-token" && (parsed.type === "transfer" || parsed.type === "transferChecked") && info.destination === accounts.vaultUsdc) {
      const amount = parsed.type === "transferChecked" ? (info.tokenAmount as { amount?: string } | undefined)?.amount : (info.amount as string | undefined);
      const authority = (info.authority ?? info.multisigAuthority) as unknown;
      found.push({ asset: "USDC", donor: typeof authority === "string" ? authority : null, amount: big(amount) });
    }
  }
  return found;
}

function memoText(tx: RpcTransaction): string | null {
  for (const ix of allInstructions(tx)) {
    if ((ix.programId === MEMO_PROGRAM_ID || ix.program === "spl-memo") && typeof ix.parsed === "string") return ix.parsed;
  }
  return null;
}

function balanceDelta(tx: RpcTransaction, address: string, asset: Asset): bigint {
  const meta = tx.meta!;
  const index = tx.transaction.message.accountKeys.findIndex((k) => key(k) === address);
  if (index < 0) return 0n;
  if (asset === "SOL") return big(meta.postBalances[index]) - big(meta.preBalances[index]);
  const amount = (list?: TokenBalance[] | null) => big(list?.find((b) => b.accountIndex === index)?.uiTokenAmount?.amount);
  return amount(meta.postTokenBalances) - amount(meta.preTokenBalances);
}

/** Classifies one transaction. Returns null for failed or unusable transactions. */
export function parseSupportTx(tx: RpcTransaction | null, accounts: SupportAccounts): ParsedSupportTx | null {
  if (!tx || !tx.meta || tx.meta.err !== null) return null;
  const signature = tx.transaction.signatures[0];
  const signers = new Set(tx.transaction.message.accountKeys.filter((k) => typeof k !== "string" && k.signer).map(key));
  const { paid, initialized } = splitterEvents(tx.meta.logMessages ?? [], accounts.programId);
  const memo = memoText(tx);
  const hasSupportMemo = typeof memo === "string" && memo.startsWith("chainpay-support:v1");
  const { anon, note } = parseSupportMemo(memo);
  const transfers = transfersIntoVault(tx, accounts);
  const events: SupportEvent[] = [];

  for (const asset of ["SOL", "USDC"] as Asset[]) {
    const payouts = paid.filter((p) => p.asset === asset);
    const paidOut = payouts.reduce((sum, p) => sum + p.amount, 0n);
    for (const p of payouts) events.push({ kind: "payout", asset, amount: p.amount.toString(), donor: null, note: null, side: p.side });

    // What came in = net change + what the program paid out in this tx.
    const delta = balanceDelta(tx, asset === "SOL" ? accounts.vault : accounts.vaultUsdc, asset);
    const inflow = delta + paidOut;
    if (inflow < 0n) {
      events.push({ kind: "anomaly", asset, amount: (-inflow).toString(), donor: null, note: null, side: null });
      continue;
    }
    if (inflow === 0n) continue;
    if (initialized && asset === "SOL") {
      events.push({ kind: "funding", asset, amount: inflow.toString(), donor: null, note: null, side: null });
      continue;
    }

    const mine = transfers.filter((t) => t.asset === asset);
    const attributed = mine.reduce((sum, t) => sum + t.amount, 0n);
    if (attributed > inflow) {
      // Instructions claim more than the balance shows: trust the balance.
      events.push({ kind: "contribution", asset, amount: inflow.toString(), donor: null, note: null, side: null });
      continue;
    }
    for (const t of mine) {
      if (t.amount === 0n) continue;
      // Notes and the hide flag belong to whoever signed the transaction.
      let donor = t.donor;
      if (asset === "USDC" && donor !== null && !signers.has(donor)) {
        // A swapped tip (any token -> USDC via Jupiter) arrives from a pool
        // account, not from the tipper. Credit the tx's single signer when the
        // tx carries our memo; otherwise don't name a pool as a supporter.
        donor = hasSupportMemo && signers.size === 1 ? [...signers][0] : null;
      }
      const signed = donor !== null && signers.has(donor);
      events.push({ kind: "contribution", asset, amount: t.amount.toString(), donor: signed && anon ? null : donor, note: signed ? note : null, side: null });
    }
    if (inflow > attributed) {
      events.push({ kind: "contribution", asset, amount: (inflow - attributed).toString(), donor: null, note: null, side: null });
    }
  }
  return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, events };
}

// ---------- paging ----------
//
// getSignaturesForAddress returns newest first. `newest` is the newest signature
// whose whole history below it is stored. While catching up across several pages
// (or several runs), `pending` remembers where the backlog walk is.
export type SupportCursor = { newest: string | null; pending: { top: string; before: string } | null };
export type SignatureInfo = { signature: string; err: unknown };

export function planPage(cursor: SupportCursor): { before?: string; until?: string } {
  return {
    ...(cursor.pending ? { before: cursor.pending.before } : {}),
    ...(cursor.newest ? { until: cursor.newest } : {}),
  };
}

export function advanceCursor(cursor: SupportCursor, page: SignatureInfo[], limit: number): SupportCursor {
  if (page.length === 0) return cursor.pending ? { newest: cursor.pending.top, pending: null } : cursor;
  const top = cursor.pending?.top ?? page[0].signature;
  if (page.length < limit) return { newest: top, pending: null };
  return { newest: cursor.newest, pending: { top, before: page[page.length - 1].signature } };
}

// ---------- public summary ----------

export type StoredEvent = SupportEvent & { signature: string; blockTime: number | null; slot: number };

export function summarize(rows: StoredEvent[], live: boolean) {
  const zero = () => ({ contributed: 0n, paidA: 0n, paidB: 0n });
  const totals = { SOL: zero(), USDC: zero() };
  for (const row of rows) {
    const amount = BigInt(row.amount);
    if (row.kind === "contribution") totals[row.asset].contributed += amount;
    if (row.kind === "payout") totals[row.asset][row.side === "A" ? "paidA" : "paidB"] += amount;
  }
  const newestFirst = [...rows].sort((a, b) => b.slot - a.slot);
  const strings = (t: ReturnType<typeof zero>) => ({ contributed: t.contributed.toString(), paidA: t.paidA.toString(), paidB: t.paidB.toString() });
  const pick = (row: StoredEvent) => ({ signature: row.signature, asset: row.asset, amount: row.amount, blockTime: row.blockTime });
  return {
    live,
    totals: { sol: strings(totals.SOL), usdc: strings(totals.USDC) },
    contributionCount: rows.filter((r) => r.kind === "contribution").length,
    recent: newestFirst.filter((r) => r.kind === "contribution").slice(0, 25).map((r) => ({ ...pick(r), donor: r.donor, note: r.note })),
    recentPayouts: newestFirst.filter((r) => r.kind === "payout").slice(0, 10).map((r) => ({ ...pick(r), side: r.side })),
  };
}

// --- Server config (Devnet-only release, audit 2026-10-05 R4) ---------------
// The tracker, the browser relay and the web page must all point at the same
// Devnet program, vault and mint. Anything else fails closed.
export const SUPPORT_DEVNET = {
  cluster: "devnet",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
} as const;

export type SupportEnv = Partial<Record<"SUPPORT_CLUSTER" | "SUPPORT_RPC_URL" | "SUPPORT_PROGRAM_ID" | "SUPPORT_VAULT" | "SUPPORT_VAULT_USDC", string>>;
export type SupportServerConfig = { rpc: string; accounts: SupportAccounts };

const isAddress = (value: string | undefined): value is string => !!value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && !/^1+$/.test(value);

/** The tracker's config, or why it can't run. Only SUPPORT_CLUSTER=devnet is accepted in this release. */
export function supportServerConfig(env: SupportEnv): { ok: true; config: SupportServerConfig } | { ok: false; reason: string } {
  const { SUPPORT_CLUSTER: cluster, SUPPORT_RPC_URL: rpc, SUPPORT_PROGRAM_ID: programId, SUPPORT_VAULT: vault, SUPPORT_VAULT_USDC: vaultUsdc } = env;
  if (!rpc || !programId || !vault || !vaultUsdc) return { ok: false, reason: "SUPPORT_RPC_URL, SUPPORT_PROGRAM_ID, SUPPORT_VAULT or SUPPORT_VAULT_USDC not set" };
  if (cluster !== SUPPORT_DEVNET.cluster) return { ok: false, reason: "SUPPORT_CLUSTER must be devnet (support tips are Devnet only in this release)" };
  if (![programId, vault, vaultUsdc].every(isAddress) || new Set([programId, vault, vaultUsdc]).size !== 3) return { ok: false, reason: "SUPPORT_PROGRAM_ID, SUPPORT_VAULT and SUPPORT_VAULT_USDC must be three different addresses" };
  return { ok: true, config: { rpc, accounts: { programId, vault, vaultUsdc } } };
}

export type IndexerTarget = {
  genesisHash: string;
  vaultOwner: string | null; // owner program of SUPPORT_VAULT
  vaultUsdc: { mint: string; owner: string } | null; // parsed SPL token account at SUPPORT_VAULT_USDC
};

/** Why the configured RPC/accounts aren't the Devnet splitter vault, or null when they are. */
export function indexerTargetProblem(target: IndexerTarget, accounts: SupportAccounts): string | null {
  if (target.genesisHash !== SUPPORT_DEVNET.genesisHash) return "SUPPORT_RPC_URL is not a Devnet RPC";
  if (target.vaultOwner !== accounts.programId) return "SUPPORT_VAULT is not owned by SUPPORT_PROGRAM_ID";
  if (!target.vaultUsdc) return "SUPPORT_VAULT_USDC is not a token account";
  if (target.vaultUsdc.mint !== SUPPORT_DEVNET.usdcMint) return "SUPPORT_VAULT_USDC does not hold Devnet USDC";
  if (target.vaultUsdc.owner !== accounts.vault) return "SUPPORT_VAULT_USDC is not owned by SUPPORT_VAULT";
  return null;
}
