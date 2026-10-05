import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { fail, getRecord, json, safeNumber, sorted, string } from "./records";
import { isEnvelope } from "./cards";

/*
 * Owner webhook outbox (docs/guides/owner-webhooks.md). Mirrors
 * backend/src/storage/webhooks.rs: the Rust tests and convex/webhooks.test.ts
 * run the same scenario against Memory/Postgres and this module.
 *
 * - Events are written inside the same `execute` mutation (one transaction)
 *   that moves a payment or batch transaction to `confirmed`.
 * - One event per (receipt, type, version); one delivery per event x active
 *   subscription that existed when the payment confirmed.
 * - Deliveries are leased with a token; only the holder records an outcome.
 * - Signing secrets arrive as AES-GCM envelopes sealed by Axum. A plaintext
 *   `whsec_` value is refused.
 */

export const webhookOperations = ["emit_webhook_events", "missing_webhook_events", "get_webhook_event", "list_confirmed_payments", "list_confirmed_transactions", "create_webhook_subscription", "list_webhook_subscriptions", "get_webhook_subscription", "disable_webhook_subscription", "rotate_webhook_secrets", "claim_webhook_deliveries", "complete_webhook_delivery", "list_webhook_deliveries", "redeliver_webhook"] as const;
export const webhookReadOperations = ["missing_webhook_events", "get_webhook_event", "list_confirmed_payments", "list_confirmed_transactions", "list_webhook_subscriptions", "get_webhook_subscription", "list_webhook_deliveries"] as const;

const ID = /^[A-Za-z0-9_-]{1,120}$/;
const DISABLED = "Endpoint disabled before delivery";
const MAX_ERROR = 200;
type Delivery = Doc<"webhook_deliveries">;
type DeliveryState = Delivery["state"];
type Event = { event_id: string; owner_wallet: string; event_type: string; version: number; receipt_address: string; body: string; occurred_at_ms: number; created_at_ms: number };

const id = (value: unknown, field: string) => { const s = string(value, field); if (!ID.test(s)) return fail("invalid_argument", `${field} must be an opaque identifier`); return s; };
const wallet = (value: unknown) => { const s = string(value, "owner").trim(); if (s.length > 64) return fail("invalid_argument", "owner is too long"); return s; };
const truncate = (text: string) => Array.from(text).slice(0, MAX_ERROR).join("");

function validEvent(raw: unknown): Event {
  if (!raw || typeof raw !== "object") return fail("invalid_argument", "Invalid webhook event");
  const e = raw as Record<string, unknown>;
  const body = string(e.body, "body");
  if (body.length > 16_384) return fail("invalid_argument", "Webhook event body is too large");
  JSON.parse(body);
  const version = safeNumber(e.version);
  if (version < 1) return fail("invalid_argument", "Invalid event version");
  return { event_id: id(e.event_id, "event_id"), owner_wallet: wallet(e.owner_wallet), event_type: string(e.event_type, "event_type"), version, receipt_address: string(e.receipt_address, "receipt_address"), body, occurred_at_ms: safeNumber(e.occurred_at_ms), created_at_ms: safeNumber(e.created_at_ms) };
}

export function parseEvents(text: unknown): Event[] {
  if (typeof text !== "string" || text.length > 400_000) return fail("invalid_argument", "events_json must be a string");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > 50) return fail("invalid_argument", "events_json must be a list of up to 50 events");
  return parsed.map(validEvent);
}

function validSecrets(value: unknown): string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return fail("invalid_argument", "Secret set must hold one or two entries");
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || !isEnvelope(entry.envelope)) return fail("invalid_argument", "Webhook secrets must be encrypted");
    safeNumber(entry.created_at_ms);
    if (entry.expires_at_ms !== null) safeNumber(entry.expires_at_ms);
  }
  const text = JSON.stringify(value);
  if (text.includes("whsec_")) return fail("invalid_argument", "Webhook secrets must be encrypted");
  return text;
}

function subscriptionRow(doc: Doc<"webhook_subscriptions"> | null) {
  if (!doc) return null;
  const { _id, _creationTime, secrets_json, ...rest } = doc;
  return { ...rest, secrets: JSON.parse(secrets_json) };
}

