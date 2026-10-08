import { v } from "convex/values";
import { petOperation } from "./pet";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decimal, encode, fail, getRecord, json, jsonValue, numberToken, receiptKey, safeNumber, sorted, sqlTimestampMicros, string, writeRecord } from "./records";
import type { RecordKind } from "./records";
import { cardOperation, cardOperations, cardReadOperations } from "./cards";
import { emitAfterWrite, webhookOperation, webhookOperations, webhookReadOperations } from "./webhooks";

export const backendOperations = new Set(["pet.state","pet.visitors","pet.act","pet.memories","find_other_connector_job_for_owner","put_crossmint_proof","put_mandate_request","get_mandate_request","put_receipt_request","find_receipt_request","put_observed_policy","find_observed_policy","ping", "claim_operation", "operation_record", "operation_owner", "auth_rate", "put_auth", "get_auth", "auth_connection", "get_payment", "find_payment_by_idempotency", "find_payment_by_receipt", "put_payment", "get_transaction", "find_transaction_by_idempotency", "put_transaction", "list_x402_for_owner", "find_x402_by_idempotency", "put_x402", "put_managed_signer_challenge", "get_managed_signer_challenge", "consume_managed_signer_challenge", "put_managed_signer", "find_managed_signer_by_public_key", "find_managed_signer_by_mandate", "put_delivery_attestation", "find_delivery_attestation", ...cardOperations, ...webhookOperations]);
export const mcpOperations = new Set(["ping", "mcp.register", "mcp.identify", "mcp.observe", "mcp.list", "mcp.revoke", "mcp.appendInboxMessage", "mcp.listInbox", "mcp.rateLimit", "mcp.putFlow", "mcp.getFlow"]);
const readOperations = new Set(["get_mandate_request","find_receipt_request","find_observed_policy","find_other_connector_job_for_owner","ping", "operation_record", "operation_owner", "auth_connection", "get_payment", "find_payment_by_idempotency", "find_payment_by_receipt", "get_transaction", "find_transaction_by_idempotency", "list_x402_for_owner", "find_x402_by_idempotency", "get_managed_signer_challenge", "find_managed_signer_by_public_key", "find_managed_signer_by_mandate", "find_delivery_attestation", "mcp.identify", "mcp.list", "mcp.listInbox", "mcp.getFlow", ...cardReadOperations, ...webhookReadOperations]);
export function isRead(operation: string, args: Record<string, any>): boolean { return readOperations.has(operation) || operation === "get_auth" && args.consume === false; }
function publicConnection(r: Doc<"agent_connections">) { const { _id, _creationTime, tokenHash, revokedAt, source_json, ...record } = r; return record; }
function publicInbox(r: Doc<"inbox_messages">) { const { _id, _creationTime, source_json, ...record } = r; return record; }
const limit = (value: unknown, defaultValue: number) => Math.max(1, Math.min(safeNumber(value ?? defaultValue), 100));
async function rate(ctx: MutationCtx, key: string, now: number, maximum: number, window: number): Promise<boolean> {
  if (!Number.isSafeInteger(window) || window < 1 || !Number.isSafeInteger(now + window)) return fail("invalid_argument", "Invalid rate window");
  // Bound cleanup per call; expired buckets never affect authorization.
  const stale = await ctx.db.query("rate_limits").withIndex("by_expires", q => q.lte("expires", now)).take(50);
  for (const row of stale) await ctx.db.delete(row._id);
  const bucket = `${key}:${Math.floor(now / window)}`;
  const old = await ctx.db.query("rate_limits").withIndex("by_key", q => q.eq("key", bucket)).unique();
  const count = safeNumber((old?.count ?? 0) + 1);
  if (old) await ctx.db.patch(old._id, { count }); else await ctx.db.insert("rate_limits", { key: bucket, count, expires: now + window });
  return count <= maximum;
}

