import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { RATE_LIMITS } from "./supportRpc";
import { advanceCursor, indexerTargetProblem, parseSupportTx, planPage, summarize, supportServerConfig, type RpcTransaction, type SignatureInfo, type StoredEvent, type SupportCursor } from "./supportParse";

// Reads the support vault's history from a Devnet RPC every five minutes (the
// "index support vault contributions" cron in crons.ts runs `sync`, which reads
// SUPPORT_VAULT and SUPPORT_VAULT_USDC, so it targets exactly the configured vault).
// The RPC URL (it may carry an API key) lives only in Convex env, never in the browser.
//
// Off switches, precisely:
//   - SUPPORT_LIVE=false closes the browser relay (/support/rpc answers 503, see http.ts)
//     and makes /support/v1 report live=false. It does NOT stop this indexer: `sync`
//     keeps reading the vault while the config below is set, so the ledger stays true.
//   - Unsetting SUPPORT_CLUSTER, SUPPORT_RPC_URL, SUPPORT_PROGRAM_ID, SUPPORT_VAULT or
//     SUPPORT_VAULT_USDC (or pointing them anywhere but the Devnet vault) stops the indexer.
//   - Neither reverses a tip that already landed or erases what the vault owes.
const PAGE = 100;
const MAX_PAGES_PER_ACCOUNT = 5;

const asset = v.union(v.literal("SOL"), v.literal("USDC"));
const event = v.object({
  kind: v.union(v.literal("contribution"), v.literal("payout"), v.literal("funding"), v.literal("anomaly")),
  asset, amount: v.string(), donor: v.union(v.string(), v.null()), note: v.union(v.string(), v.null()),
  side: v.union(v.literal("A"), v.literal("B"), v.null()),
});
const cursor = v.object({ newest: v.union(v.string(), v.null()), pending: v.union(v.object({ top: v.string(), before: v.string() }), v.null()) });

function config() {
  const result = supportServerConfig(process.env);
  return result.ok ? result.config : null;
}

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = await res.json() as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  return body.result as T;
}

export const sync = internalAction({ args: {}, handler: async (ctx) => {
  const checked = supportServerConfig(process.env);
  if (!checked.ok) { console.warn(`support sync skipped: ${checked.reason}`); return { skipped: true }; }
  const cfg = checked.config;
  // Fail closed: index only when the RPC is Devnet and the accounts are the splitter's
  // vault and its Devnet USDC account. Three cheap reads per run.
  const [genesisHash, vaultInfo, usdcInfo] = await Promise.all([
    rpcCall<string>(cfg.rpc, "getGenesisHash", []),
    rpcCall<{ value: { owner: string } | null }>(cfg.rpc, "getAccountInfo", [cfg.accounts.vault, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "finalized" }]),
    rpcCall<{ value: { data: { parsed?: { info?: { mint?: string; owner?: string } } } } | null }>(cfg.rpc, "getAccountInfo", [cfg.accounts.vaultUsdc, { encoding: "jsonParsed", commitment: "finalized" }]),
  ]);
  const info = usdcInfo.value?.data?.parsed?.info;
  const problem = indexerTargetProblem({
    genesisHash,
    vaultOwner: vaultInfo.value?.owner ?? null,
    vaultUsdc: info?.mint && info.owner ? { mint: info.mint, owner: info.owner } : null,
  }, cfg.accounts);
  if (problem) { console.error(`support sync refused: ${problem}`); return { skipped: true }; }
  let stored = 0;
  for (const account of [cfg.accounts.vault, cfg.accounts.vaultUsdc]) {
    let current: SupportCursor = await ctx.runQuery(internal.support.getCursor, { account });
    for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
      const sigs = await rpcCall<SignatureInfo[]>(cfg.rpc, "getSignaturesForAddress", [account, { ...planPage(current), limit: PAGE, commitment: "finalized" }]);
      for (const sig of sigs) {
        if (sig.err !== null) continue;
        const tx = await rpcCall<RpcTransaction | null>(cfg.rpc, "getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
        // A finalized signature without its transaction means the RPC is behind.
        // Stop without moving the cursor; the next run retries the same page.
        if (!tx) throw new Error(`transaction ${sig.signature} not available yet`);
        const parsed = parseSupportTx(tx, cfg.accounts);
        if (!parsed) continue;
        await ctx.runMutation(internal.support.upsert, { signature: parsed.signature, slot: parsed.slot, blockTime: parsed.blockTime, events: parsed.events });
        stored++;
      }
      // Saved only after the whole page is stored, so an outage mid-page loses nothing.
      current = advanceCursor(current, sigs, PAGE);
      await ctx.runMutation(internal.support.setCursor, { account, cursor: current });
      if (!current.pending) break;
    }
  }
  return { stored };
} });

