import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { decimal, encode, fail, json, numberToken, safeNumber, sorted, sqlTimestampMicros, string, writeRecord } from "./records";
import type { RecordKind, JsonRecord } from "./records";

const tableValidator = v.union(v.literal("payments"), v.literal("transactions"), v.literal("x402_payments"), v.literal("managed_signer_challenges"), v.literal("managed_signers"), v.literal("delivery_attestations"), v.literal("operation_claims"), v.literal("owner_auth"), v.literal("agent_connections"), v.literal("inbox_messages"), v.literal("receipt_requests"), v.literal("observed_policies"), v.literal("mandate_requests"));
const recordTables = new Set(["payments", "transactions", "x402_payments", "managed_signer_challenges", "managed_signers", "delivery_attestations", "receipt_requests", "observed_policies", "mandate_requests"]);
function maintenance() { if (process.env.CHAINPAY_MAINTENANCE !== "true" || process.env.CHAINPAY_CONVEX_MIGRATION_ENABLED !== "true") return fail("forbidden", "Migration requires maintenance and migration mode"); }
function iso(value: unknown): string { const s = string(value); if (!Number.isFinite(Date.parse(s))) return fail("invalid_argument", "Invalid SQL timestamp"); return new Date(s).toISOString(); }
// PostgreSQL's numeric-to-BIGINT cast rounds fractional milliseconds.
function millis(value: unknown) { return numberToken(((sqlTimestampMicros(value) + 500n) / 1000n).toString()); }
function normalize(table: string, row: JsonRecord): JsonRecord {
  const r = { ...row }; delete r.created_at; delete r.updated_at;
  if (table === "x402_payments") { r.created_at_ms = millis(row.created_at); r.updated_at_ms = millis(row.updated_at); }
  if (table === "payments" && r.amount != null) r.amount = decimal(r.amount);
  return r;
}
export const importRows = internalMutation({
  args: { table: tableValidator, rows: v.array(v.string()) }, returns: v.object({ imported: v.number() }),
  handler: async (ctx, { table, rows }) => {
    maintenance(); if (rows.length > 100) return fail("invalid_argument", "Import at most 100 rows per transaction");
    for (const source_json of rows) {
      // Source and normalized copies coexist for reversible export. Reserve
      // headroom for indexes and fields under Convex's 1 MiB document limit.
      if (new TextEncoder().encode(source_json).length > 350_000) return fail("too_large", "SQL row exceeds the reversible import limit of 350000 bytes");
      const r = json(source_json);
      if (recordTables.has(table)) { await writeRecord(ctx, table as RecordKind, encode(normalize(table, r)), source_json, true); continue; }
      if (table === "operation_claims") {
        const key = string(r.operation_id); const old = await ctx.db.query("operation_claims").withIndex("by_key", q => q.eq("key", key)).unique();
        const data = { key, owner: string(r.owner_wallet), intent_json: encode(r.intent), initial_json: encode(r.initial_record), source_json };
        if (old) await ctx.db.replace(old._id, data); else await ctx.db.insert("operation_claims", data);
      } else if (table === "owner_auth") {
        const key = string(r.key); const old = await ctx.db.query("owner_auth").withIndex("by_key", q => q.eq("key", key)).unique();
        const data = { key, value_json: encode(r.payload), expires: sorted(r.expires_at_ms), source_json };
        if (old) await ctx.db.replace(old._id, data); else await ctx.db.insert("owner_auth", data);
      } else if (table === "agent_connections") {
        const id = string(r.connection_id); const old = await ctx.db.query("agent_connections").withIndex("by_external_id", q => q.eq("id", id)).unique();
        const tokenHash = string(r.token_hash); const dup = await ctx.db.query("agent_connections").withIndex("by_token", q => q.eq("tokenHash", tokenHash)).unique();
        if (dup && dup._id !== old?._id) return fail("conflict", "Duplicate connection token");
        const data = { id, tokenHash, wallet: string(r.wallet_address), agentName: string(r.agent_name), scope: string(r.scope), connectedAt: iso(r.created_at), lastSeenAt: r.last_seen_at == null ? null : iso(r.last_seen_at), revokedAt: r.revoked_at == null ? null : iso(r.revoked_at), totalCalls: safeNumber(r.total_calls), toolsCalled: (r.tools_called as JsonRecord[]).map(t => ({ name: string(t.name), count: safeNumber(t.count), lastCalledAt: string(t.lastCalledAt) })), source_json };
        if (old) await ctx.db.replace(old._id, data); else await ctx.db.insert("agent_connections", data);
      } else {
        const id = string(r.message_id); const old = await ctx.db.query("inbox_messages").withIndex("by_external_id", q => q.eq("id", id)).unique();
        if (!["user", "assistant", "tool"].includes(r.role)) return fail("invalid_argument", "Invalid inbox role");
        const data = { id, wallet: string(r.wallet_address), role: r.role as "user" | "assistant" | "tool", content_json: encode(r.content), createdAt: iso(r.created_at), source_json };
        if (old) await ctx.db.replace(old._id, data); else await ctx.db.insert("inbox_messages", data);
      }
    }
    return { imported: rows.length };
  },
});

