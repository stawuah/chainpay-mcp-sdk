import { parse, stringify, LosslessNumber } from "lossless-json";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type RecordKind = Doc<"records">["kind"];
export type JsonRecord = Record<string, any>;
export const fail = (code: string, message: string): never => { throw new ConvexError({ code, message }); };
export function jsonValue(text: unknown): unknown {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 700_000) return fail("invalid_argument", "JSON record must be a string no larger than 700000 bytes");
  try { return parse(text); }
  catch { return fail("invalid_argument", "Invalid JSON record"); }
}
export function json(text: unknown): JsonRecord {
  const value = jsonValue(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_argument", "Expected a JSON object");
  return value as JsonRecord;
}
export function encode(value: unknown): string { const result = stringify(value); if (result === undefined) return fail("invalid_argument", "Invalid JSON value"); return result; }
export function string(value: unknown, field = "value"): string { if (typeof value !== "string" || !value.length) return fail("invalid_argument", `${field} must be a nonempty string`); return value; }
export function decimal(value: unknown): string {
  const s = value instanceof LosslessNumber ? value.value : typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  if (!/^(0|[1-9][0-9]*)$/.test(s) || BigInt(s) > 18446744073709551615n) return fail("invalid_argument", "Expected an unsigned 64-bit decimal");
  return s;
}
export const sorted = (value: unknown) => decimal(value).padStart(20, "0");
export const numberToken = (value: unknown) => new LosslessNumber(decimal(value));
export function safeNumber(value: unknown): number { const n = Number(decimal(value)); if (!Number.isSafeInteger(n)) return fail("invalid_argument", "Counter or clock exceeds safe integer range"); return n; }
export function sqlTimestampMicros(value: unknown): bigint {
  const s = string(value); const ms = Date.parse(s);
  if (!Number.isSafeInteger(ms) || ms < 0) return fail("invalid_argument", "Invalid SQL timestamp");
  const fraction = s.match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] ?? "";
  return BigInt(ms) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}