function deliveryRow(doc: Delivery) { const { _id, _creationTime, ...rest } = doc; return rest; }

const subscriptionById = (ctx: MutationCtx, subscription_id: string) => ctx.db.query("webhook_subscriptions").withIndex("by_subscription_id", q => q.eq("subscription_id", subscription_id)).unique();
const deliveryById = (ctx: MutationCtx, delivery_id: string) => ctx.db.query("webhook_deliveries").withIndex("by_delivery_id", q => q.eq("delivery_id", delivery_id)).unique();
const eventById = (ctx: MutationCtx, event_id: string) => ctx.db.query("webhook_events").withIndex("by_event_id", q => q.eq("event_id", event_id)).unique();
const tail = (value: string) => value.includes("_") ? value.slice(value.indexOf("_") + 1) : value;
export const deliveryId = (event_id: string, subscription_id: string) => `dlv_${tail(event_id)}_${tail(subscription_id)}`;

/** Insert one event and fan it out. False when it already exists. */
export async function emitEvent(ctx: MutationCtx, event: Event): Promise<boolean> {
  if (await eventById(ctx, event.event_id)) return false;
  const same = await ctx.db.query("webhook_events").withIndex("by_receipt_type_version", q => q.eq("receipt_address", event.receipt_address).eq("event_type", event.event_type).eq("version", event.version)).first();
  if (same) return false;
  await ctx.db.insert("webhook_events", event);
  const subscriptions = await ctx.db.query("webhook_subscriptions").withIndex("by_owner_created", q => q.eq("owner_wallet", event.owner_wallet).lte("created_at_ms", event.occurred_at_ms)).take(100);
  for (const subscription of subscriptions) {
    if (subscription.status !== "active") continue;
    const delivery_id = deliveryId(event.event_id, subscription.subscription_id);
    if (await deliveryById(ctx, delivery_id)) continue;
    await ctx.db.insert("webhook_deliveries", { delivery_id, event_id: event.event_id, subscription_id: subscription.subscription_id, owner_wallet: event.owner_wallet, event_type: event.event_type, receipt_address: event.receipt_address, state: "pending", attempts: 0, next_attempt_at_ms: event.created_at_ms, lease_token: null, lease_expires_at_ms: null, last_status: null, last_error: null, delivered_at_ms: null, created_at_ms: event.created_at_ms, updated_at_ms: event.created_at_ms });
  }
  return true;
}

/**
 * After `writeRecord`, in the same mutation: emit the offered events only if
 * the stored row now reads `confirmed` (and, for a payment, names the receipt).
 */
export async function emitAfterWrite(ctx: MutationCtx, kind: "payments" | "transactions", key: string, eventsJson: unknown): Promise<number> {
  const events = parseEvents(eventsJson);
  const stored = await getRecord(ctx, kind, key);
  if (!stored) return 0;
  const record = json(stored.record_json);
  if (record.status !== "confirmed") return 0;
  let created = 0;
  for (const event of events) {
    if (kind === "payments" && record.receipt_address !== event.receipt_address) continue;
    if (await emitEvent(ctx, event)) created++;
  }
  return created;
}

async function confirmedPage(ctx: MutationCtx, kind: "payments" | "transactions", a: Record<string, any>): Promise<string[]> {
  const limit = Math.max(1, Math.min(safeNumber(a.limit ?? 100), 200));
  const since = sorted(a.since), before = sorted(a.before);
  const query = ctx.db.query("records").withIndex("by_kind_owner_updated", q => q.eq("kind", kind).eq("owner", undefined).gte("updated", since).lt("updated", before)).order("desc");
  const rows: string[] = []; let boundary: string | null = null; let scanned = 0;
  for await (const row of query) {
    if (++scanned > 5_000) break;
    if (boundary !== null && row.updated < boundary) break;
    if (json(row.record_json).status !== "confirmed") continue;
    rows.push(row.record_json);
    // Keep rows tied with the page's oldest time so the next page skips none.
    if (rows.length === limit) boundary = row.updated;
  }
  return rows;
}

function claimAction(d: Delivery, active: boolean, maxAttempts: number): "claim" | string {
  if (!active) return DISABLED;
  if (d.attempts >= maxAttempts) return "Attempt limit reached; the last attempt's outcome was not recorded";
  return "claim";
}