// Only the authenticated gateway can invoke this internal dispatcher. Each call
// is one transaction, including read-before-write uniqueness and claim checks.
export const execute = internalMutation({
  args: { role: v.union(v.literal("backend"), v.literal("mcp")), operation: v.string(), args: v.any() },
  returns: v.any(),
  handler: async (ctx, { role, operation: op, args: a }): Promise<any> => {
    if (!(role === "backend" ? backendOperations : mcpOperations).has(op)) return fail("forbidden", "Operation is not allowed for this service");
    if (!a || typeof a !== "object" || Array.isArray(a)) return fail("invalid_argument", "args must be an object");
    if (process.env.CHAINPAY_MAINTENANCE === "true" && !isRead(op, a)) return fail("maintenance", "Storage writes are paused");
    if (op.startsWith("pet.")) return petOperation(ctx, op, a);
    if (op === "ping") return { version: 1 };
    if ((cardOperations as readonly string[]).includes(op)) return cardOperation(ctx, op, a);
    if ((webhookOperations as readonly string[]).includes(op)) return webhookOperation(ctx, op, a);
    if (op === "claim_operation" || op === "operation_record" || op === "operation_owner") {
      const key = string(a.id); const old = await ctx.db.query("operation_claims").withIndex("by_key", q => q.eq("key", key)).unique();
      if (op === "operation_owner") return old?.owner ?? null;
      if (op === "operation_record") return old ? [old.owner, old.intent_json, old.initial_json] : null;
      if (old) return [false, old.owner, old.intent_json, old.initial_json];
      const record = { key, owner: string(a.owner), intent_json: string(a.intent_json), initial_json: string(a.initial_json) };
      jsonValue(record.intent_json); jsonValue(record.initial_json);
      await ctx.db.insert("operation_claims", record); return [true, record.owner, record.intent_json, record.initial_json];
    }
    if (op === "auth_rate") return rate(ctx, `auth:${string(a.bucket)}`, safeNumber(a.now), safeNumber(a.limit), 60_000);
    if (op === "mcp.rateLimit") return rate(ctx, `mcp:${string(a.key)}`, safeNumber(a.now), safeNumber(a.limit), safeNumber(a.windowMs));
    if (op === "put_auth" || op === "get_auth") {
      const key = string(a.key); const old = await ctx.db.query("owner_auth").withIndex("by_key", q => q.eq("key", key)).unique();
      if (op === "put_auth") { jsonValue(a.value_json); const data = { key, value_json: string(a.value_json), expires: sorted(a.expires) }; if (old) await ctx.db.patch(old._id, data); else await ctx.db.insert("owner_auth", data); return null; }
      if (typeof a.consume !== "boolean") return fail("invalid_argument", "consume must be boolean");
      if (!old || old.expires <= sorted(a.now)) return null;
      if (a.consume) await ctx.db.delete(old._id); return old.value_json;
    }
    if (op === "auth_connection" || op === "mcp.identify" || op === "mcp.observe") {
      const record = await ctx.db.query("agent_connections").withIndex("by_token", q => q.eq("tokenHash", string(a.hash))).unique();
      if (!record || record.revokedAt) return null;
      if (op === "auth_connection") return { wallet: record.wallet, scope: record.scope };
      if (op === "mcp.identify") return publicConnection(record);
      const now = string(a.now); const toolsCalled = record.toolsCalled;
      if (a.name) { const name = string(a.name); const old = toolsCalled.find(t => t.name === name); if (old) { old.count = safeNumber(old.count + 1); old.lastCalledAt = now; } else toolsCalled.push({ name, count: 1, lastCalledAt: now }); }
      const source = record.source_json ? json(record.source_json) : null;
      if (source) { delete source.last_seen_at; if (a.name) delete source.tools_called; }
      await ctx.db.patch(record._id, { lastSeenAt: now, totalCalls: safeNumber(record.totalCalls + (a.name ? 1 : 0)), toolsCalled, ...(source ? { source_json: encode(source) } : {}) }); return null;
    }
    const immutable: Record<string, RecordKind> = { put_receipt_request: "receipt_requests", put_observed_policy: "observed_policies", put_mandate_request: "mandate_requests" };
    if (immutable[op]) {
      const kind = immutable[op]; const incoming = json(a.record_json);
      const key = kind === "mandate_requests" ? string(incoming.mandate_pda) : receiptKey(incoming);
      const old = await getRecord(ctx, kind, key);
      if (!old) await writeRecord(ctx, kind, string(a.record_json));
      const stored = old?.record_json ?? string(a.record_json);
      return kind === "mandate_requests" ? [!old, encode(json(stored).record)] : stored;
    }
    if (op === "get_mandate_request" || op === "find_receipt_request" || op === "find_observed_policy") {
      const kind = op === "get_mandate_request" ? "mandate_requests" : op === "find_receipt_request" ? "receipt_requests" : "observed_policies";
      const key = kind === "mandate_requests" ? string(a.mandate_pda) : receiptKey({cluster:string(a.cluster),program_id:string(a.program_id),receipt_address:string(a.receipt_address)});
      const old = await getRecord(ctx, kind, key);
      return old ? kind === "mandate_requests" ? encode(json(old.record_json).record) : old.record_json : null;
    }
    if (op === "find_other_connector_job_for_owner") {
      const legacy = await ctx.db.query("records").withIndex("by_kind_owner_connector_updated", q => q.eq("kind", "x402_payments").eq("owner", string(a.owner)).eq("connector", undefined)).first();
      if (legacy) return fail("migration_required", "Backfill connector indexes before reserving orders");
      const rows = ctx.db.query("records").withIndex("by_kind_owner_connector_reference", q => q.eq("kind", "x402_payments").eq("owner", string(a.owner)).eq("connector", string(a.connector)).eq("reference", string(a.reference))).order("desc");
      // The idempotency index is unique, so at most one row can be excluded.
      for (const row of await rows.take(2)) if (row.idempotency !== string(a.current_key)) return row.record_json;
      return null;
    }
    if (op === "put_crossmint_proof") {
      const incoming = json(a.record_json); const old = await getRecord(ctx, "x402_payments", string(incoming.x402_payment_id));
      if (!old) return null;
      const prior = json(old.record_json);
      const original = old.source_json ? json(old.source_json) : null;
      if (original?.updated_at && sqlTimestampMicros(original.updated_at) > BigInt(decimal(incoming.updated_at_ms)) * 1000n) return null;
      if (prior.connector !== "crossmint" || !["confirmed", "verified"].includes(prior.status) || old.updated > sorted(incoming.updated_at_ms)) return null;
      if (!["confirmed", "verified"].includes(incoming.status)) return fail("invalid_argument", "Invalid order evidence status");
      prior.proof = incoming.proof; prior.response_status = incoming.response_status; prior.error = incoming.error;
      // Verification is monotonic against older-phase polls; a reported failed
      // delivery or refund is a new fact and is the one thing that clears it.
      const reverses = incoming.proof?.delivery === "failed" || (incoming.proof?.refunded !== null && typeof incoming.proof?.refunded === "object");
      if (prior.status !== "verified" || reverses) prior.status = incoming.status;
      prior.updated_at_ms = incoming.updated_at_ms;
      const source = old.source_json ? json(old.source_json) : null; if (source) delete source.updated_at;
      await ctx.db.patch(old._id, { record_json: encode(prior), updated: sorted(prior.updated_at_ms), ...(source ? { source_json: encode(source) } : {}) });
      return null;
    }
    const puts: Record<string, [RecordKind, string]> = { put_payment: ["payments", "record_json"], put_transaction: ["transactions", "record_json"], put_x402: ["x402_payments", "record_json"], put_managed_signer_challenge: ["managed_signer_challenges", "challenge_json"], put_managed_signer: ["managed_signers", "signer_json"], put_delivery_attestation: ["delivery_attestations", "record_json"] };
    if (puts[op]) {
      const [kind, field] = puts[op]; const written = await writeRecord(ctx, kind, string(a[field]));
      // Owner webhook outbox: same mutation, so the same transaction as the write.
      if ((op === "put_payment" || op === "put_transaction") && a.events_json != null) {
        const record = json(a[field]);
        return emitAfterWrite(ctx, kind as "payments" | "transactions", string(op === "put_payment" ? record.payment_id : record.transaction_id), a.events_json);
      }
      return written;
    }
    const gets: Record<string, [RecordKind, string]> = { get_payment: ["payments", "payment_id"], get_transaction: ["transactions", "transaction_id"], get_managed_signer_challenge: ["managed_signer_challenges", "challenge_id"] };
    if (gets[op]) { const [kind, field] = gets[op]; return (await getRecord(ctx, kind, string(a[field])))?.record_json ?? null; }
    const idempotency: Record<string, RecordKind> = { find_payment_by_idempotency: "payments", find_transaction_by_idempotency: "transactions", find_x402_by_idempotency: "x402_payments" };
    if (idempotency[op]) return (await ctx.db.query("records").withIndex("by_kind_idempotency", q => q.eq("kind", idempotency[op]).eq("idempotency", string(a.key))).unique())?.record_json ?? null;
    if (op === "find_payment_by_receipt" || op === "find_delivery_attestation") {
      const delivery = op === "find_delivery_attestation";
      const receipt = delivery ? receiptKey({ cluster: string(a.cluster), program_id: string(a.program_id), receipt_address: string(a.receipt_address) }) : string(a.receipt_address);
      return (await ctx.db.query("records").withIndex("by_kind_receipt_updated", q => q.eq("kind", delivery ? "delivery_attestations" : "payments").eq("receipt", receipt)).order(delivery ? "asc" : "desc").first())?.record_json ?? null;
    }
    if (op === "find_managed_signer_by_public_key") return (await ctx.db.query("records").withIndex("by_kind_public_key", q => q.eq("kind", "managed_signers").eq("public_key", string(a.public_key))).unique())?.record_json ?? null;
    if (op === "find_managed_signer_by_mandate") return (await ctx.db.query("records").withIndex("by_kind_mandate", q => q.eq("kind", "managed_signers").eq("mandate", string(a.mandate_pda))).unique())?.record_json ?? null;
    if (op === "consume_managed_signer_challenge") {
      const old = await getRecord(ctx, "managed_signer_challenges", string(a.challenge_id)); if (!old) return false;
      const r = json(old.record_json); const consumed = decimal(a.consumed_at_ms);
      if (r.consumed_at_ms != null || BigInt(decimal(r.expires_at_ms)) < BigInt(consumed)) return false;
      r.consumed_at_ms = numberToken(consumed); await ctx.db.patch(old._id, { record_json: encode(r) }); return true;
    }
    if (op === "list_x402_for_owner") {
      const legacy = await ctx.db.query("records").withIndex("by_kind_owner_connector_updated", q => q.eq("kind", "x402_payments").eq("owner", string(a.owner_wallet)).eq("connector", undefined)).first();
      if (legacy) return fail("migration_required", "Backfill connector indexes before serving history");
      const maximum = limit(a.limit, 100); const rows: [string, string | null][] = [];
      const query = ctx.db.query("records").withIndex("by_kind_owner_connector_updated", q => q.eq("kind", "x402_payments").eq("owner", string(a.owner_wallet)).eq("connector", string(a.connector ?? "x402"))).order("desc");
      // A bounded indexed iterator avoids collecting all of an owner's history.
      let scanned = 0;
      for await (const row of query) {
        if (++scanned > 2000) return fail("query_limit", "Narrow this owner's x402 history before retrying");
        const r = json(row.record_json); const payment = r.payment_id ? await getRecord(ctx, "payments", r.payment_id) : null;
        const mandate = payment?.mandate ?? null;
        if (a.mandate == null || a.mandate === mandate) rows.push([row.record_json, mandate]);
        if (rows.length === maximum) break;
      }
      return rows;
    }
    if (op === "mcp.register") {
      const r = a.record;
      if (!r || !r.wallet || r.wallet.length > 44 || !r.agentName || r.agentName.length > 128 || typeof r.scope !== "string" || r.scope.length > 8192 || !/^[0-9a-f]{64}$/.test(r.tokenHash)) return fail("invalid_argument", "Invalid connection");
      const old = await ctx.db.query("agent_connections").withIndex("by_external_id", q => q.eq("id", string(r.id))).unique();
      const token = await ctx.db.query("agent_connections").withIndex("by_token", q => q.eq("tokenHash", string(r.tokenHash))).unique();
      if (old || token) return fail("conflict", "Connection already exists");
      const id = await ctx.db.insert("agent_connections", r); return publicConnection((await ctx.db.get(id))!);
    }
    if (op === "mcp.list") {
      const records = await ctx.db.query("agent_connections").withIndex("by_wallet_revoked_created", q => q.eq("wallet", string(a.wallet).trim()).eq("revokedAt", null)).order("desc").take(1001);
      if (records.length > 1000) return fail("query_limit", "Connection list exceeds 1000 entries; use pagination");
      return records.map(publicConnection);
    }
    if (op === "mcp.revoke") {
      const r = await ctx.db.query("agent_connections").withIndex("by_external_id", q => q.eq("id", string(a.id))).unique();
      if (!r || r.wallet !== string(a.wallet).trim() || r.revokedAt) return false;
      const source = r.source_json ? json(r.source_json) : null;
      if (source) delete source.revoked_at;
      await ctx.db.patch(r._id, { revokedAt: string(a.now), ...(source ? { source_json: encode(source) } : {}) }); return true;
    }
    if (op === "mcp.appendInboxMessage") {
      const r = a.record; string(r.wallet); jsonValue(r.content_json);
      if (await ctx.db.query("inbox_messages").withIndex("by_external_id", q => q.eq("id", string(r.id))).unique()) return fail("conflict", "Message already exists");
      const id = await ctx.db.insert("inbox_messages", r); return publicInbox((await ctx.db.get(id))!);
    }
    if (op === "mcp.putFlow" || op === "mcp.getFlow") {
      const flowId = string(a.flowId);
      const old = await ctx.db.query("payment_flows").withIndex("by_flow", q => q.eq("flowId", flowId)).unique();
      if (op === "mcp.getFlow") return old && old.expires > safeNumber(a.now) ? old.record_json : null;
      const record = { flowId, wallet: string(a.wallet), record_json: string(a.record_json), expires: safeNumber(a.expires) };
      const value = json(record.record_json);
      if (record.record_json.length > 32_000) return fail("invalid_argument", "Payment card record is too large");
      // A card keeps its owner: another wallet can never overwrite it.
      if (old && old.wallet !== record.wallet) return fail("forbidden", "Payment card belongs to another wallet");
      if (a.expectedUpdatedAt === undefined) {
        if (old) return fail("conflict", "Payment flow update conflict");
      } else {
        const expected = safeNumber(a.expectedUpdatedAt);
        const previous = old ? json(old.record_json) : null;
        if (!old || old.expires <= Date.now() || old.expires !== record.expires ||
            previous?.paymentId !== value.paymentId ||
            safeNumber(previous?.updatedAt) !== expected || safeNumber(value.updatedAt) <= expected ||
            safeNumber(previous?.createdAt) !== safeNumber(value.createdAt)) {
          return fail("conflict", "Payment flow update conflict");
        }
      }
      if (old) await ctx.db.patch(old._id, record); else await ctx.db.insert("payment_flows", record);
      return null;
    }
    if (op === "mcp.listInbox") return (await ctx.db.query("inbox_messages").withIndex("by_wallet_created", q => q.eq("wallet", string(a.wallet).trim())).order("desc").take(limit(a.limit, 30))).map(publicInbox);
    return fail("invalid_argument", "Unknown operation");
  },
});