export const receiptKey = (r: JsonRecord) => encode([r.cluster, r.program_id, r.receipt_address]);
export function recordKey(kind: RecordKind, r: JsonRecord): string {
  if (kind === "receipt_requests" || kind === "observed_policies") return receiptKey(r);
  if (kind === "mandate_requests") return string(r.mandate_pda);
  if (kind === "delivery_attestations") return encode([r.cluster, r.program_id, r.receipt_address, r.seller]);
  return string(r[{ payments: "payment_id", transactions: "transaction_id", x402_payments: "x402_payment_id", managed_signer_challenges: "challenge_id", managed_signers: "signer_id" }[kind]]);
}
export async function getRecord(ctx: QueryCtx | MutationCtx, kind: RecordKind, key: string) { return ctx.db.query("records").withIndex("by_kind_key", q => q.eq("kind", kind).eq("key", key)).unique(); }
export function metadata(kind: RecordKind, r: JsonRecord) {
  const data: Omit<Doc<"records">, "_id" | "_creationTime" | "record_json"> = { kind, key: recordKey(kind, r), updated: sorted(r.updated_at_ms ?? r.published_at_ms ?? r.created_at_ms ?? r.stored_at_ms ?? r.observed_at_ms) };
  if (r.idempotency_key != null) data.idempotency = string(r.idempotency_key);
  if (r.receipt_address != null) data.receipt = kind === "delivery_attestations" ? receiptKey(r) : string(r.receipt_address);
  if (r.owner_wallet != null) data.owner = string(r.owner_wallet);
  if (kind === "x402_payments" && typeof r.idempotency_key === "string" && r.idempotency_key.includes(":")) data.owner = r.idempotency_key.slice(0, r.idempotency_key.indexOf(":"));
  if (kind === "x402_payments") { data.connector = r.connector ?? "x402"; if (!["x402", "crossmint"].includes(data.connector!)) return fail("invalid_argument", "Invalid connector"); if (r.connector_reference != null) data.reference = string(r.connector_reference); }
  if (r.mandate != null || r.mandate_pda != null) data.mandate = string(r.mandate ?? r.mandate_pda);
  if (r.public_key != null) data.public_key = string(r.public_key);
  if (r.provider_wallet_id != null) data.provider_wallet = encode([r.provider, r.provider_wallet_id]);
  return data;
}
export async function writeRecord(ctx: MutationCtx, kind: RecordKind, text: string, source_json?: string, importing = false) {
  const incoming = json(text); const fields = metadata(kind, incoming);
  const old = await getRecord(ctx, kind, fields.key);
  // Validate fields used by Rust as integers before accepting opaque JSON. This
  // prevents corrupt records from being written successfully but failing reads.
  for (const field of ["created_at_ms", "updated_at_ms", "published_at_ms", "expires_at_ms", "consumed_at_ms", "revoked_at_ms", "slot", "amount", "stored_at_ms", "observed_at_ms", "observed_at_slot"]) {
    if (incoming[field] != null) decimal(incoming[field]);
  }
  if (kind === "payments" && !["human", "delegated"].includes(incoming.signing_mode)) return fail("invalid_argument", "Invalid signing mode");
  if (kind === "managed_signer_challenges" || kind === "managed_signers") {
    string(incoming.owner_wallet, "owner_wallet"); string(incoming.mandate_pda, "mandate_pda");
  }
  if (kind === "managed_signer_challenges") { string(incoming.message, "message"); decimal(incoming.expires_at_ms); }
  if (kind === "managed_signers") {
    string(incoming.provider_wallet_id, "provider_wallet_id"); string(incoming.provider_policy_id, "provider_policy_id");
    if (incoming.provider !== "privy" || incoming.signing_mode !== "delegated") return fail("invalid_argument", "Invalid managed signer provider or signing mode");
    string(incoming.public_key, "public_key");
    if (!["provisioning", "active", "suspended", "revoked"].includes(incoming.status)) return fail("invalid_argument", "Invalid managed signer status");
  }
  if (kind === "x402_payments" && incoming.response_status != null && BigInt(decimal(incoming.response_status)) > 65535n) return fail("invalid_argument", "Response status exceeds u16");
  if (kind === "delivery_attestations" && (incoming.cluster !== "devnet" || !/^[0-9a-f]{64}$/.test(incoming.content_hash))) return fail("invalid_argument", "Invalid delivery attestation");
  if (["payments", "transactions", "x402_payments"].includes(kind) && !["prepared", "submitted", "confirmed", "failed", ...(kind === "x402_payments" ? ["verified"] : [])].includes(incoming.status)) return fail("invalid_argument", "Invalid payment status");
  if (old && !importing) {
    const prior = json(old.record_json);
    if (kind === "delivery_attestations") return { kind: prior.canonical_payload === incoming.canonical_payload && prior.signature === incoming.signature ? "unchanged" : "conflict", record_json: old.record_json };
    if (kind === "managed_signer_challenges") return fail("conflict", "Challenge already exists");
    if (["payments", "transactions", "x402_payments"].includes(kind)) {
      const terminal = kind === "x402_payments" ? prior.status === "verified" || (["confirmed", "failed"].includes(prior.status) && ["prepared", "submitted"].includes(incoming.status)) : ["confirmed", "failed"].includes(prior.status);
      const source = old.source_json ? json(old.source_json) : null;
      const olderThanSqlTimestamp = kind === "x402_payments" && source?.updated_at && sqlTimestampMicros(source.updated_at) > BigInt(decimal(incoming.updated_at_ms)) * 1000n;
      if (terminal || old.updated > fields.updated || olderThanSqlTimestamp) return null;
      incoming.created_at_ms = prior.created_at_ms;
      if (kind === "x402_payments") { incoming.idempotency_key = prior.idempotency_key; incoming.proof ??= prior.proof; incoming.response_status ??= prior.response_status; }
    }
    if (kind === "managed_signers") incoming.created_at_ms = prior.created_at_ms;
  }
  const finalFields = metadata(kind, incoming);
  // Match the existing SQL foreign key. Import payments before x402 records;
  // malformed snapshots fail atomically instead of introducing dangling links.
  if (kind === "x402_payments" && incoming.payment_id != null && !await getRecord(ctx, "payments", string(incoming.payment_id))) return fail("conflict", "Linked payment does not exist");
  if (finalFields.idempotency) { const dup = await ctx.db.query("records").withIndex("by_kind_idempotency", q => q.eq("kind", kind).eq("idempotency", finalFields.idempotency)).unique(); if (dup && dup._id !== old?._id) return fail("conflict", "Idempotency key already exists"); }
  if (kind === "managed_signers") {
    for (const [index, field] of [["by_kind_public_key", "public_key"], ["by_kind_mandate", "mandate"], ["by_kind_provider_wallet", "provider_wallet"]] as const) {
      const dup = await ctx.db.query("records").withIndex(index, q => q.eq("kind", kind).eq(field, finalFields[field])).unique();
      if (dup && dup._id !== old?._id) return fail("conflict", `Signer ${field} already exists`);
    }
  }
  const record_json = encode(incoming);
  let retainedSource = source_json ?? old?.source_json;
  if (retainedSource && old && !importing && kind === "x402_payments") {
    const original = json(retainedSource); delete original.updated_at;
    retainedSource = encode(original);
  }
  const record = { ...finalFields, record_json, ...(retainedSource !== undefined ? { source_json: retainedSource } : {}) };
  if (new TextEncoder().encode(JSON.stringify(record)).length > 900_000) return fail("too_large", "Stored document exceeds 900000 bytes; no data was truncated");
  if (old) await ctx.db.replace(old._id, record); else await ctx.db.insert("records", record);
  return kind === "delivery_attestations" ? { kind: "created", record_json } : null;
}
