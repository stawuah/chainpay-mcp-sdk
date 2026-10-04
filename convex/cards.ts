import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decimal, fail, json, safeNumber, sorted, string } from "./records";

/*
 * Private agent card records (contracts.md §5). Axum owns encryption: every
 * sensitive field arrives as an AES-GCM envelope and Convex never sees
 * plaintext. These validators are defence in depth: they refuse a record whose
 * required-sensitive fields are not envelopes, whose amounts are not exact
 * integer-cent strings, or whose indexed columns look like anything but opaque
 * identifiers. Writes are compare-and-swap on `rev`.
 */

export const cardKinds = ["cards", "card_events", "card_statements", "card_recovery"] as const;
export type CardKind = (typeof cardKinds)[number];
export const cardOperations = ["put_card_record", "get_card_record", "find_card_record_by_idempotency", "list_card_records_for_owner", "scan_card_records"] as const;
export const cardReadOperations = ["get_card_record", "find_card_record_by_idempotency", "list_card_records_for_owner", "scan_card_records"] as const;

const ENVELOPE_KEYS = ["alg", "ct", "iv", "kid", "v"];
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CENTS = /^(0|[1-9][0-9]{0,15})$/;
const SIGNED_CENTS = /^(0|-?[1-9][0-9]{0,15})$/;
// Opaque index values: ids, hex/base58 hashes, wallets, and prefixed keys.
const OPAQUE = /^[A-Za-z0-9_:.-]{1,200}$/;
// Free-standing 13-19 digit runs that pass the Luhn check look like card
// numbers and are refused anywhere in plaintext. Long hex digests and base58
// keys/signatures are identifiers, not free text, and are exempt.
const DIGIT_RUN = /(?:^|[^0-9])([0-9]{13,19})(?=[^0-9]|$)/g;
const IDENTIFIER = /^(?:[0-9a-f]{32,}|[1-9A-HJ-NP-Za-km-z]{32,90})$/;
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
export function panLike(value: string): boolean {
  if (IDENTIFIER.test(value) && /[a-zA-Z]/.test(value)) return false;
  for (const match of value.matchAll(DIGIT_RUN)) if (luhn(match[1])) return true;
  return false;
}

/** Fields that must be encrypted when present, per kind (contracts.md §5 🔒 column). */
const SENSITIVE: Record<CardKind, string[]> = {
  cards: ["issuer", "label", "recoveryReport"],
  card_events: ["provider", "raw", "secret", "line"],
  card_statements: ["lines"],
  card_recovery: ["snapshot", "masterSalt", "report"],
};

function isEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  const keys = Object.keys(e).sort();
  return keys.length === ENVELOPE_KEYS.length && keys.every((k, i) => k === ENVELOPE_KEYS[i])
    && (e.v === 1 || (typeof e.v === "object" && e.v !== null && String(e.v) === "1"))
    && e.alg === "A256GCM" && typeof e.kid === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(e.kid)
    && typeof e.iv === "string" && e.iv.length === 16 && B64.test(e.iv)
    && typeof e.ct === "string" && e.ct.length >= 24 && e.ct.length <= 400_000 && B64.test(e.ct);
}

function walk(kind: CardKind, value: unknown, path: string): void {
  if (typeof value === "string") {
    if (panLike(value)) return fail("invalid_argument", `Card record field ${path} holds a card-number-like value`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item, i) => walk(kind, item, `${path}[${i}]`)); return; }
  const record = value as Record<string, unknown>;
  if ("ct" in record || "alg" in record) {
    if (!isEnvelope(record)) return fail("invalid_argument", `Card record field ${path} is a malformed encryption envelope`);
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (/^(pan|cvv|cvv2|pin|expiry|exp_month|exp_year|card_number)$/i.test(key)) return fail("invalid_argument", "Card data is never stored");
    if (/Cents$/.test(key) && child !== null && child !== undefined) {
      const pattern = kind === "card_statements" ? SIGNED_CENTS : CENTS;
      if (typeof child !== "string" || !pattern.test(child)) return fail("invalid_argument", `Card record amount ${path}.${key} must be an integer-cent string`);
    }
    walk(kind, child, `${path}.${key}`);
  }
}

export function validateCardRecord(kind: CardKind, text: string): Record<string, any> {
  const record = json(text);
  if (String(record.v) !== "1") return fail("invalid_argument", "Card record version must be 1");
  for (const field of SENSITIVE[kind]) {
    if (record[field] !== undefined && record[field] !== null && !isEnvelope(record[field])) return fail("invalid_argument", `Card record field ${field} must be encrypted`);
  }
  walk(kind, record, "record");
  return record;
}