// Retain original unused SQL columns and microsecond timestamps until a write
// changes their corresponding value. Reverse export overlays every live field.
function timestamp(base: JsonRecord, field: string, current: string | null): string | null {
  if (current === null) return null;
  return base[field] != null && iso(base[field]) === current ? base[field] : current;
}
export function sqlRow(table: string, doc: any): string {
  const base = doc.source_json ? json(doc.source_json) : {};
  if (recordTables.has(table)) {
    const r = json(doc.record_json); const out = { ...base, ...r };
    if (table === "payments" && out.amount != null) out.amount = numberToken(out.amount);
    if (table === "x402_payments") {
      out.connector ??= "x402"; out.connector_reference ??= null;
      out.created_at = base.created_at ?? new Date(safeNumber(r.created_at_ms)).toISOString();
      out.updated_at = base.updated_at ?? new Date(safeNumber(r.updated_at_ms)).toISOString();
      delete out.created_at_ms; delete out.updated_at_ms;
    }
    if ((table === "payments" || table === "transactions") && !out.created_at) out.created_at = new Date(safeNumber(r.created_at_ms)).toISOString();
    if ((table === "payments" || table === "transactions") && !out.updated_at) out.updated_at = new Date(safeNumber(r.updated_at_ms)).toISOString();
    return encode(out);
  }
  if (table === "operation_claims") return encode({ ...base, operation_id: doc.key, owner_wallet: doc.owner, intent: JSONValue(doc.intent_json), initial_record: JSONValue(doc.initial_json) });
  if (table === "owner_auth") return encode({ ...base, key: doc.key, payload: JSONValue(doc.value_json), expires_at_ms: numberToken(doc.expires.replace(/^0+(?=\d)/, "")) });
  if (table === "agent_connections") return encode({ ...base, connection_id: doc.id, wallet_address: doc.wallet, agent_name: doc.agentName, scope: doc.scope, token_hash: doc.tokenHash, created_at: timestamp(base, "created_at", doc.connectedAt), last_seen_at: timestamp(base, "last_seen_at", doc.lastSeenAt), revoked_at: timestamp(base, "revoked_at", doc.revokedAt), total_calls: numberToken(doc.totalCalls), tools_called: base.tools_called ?? doc.toolsCalled });
  return encode({ ...base, message_id: doc.id, wallet_address: doc.wallet, role: doc.role, content: JSONValue(doc.content_json), created_at: timestamp(base, "created_at", doc.createdAt) });
}
import { parse as JSONValue } from "lossless-json";
export const exportRows = internalQuery({
  args: { table: tableValidator, cursor: v.union(v.string(), v.null()), limit: v.number() },
  returns: v.object({ rows: v.array(v.string()), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { table, cursor, limit }) => {
    maintenance(); if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_argument", "Export limit must be 1..100");
    const options = { cursor, numItems: limit, maximumBytesRead: 2_000_000 };
    const page = recordTables.has(table)
      ? await ctx.db.query("records").withIndex("by_kind_key", q => q.eq("kind", table as RecordKind)).paginate(options)
      : table === "agent_connections" ? await ctx.db.query("agent_connections").withIndex("by_external_id").paginate(options)
      : table === "inbox_messages" ? await ctx.db.query("inbox_messages").withIndex("by_external_id").paginate(options)
      : table === "owner_auth" ? await ctx.db.query("owner_auth").withIndex("by_key").paginate(options)
      : await ctx.db.query("operation_claims").withIndex("by_key").paginate(options);
    return { rows: page.page.map(row => sqlRow(table, row)), cursor: page.continueCursor, done: page.isDone };
  },
});
