import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

// The same contract `outbox_scenario` checks in backend/src/storage/webhooks.rs
// for the Memory and PostgreSQL stores.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const test = () => convexTest(schema, modules);
type Test = ReturnType<typeof test>;
const call = (t: Test, operation: string, args: Record<string, any>, role: "backend" | "mcp" = "backend") => t.mutation(internal.storage.execute, { role, operation, args });
const envelope = { v: 1, alg: "A256GCM", kid: "k1", iv: "AAAAAAAAAAAAAAAA", ct: "c2VjcmV0LWNpcGhlcnRleHQtYnl0ZXM=" };
const secrets = [{ envelope, created_at_ms: 0, expires_at_ms: null }];
const subscription = (owner: string, id: string, created: number) => ({ subscription_id: id, owner_wallet: owner, url: "https://receiver.example/hook", description: null, status: "active", secrets, created_at_ms: created, updated_at_ms: created });
const create = (t: Test, owner: string, id: string, created: number) => call(t, "create_webhook_subscription", { subscription: subscription(owner, id, created), max_active: "5", max_rows: "25" });
const event = (owner: string, receipt: string, occurred: number) => ({ event_id: `evt_${receipt}`, owner_wallet: owner, event_type: "payment.receipt_ready", version: 1, receipt_address: receipt, body: `{"id":"evt_${receipt}"}`, occurred_at_ms: occurred, created_at_ms: occurred });
const payment = (id: string, receipt: string, status: string, updated: number) => JSON.stringify({ payment_id: id, idempotency_key: `key-${id}`, mandate: "mandate", invoice_hash: "00".repeat(32), receipt_address: receipt, amount: "18446744073709551615", signing_mode: "human", signature: "sig", slot: 9, status, error: null, created_at_ms: 1, updated_at_ms: updated });
const putPayment = (t: Test, record: string, events: unknown[]) => call(t, "put_payment", { record_json: record, events_json: JSON.stringify(events) });
const claim = (t: Test, now: number, token: string, lease = 60_000, max = 8) => call(t, "claim_webhook_deliveries", { now: String(now), limit: "50", lease_ms: String(lease), lease_token: token, max_attempts: String(max) });
const history = (t: Test, owner: string, sub: string) => call(t, "list_webhook_deliveries", { owner, subscription_id: sub, limit: "50" });
const complete = (t: Test, id: string, token: string, outcome: Record<string, any>, now: number) => call(t, "complete_webhook_delivery", { delivery_id: id, lease_token: token, status: null, error: null, next_attempt_at: null, now: String(now), ...outcome });