function kindOf(value: unknown): CardKind {
  if (!cardKinds.includes(value as CardKind)) return fail("invalid_argument", "Unknown card record kind");
  return value as CardKind;
}

function opaque(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !OPAQUE.test(value)) return fail("invalid_argument", `${field} must be an opaque identifier`);
  return value;
}

function row(doc: Doc<"records"> | null) {
  if (!doc) return null;
  return { key: doc.key, record_json: doc.record_json, owner: doc.owner ?? null, connector: doc.connector ?? null, reference: doc.reference ?? null, idempotency: doc.idempotency ?? null, updated: doc.updated };
}

async function get(ctx: MutationCtx, kind: CardKind, key: string) {
  return ctx.db.query("records").withIndex("by_kind_key", q => q.eq("kind", kind).eq("key", key)).unique();
}

export async function cardOperation(ctx: MutationCtx, op: string, a: Record<string, any>): Promise<unknown> {
  const kind = kindOf(a.kind);
  if (op === "get_card_record") return row(await get(ctx, kind, opaque(a.key, "key")!));
  if (op === "find_card_record_by_idempotency") {
    const idempotency = opaque(a.idempotency, "idempotency")!;
    return row(await ctx.db.query("records").withIndex("by_kind_idempotency", q => q.eq("kind", kind).eq("idempotency", idempotency)).unique());
  }
  if (op === "list_card_records_for_owner") {
    const owner = opaque(a.owner, "owner")!, connector = opaque(a.connector, "connector")!, reference = opaque(a.reference, "reference")!;
    const limit = Math.max(1, Math.min(safeNumber(a.limit ?? 50), 200));
    const before = a.before == null ? null : string(a.before, "before");
    const query = ctx.db.query("records").withIndex("by_kind_owner_connector_reference", q => {
      const base = q.eq("kind", kind).eq("owner", owner).eq("connector", connector).eq("reference", reference);
      return before ? base.lt("updated", before) : base;
    }).order("desc");
    return (await query.take(limit)).map(row);
  }
  if (op === "scan_card_records") {
    const prefix = typeof a.prefix === "string" ? a.prefix : "";
    const after = a.after == null ? null : string(a.after, "after");
    const limit = Math.max(1, Math.min(safeNumber(a.limit ?? 50), 100));
    const start = after && after >= prefix ? after : null;
    const query = ctx.db.query("records").withIndex("by_kind_key", q => {
      const base = q.eq("kind", kind);
      return start ? base.gt("key", start) : prefix ? base.gte("key", prefix) : base;
    });
    const rows = [];
    for await (const doc of query) {
      if (!doc.key.startsWith(prefix)) break;
      rows.push(row(doc));
      if (rows.length === limit) break;
    }
    return rows;
  }
  if (op === "put_card_record") {
    const key = opaque(a.key, "key")!;
    const text = string(a.record_json, "record_json");
    const incoming = validateCardRecord(kind, text);
    const old = await get(ctx, kind, key);
    const expected = a.expected_rev == null ? null : decimal(a.expected_rev);
    const currentRev = old ? String(json(old.record_json).rev ?? "0") : null;
    if (expected === null ? old !== null : currentRev !== expected) return { written: false, record: row(old) };
    const nextRev = expected === null ? "1" : (BigInt(expected) + 1n).toString();
    if (String(incoming.rev) !== nextRev) return fail("invalid_argument", "Card record rev must advance by exactly one");
    const fields = {
      kind, key, record_json: text, updated: sorted(a.updated),
      ...(opaque(a.owner, "owner") ? { owner: a.owner } : {}),
      ...(opaque(a.connector, "connector") ? { connector: a.connector } : {}),
      ...(opaque(a.reference, "reference") ? { reference: a.reference } : {}),
      ...(opaque(a.idempotency, "idempotency") ? { idempotency: a.idempotency } : {}),
    };
    if (fields.idempotency) {
      const dup = await ctx.db.query("records").withIndex("by_kind_idempotency", q => q.eq("kind", kind).eq("idempotency", fields.idempotency)).unique();
      if (dup && dup._id !== old?._id) return fail("conflict", "Card record idempotency key already exists");
    }
    if (new TextEncoder().encode(JSON.stringify(fields)).length > 900_000) return fail("too_large", "Card record exceeds 900000 bytes");
    if (old) await ctx.db.replace(old._id, fields); else await ctx.db.insert("records", fields);
    return { written: true, record: row(await get(ctx, kind, key)) };
  }
  return fail("invalid_argument", "Unknown card operation");
}