export async function webhookOperation(ctx: MutationCtx, op: string, a: Record<string, any>): Promise<unknown> {
  if (op === "emit_webhook_events") {
    let created = 0;
    for (const event of parseEvents(a.events_json)) if (await emitEvent(ctx, event)) created++;
    return created;
  }
  if (op === "missing_webhook_events") {
    if (!Array.isArray(a.event_ids) || a.event_ids.length > 200) return fail("invalid_argument", "event_ids must be a list of up to 200 ids");
    const missing: string[] = [];
    for (const event_id of a.event_ids) if (!await eventById(ctx, id(event_id, "event_id"))) missing.push(event_id);
    return missing;
  }
  if (op === "get_webhook_event") {
    const event = await eventById(ctx, id(a.event_id, "event_id"));
    if (!event) return null;
    const { _id, _creationTime, ...rest } = event; return rest;
  }
  if (op === "list_confirmed_payments") return confirmedPage(ctx, "payments", a);
  if (op === "list_confirmed_transactions") return confirmedPage(ctx, "transactions", a);
  if (op === "create_webhook_subscription") {
    const s = a.subscription ?? {};
    const owner = wallet(s.owner_wallet);
    const url = string(s.url, "url");
    if (!url.startsWith("https://") || url.length > 2048) return fail("invalid_argument", "Webhook URL must be https");
    const description = s.description == null ? null : string(s.description, "description");
    if (description !== null && Array.from(description).length > 80) return fail("invalid_argument", "Label is too long");
    if (s.status !== "active") return fail("invalid_argument", "A new endpoint must be active");
    const row = { subscription_id: id(s.subscription_id, "subscription_id"), owner_wallet: owner, url, description, status: "active" as const, secrets_json: validSecrets(s.secrets), created_at_ms: safeNumber(s.created_at_ms), updated_at_ms: safeNumber(s.updated_at_ms) };
    const maxActive = safeNumber(a.max_active), maxRows = safeNumber(a.max_rows);
    const owned = await ctx.db.query("webhook_subscriptions").withIndex("by_owner_created", q => q.eq("owner_wallet", owner)).take(maxRows + 1);
    if (owned.length >= maxRows || owned.filter(o => o.status === "active").length >= maxActive) return false;
    if (await subscriptionById(ctx, row.subscription_id)) return false;
    await ctx.db.insert("webhook_subscriptions", row);
    return true;
  }
  if (op === "list_webhook_subscriptions") {
    const rows = await ctx.db.query("webhook_subscriptions").withIndex("by_owner_created", q => q.eq("owner_wallet", wallet(a.owner))).order("desc").take(100);
    return rows.map(subscriptionRow);
  }
  if (op === "get_webhook_subscription" || op === "disable_webhook_subscription" || op === "rotate_webhook_secrets") {
    const found = await subscriptionById(ctx, id(a.subscription_id, "subscription_id"));
    // Another owner's id reads exactly like a missing one.
    if (!found || found.owner_wallet !== wallet(a.owner)) return null;
    if (op === "get_webhook_subscription") return subscriptionRow(found);
    const now = safeNumber(a.now);
    if (op === "rotate_webhook_secrets") {
      if (found.status !== "active") return null;
      await ctx.db.patch(found._id, { secrets_json: validSecrets(a.secrets), updated_at_ms: now });
      return subscriptionRow(await ctx.db.get(found._id));
    }
    if (found.status === "active") await ctx.db.patch(found._id, { status: "disabled", updated_at_ms: now });
    for (const state of ["pending", "retry_scheduled"] as const) {
      const queued = await ctx.db.query("webhook_deliveries").withIndex("by_subscription_state", q => q.eq("subscription_id", found.subscription_id).eq("state", state)).take(1_000);
      for (const d of queued) await ctx.db.patch(d._id, { state: "exhausted", last_error: DISABLED, lease_token: null, lease_expires_at_ms: null, updated_at_ms: now });
    }
    return subscriptionRow(await ctx.db.get(found._id));
  }
  if (op === "claim_webhook_deliveries") {
    const now = safeNumber(a.now), leaseMs = safeNumber(a.lease_ms), maxAttempts = safeNumber(a.max_attempts);
    const limit = Math.max(1, Math.min(safeNumber(a.limit ?? 10), 50));
    const token = id(a.lease_token, "lease_token");
    const due: Delivery[] = [];
    for (const state of ["pending", "retry_scheduled", "delivering"] as const) {
      due.push(...await ctx.db.query("webhook_deliveries").withIndex("by_state_next", q => q.eq("state", state).lte("next_attempt_at_ms", now)).take(limit));
    }
    due.sort((x, y) => x.next_attempt_at_ms - y.next_attempt_at_ms || (x.delivery_id < y.delivery_id ? -1 : 1));
    const claimed = [];
    for (const d of due.slice(0, limit)) {
      const subscription = await subscriptionById(ctx, d.subscription_id);
      const event = await eventById(ctx, d.event_id);
      const action = !subscription || !event ? "Event or endpoint record missing" : claimAction(d, subscription.status === "active", maxAttempts);
      if (action !== "claim") { await ctx.db.patch(d._id, { state: "exhausted", lease_token: null, lease_expires_at_ms: null, last_error: action, updated_at_ms: now }); continue; }
      const patch = { state: "delivering" as const, attempts: d.attempts + 1, lease_token: token, lease_expires_at_ms: now + leaseMs, next_attempt_at_ms: now + leaseMs, updated_at_ms: now };
      await ctx.db.patch(d._id, patch);
      claimed.push({ delivery: deliveryRow({ ...d, ...patch }), event_body: event!.body, url: subscription!.url, secrets: JSON.parse(subscription!.secrets_json) });
    }
    return claimed;
  }
  if (op === "complete_webhook_delivery") {
    const d = await deliveryById(ctx, id(a.delivery_id, "delivery_id"));
    if (!d || d.state !== "delivering" || d.lease_token !== string(a.lease_token, "lease_token")) return false;
    const now = safeNumber(a.now);
    const status = a.status == null ? null : safeNumber(a.status);
    if (status !== null && (status < 100 || status > 599)) return fail("invalid_argument", "Invalid HTTP status");
    const base = { lease_token: null, lease_expires_at_ms: null, updated_at_ms: now, last_status: status };
    if (a.outcome === "delivered") await ctx.db.patch(d._id, { ...base, state: "delivered" as DeliveryState, last_error: null, delivered_at_ms: now });
    else if (a.outcome === "retry_scheduled") await ctx.db.patch(d._id, { ...base, state: "retry_scheduled" as DeliveryState, last_error: truncate(string(a.error, "error")), next_attempt_at_ms: safeNumber(a.next_attempt_at) });
    else if (a.outcome === "exhausted") await ctx.db.patch(d._id, { ...base, state: "exhausted" as DeliveryState, last_error: truncate(string(a.error, "error")) });
    else return fail("invalid_argument", "Unknown delivery outcome");
    return true;
  }
  if (op === "list_webhook_deliveries") {
    const owner = wallet(a.owner); const limit = Math.max(1, Math.min(safeNumber(a.limit ?? 25), 100));
    const rows = await ctx.db.query("webhook_deliveries").withIndex("by_subscription_created", q => q.eq("subscription_id", id(a.subscription_id, "subscription_id"))).order("desc").take(limit);
    return rows.filter(d => d.owner_wallet === owner).map(deliveryRow);
  }
  if (op === "redeliver_webhook") {
    const d = await deliveryById(ctx, id(a.delivery_id, "delivery_id"));
    if (!d || d.owner_wallet !== wallet(a.owner)) return { result: "not_found" };
    if (d.state === "pending" || d.state === "delivering") return { result: "in_flight" };
    const subscription = await subscriptionById(ctx, d.subscription_id);
    if (!subscription || subscription.status !== "active") return { result: "endpoint_disabled" };
    const now = safeNumber(a.now);
    const patch = { state: "pending" as const, attempts: 0, next_attempt_at_ms: now, lease_token: null, lease_expires_at_ms: null, updated_at_ms: now };
    await ctx.db.patch(d._id, patch);
    return { result: "scheduled", delivery: deliveryRow({ ...d, ...patch }) };
  }
  return fail("invalid_argument", "Unknown webhook operation");
}