describe("owner webhook outbox", () => {
  it("matches the storage contract shared with Memory and PostgreSQL", async () => {
    const t = test(); const ev = event("owner", "rcpt", 200);
    expect(await create(t, "owner", "whk_a", 100)).toBe(true);
    expect(await create(t, "other", "whk_c", 100)).toBe(true);
    // Submitted: nothing, even when an event is offered.
    expect(await putPayment(t, payment("pay", "rcpt", "submitted", 150), [ev])).toBe(0);
    expect(await create(t, "owner", "whk_b", 300)).toBe(true);
    expect(await putPayment(t, payment("pay", "rcpt", "confirmed", 200), [ev])).toBe(1);
    for (let i = 0; i < 2; i++) expect(await putPayment(t, payment("pay", "rcpt", "confirmed", 210), [ev])).toBe(0);
    expect(await call(t, "emit_webhook_events", { events_json: JSON.stringify([ev]) })).toBe(0);
    expect(await call(t, "missing_webhook_events", { event_ids: [ev.event_id, "evt_missing"] })).toEqual(["evt_missing"]);
    expect((await call(t, "get_webhook_event", { event_id: ev.event_id })).body).toBe(ev.body);
    const rows = await history(t, "owner", "whk_a");
    expect(rows).toHaveLength(1); expect(rows[0].state).toBe("pending");
    expect(await history(t, "owner", "whk_b")).toHaveLength(0);
    // Tenant isolation.
    expect(await history(t, "other", "whk_a")).toHaveLength(0);
    expect(await call(t, "get_webhook_subscription", { owner: "other", subscription_id: "whk_a" })).toBeNull();
    expect(await call(t, "disable_webhook_subscription", { owner: "other", subscription_id: "whk_a", now: "400" })).toBeNull();
    expect(await call(t, "rotate_webhook_secrets", { owner: "other", subscription_id: "whk_a", secrets, now: "400" })).toBeNull();
    expect(await call(t, "redeliver_webhook", { owner: "other", delivery_id: rows[0].delivery_id, now: "400" })).toEqual({ result: "not_found" });
    // Leases: one holder at a time; a crashed holder's row comes back.
    const first = await claim(t, 1_000, "lease-a");
    expect(first).toHaveLength(1); expect(first[0].event_body).toBe(ev.body); expect(first[0].delivery.attempts).toBe(1);
    expect(first[0].secrets).toEqual(secrets);
    expect(await claim(t, 1_001, "lease-b")).toHaveLength(0);
    expect(await call(t, "redeliver_webhook", { owner: "owner", delivery_id: rows[0].delivery_id, now: "1002" })).toEqual({ result: "in_flight" });
    const again = await claim(t, 61_001, "lease-c");
    expect(again).toHaveLength(1); expect(again[0].delivery.event_id).toBe(ev.event_id); expect(again[0].delivery.attempts).toBe(2);
    const id = again[0].delivery.delivery_id;
    expect(await complete(t, id, "lease-a", { outcome: "delivered", status: 200 }, 61_002)).toBe(false);
    expect(await complete(t, id, "lease-c", { outcome: "retry_scheduled", status: 500, error: "x".repeat(500), next_attempt_at: "90000" }, 61_003)).toBe(true);
    let row = (await history(t, "owner", "whk_a"))[0];
    expect(row.state).toBe("retry_scheduled"); expect(row.last_status).toBe(500); expect(row.last_error).toHaveLength(200);
    expect(await claim(t, 89_999, "lease-d")).toHaveLength(0);
    expect(await claim(t, 90_000, "lease-e")).toHaveLength(1);
    expect(await complete(t, id, "lease-e", { outcome: "delivered", status: 204 }, 90_001)).toBe(true);
    row = (await history(t, "owner", "whk_a"))[0];
    expect(row.state).toBe("delivered"); expect(row.delivered_at_ms).toBe(90_001);
    const scheduled = await call(t, "redeliver_webhook", { owner: "owner", delivery_id: id, now: "95000" });
    expect(scheduled.result).toBe("scheduled"); expect(scheduled.delivery.attempts).toBe(0); expect(scheduled.delivery.event_id).toBe(ev.event_id);
    expect(scheduled.delivery.delivered_at_ms).toBeNull();
    expect((await history(t, "owner", "whk_a"))[0].delivered_at_ms).toBeNull();
    // Attempt cap: an expired lease at the cap is exhausted, not re-sent.
    expect(await claim(t, 95_000, "lease-f", 1_000, 1)).toHaveLength(1);
    expect(await claim(t, 96_000, "lease-g", 1_000, 1)).toHaveLength(0);
    expect((await history(t, "owner", "whk_a"))[0].state).toBe("exhausted");
    // Disabling closes queued work and refuses redelivery and rotation.
    expect((await call(t, "redeliver_webhook", { owner: "owner", delivery_id: id, now: "97000" })).result).toBe("scheduled");
    expect((await call(t, "disable_webhook_subscription", { owner: "owner", subscription_id: "whk_a", now: "98000" })).status).toBe("disabled");
    expect((await history(t, "owner", "whk_a"))[0].state).toBe("exhausted");
    expect(await call(t, "redeliver_webhook", { owner: "owner", delivery_id: id, now: "99000" })).toEqual({ result: "endpoint_disabled" });
    expect(await call(t, "rotate_webhook_secrets", { owner: "owner", subscription_id: "whk_a", secrets, now: "99000" })).toBeNull();
    const rotated = [{ envelope: { ...envelope, kid: "k2" }, created_at_ms: 99_000, expires_at_ms: null }];
    expect((await call(t, "rotate_webhook_secrets", { owner: "owner", subscription_id: "whk_b", secrets: rotated, now: "99000" })).secrets).toEqual(rotated);
    // Cap on active endpoints per owner.
    for (let n = 0; n < 4; n++) expect(await create(t, "owner", `whk_cap${n}`, 100_000)).toBe(true);
    expect(await create(t, "owner", "whk_over", 100_000)).toBe(false);
    const listed = await call(t, "list_webhook_subscriptions", { owner: "owner" });
    expect(listed.filter((s: any) => s.status === "active")).toHaveLength(5);
    expect(listed.every((s: any) => s.owner_wallet === "owner")).toBe(true);
    // Reconcile listing finds the confirmed payment.
    const page = await call(t, "list_confirmed_payments", { since: "0", before: "999999999999999", limit: "10" });
    expect(page.map((r: string) => JSON.parse(r).payment_id)).toContain("pay");
  });

  it("fans a confirmed batch out per receipt, once", async () => {
    const t = test(); await create(t, "o", "whk_1", 1);
    const tx = (status: string, updated: number) => JSON.stringify({ transaction_id: "t", idempotency_key: "o:k", signature: "s", slot: null, status, error: null, created_at_ms: 1, updated_at_ms: updated });
    const events = JSON.stringify([event("o", "r1", 5), event("o", "r2", 5)]);
    expect(await call(t, "put_transaction", { record_json: tx("submitted", 2), events_json: events })).toBe(0);
    expect(await call(t, "put_transaction", { record_json: tx("confirmed", 5), events_json: events })).toBe(2);
    expect(await call(t, "put_transaction", { record_json: tx("confirmed", 6), events_json: events })).toBe(0);
    expect(await history(t, "o", "whk_1")).toHaveLength(2);
  });

  it("refuses plaintext secrets and non-https endpoints, and stays backend-only", async () => {
    const t = test();
    await expect(call(t, "create_webhook_subscription", { subscription: { ...subscription("o", "whk_p", 1), secrets: [{ envelope: "whsec_plain", created_at_ms: 0, expires_at_ms: null }] }, max_active: "5", max_rows: "25" })).rejects.toThrow(/encrypted/);
    await expect(call(t, "create_webhook_subscription", { subscription: { ...subscription("o", "whk_h", 1), url: "http://receiver.example/" }, max_active: "5", max_rows: "25" })).rejects.toThrow(/https/);
    await expect(call(t, "list_webhook_subscriptions", { owner: "o" }, "mcp")).rejects.toThrow(/not allowed/);
    // Old-shape put_payment (no events) keeps working.
    expect(await call(t, "put_payment", { record_json: payment("p", "r", "confirmed", 5) })).toBeNull();
    expect(await call(t, "missing_webhook_events", { event_ids: ["evt_r"] })).toEqual(["evt_r"]);
  });

  it("pages confirmed payments newest first without skipping ties", async () => {
    const t = test();
    for (const [id, updated] of [["a", 5], ["b", 4], ["c", 4], ["d", 4], ["e", 3]] as const) await call(t, "put_payment", { record_json: payment(id, `r${id}`, "confirmed", updated) });
    await call(t, "put_payment", { record_json: payment("z", "rz", "submitted", 6) });
    const first = (await call(t, "list_confirmed_payments", { since: "0", before: "9", limit: "2" })).map((r: string) => JSON.parse(r).payment_id);
    expect(first.sort()).toEqual(["a", "b", "c", "d"]);
    const next = (await call(t, "list_confirmed_payments", { since: "0", before: "4", limit: "2" })).map((r: string) => JSON.parse(r).payment_id);
    expect(next).toEqual(["e"]);
  });
});