export const getCursor = internalQuery({ args: { account: v.string() }, handler: async (ctx, { account }): Promise<SupportCursor> => {
  const row = await ctx.db.query("support_cursors").withIndex("by_account", q => q.eq("account", account)).unique();
  return row?.cursor ?? { newest: null, pending: null };
} });

export const setCursor = internalMutation({ args: { account: v.string(), cursor }, handler: async (ctx, { account, cursor }) => {
  const row = await ctx.db.query("support_cursors").withIndex("by_account", q => q.eq("account", account)).unique();
  if (row) await ctx.db.patch(row._id, { cursor }); else await ctx.db.insert("support_cursors", { account, cursor });
} });

/** Idempotent: re-ingesting a signature replaces its rows instead of adding duplicates. */
export const upsert = internalMutation({ args: { signature: v.string(), slot: v.number(), blockTime: v.union(v.number(), v.null()), events: v.array(event) }, handler: async (ctx, { signature, slot, blockTime, events }) => {
  const existing = await ctx.db.query("support_events").withIndex("by_signature", q => q.eq("signature", signature)).collect();
  for (const row of existing) await ctx.db.delete(row._id);
  for (const [index, e] of events.entries()) await ctx.db.insert("support_events", { signature, slot, blockTime, index, ...e });
} });

export const publicSummary = internalQuery({ args: {}, handler: async (ctx) => {
  const rows = await ctx.db.query("support_events").withIndex("by_slot").collect();
  const events: StoredEvent[] = rows.map(({ signature, slot, blockTime, kind, asset, amount, donor, note, side }) => ({ signature, slot, blockTime, kind, asset, amount, donor, note, side }));
  return summarize(events, process.env.SUPPORT_LIVE === "true" && config() !== null);
} });

/**
 * Counts one /support/rpc call against the per-IP and global buckets in
 * rate_limits. Returns false when any bucket is full (the call is not counted then).
 */
export const relayAllowed = internalMutation({ args: { client: v.string(), send: v.boolean() }, handler: async (ctx, { client, send }) => {
  const now = Date.now();
  const window = 60_000;
  const slot = Math.floor(now / window);
  const buckets = [
    { key: `support-rpc:all:${slot}`, max: RATE_LIMITS.globalPerMinute },
    { key: `support-rpc:ip:${client}:${slot}`, max: RATE_LIMITS.ipPerMinute },
    ...(send ? [{ key: `support-rpc:send:${client}:${slot}`, max: RATE_LIMITS.ipSendsPerMinute }] : []),
  ];
  const rows = await Promise.all(buckets.map((b) => ctx.db.query("rate_limits").withIndex("by_key", q => q.eq("key", b.key)).unique()));
  if (rows.some((row, i) => (row?.count ?? 0) >= buckets[i].max)) return false;
  for (const [i, row] of rows.entries()) {
    if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
    else await ctx.db.insert("rate_limits", { key: buckets[i].key, count: 1, expires: (slot + 1) * window });
  }
  return true;
} });
