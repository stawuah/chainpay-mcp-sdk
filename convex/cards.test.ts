import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const test = () => convexTest(schema, modules);
type Test = ReturnType<typeof test>;
const call = (t: Test, operation: string, args: Record<string, any>, role: "backend" | "mcp" = "backend") => t.mutation(internal.storage.execute, { role, operation, args });
const envelope = { v: 1, alg: "A256GCM", kid: "k1", iv: "AAAAAAAAAAAAAAAA", ct: "c2VjcmV0LWNpcGhlcnRleHQtYnl0ZXM=" };
const card = (rev: number, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, rev, cardId: "c".repeat(64), issuer: envelope, label: envelope, ...extra });
const put = (t: Test, rev: number, expected: string | null, extra: Record<string, unknown> = {}, key = "card:" + "c".repeat(64)) =>
  call(t, "put_card_record", { kind: "cards", key, record_json: card(rev, extra), owner: "OwnerWallet111", connector: "lithic", reference: "card", idempotency: "a".repeat(64), expected_rev: expected, updated: "1000" });

describe("card records", () => {
  it("creates once, compare-and-swaps on rev, and finds by idempotency", async () => {
    const t = test();
    expect((await put(t, 1, null)).written).toBe(true);
    const again = await put(t, 1, null);
    expect(again.written).toBe(false);
    expect(JSON.parse(again.record.record_json).rev).toBe(1);
    expect((await put(t, 2, "1")).written).toBe(true);
    expect((await put(t, 2, "1")).written).toBe(false);
    await expect(put(t, 5, "2")).rejects.toThrow(/advance/);
    const found = await call(t, "find_card_record_by_idempotency", { kind: "cards", idempotency: "a".repeat(64) });
    expect(JSON.parse(found.record_json).rev).toBe(2);
    const listed = await call(t, "list_card_records_for_owner", { kind: "cards", owner: "OwnerWallet111", connector: "lithic", reference: "card", limit: 10 });
    expect(listed).toHaveLength(1);
    expect(await call(t, "list_card_records_for_owner", { kind: "cards", owner: "Other", connector: "lithic", reference: "card", limit: 10 })).toHaveLength(0);
    await expect(put(t, 1, null, {}, "card:" + "d".repeat(64))).rejects.toThrow(/idempotency/);
  });

  it("refuses plaintext sensitive fields, card numbers and inexact amounts", async () => {
    const t = test();
    await expect(call(t, "put_card_record", { kind: "cards", key: "card:x", record_json: JSON.stringify({ v: 1, rev: 1, issuer: { cardToken: "plain" } }), updated: "1" })).rejects.toThrow(/encrypted/);
    await expect(call(t, "put_card_record", { kind: "card_events", key: "asa:t", record_json: JSON.stringify({ v: 1, rev: 1, note: "card 4111111111111111" }), updated: "1" })).rejects.toThrow(/card-number/);
    await expect(call(t, "put_card_record", { kind: "card_events", key: "asa:t", record_json: JSON.stringify({ v: 1, rev: 1, pan: "x" }), updated: "1" })).rejects.toThrow(/never stored/);
    await expect(call(t, "put_card_record", { kind: "card_events", key: "asa:t", record_json: JSON.stringify({ v: 1, rev: 1, amountCents: 20.5 }), updated: "1" })).rejects.toThrow(/integer-cent/);
    await expect(call(t, "put_card_record", { kind: "card_events", key: "asa:t", record_json: JSON.stringify({ v: 1, rev: 1, provider: { ...envelope, alg: "none" } }), updated: "1" })).rejects.toThrow(/encrypted|envelope/);
    await expect(call(t, "put_card_record", { kind: "card_events", key: "asa:t", record_json: JSON.stringify({ v: 2, rev: 1 }), updated: "1" })).rejects.toThrow(/version/);
    await expect(call(t, "put_card_record", { kind: "card_events", key: "asa t", record_json: JSON.stringify({ v: 1, rev: 1 }), updated: "1" })).rejects.toThrow(/opaque/);
    // Hex digests and base58 signatures with long digit runs are identifiers, not card numbers.
    expect((await call(t, "put_card_record", { kind: "card_events", key: "intent:i", record_json: JSON.stringify({ v: 1, rev: 1, capabilityHash: "ab" + "4111111111111111" + "c".repeat(46), perTx: "3x" + "4111111111111111" + "Z".repeat(60) }), updated: "1" })).written).toBe(true);
    await expect(call(t, "put_card_record", { kind: "card_events", key: "asa:u", record_json: JSON.stringify({ v: 1, rev: 1, note: "4111111111111111" }), updated: "1" })).rejects.toThrow(/card-number/);
    expect((await call(t, "put_card_record", { kind: "card_statements", key: "stmt:c:1", record_json: JSON.stringify({ v: 1, rev: 1, totalCents: "-250", lines: envelope }), updated: "1" })).written).toBe(true);
    // Statement postings and recovery reports are sealed too.
    await expect(call(t, "put_card_record", { kind: "card_events", key: "post:c:e", record_json: JSON.stringify({ v: 1, rev: 1, type: "posting", line: { kind: "purchase", amountCents: "2000" } }), updated: "1" })).rejects.toThrow(/encrypted/);
    expect((await call(t, "put_card_record", { kind: "card_events", key: "post:c:f", record_json: JSON.stringify({ v: 1, rev: 1, type: "posting", line: envelope }), updated: "1" })).written).toBe(true);
    await expect(call(t, "put_card_record", { kind: "cards", key: "card:r", record_json: JSON.stringify({ v: 1, rev: 1, recoveryReport: { numbers: [] } }), updated: "1" })).rejects.toThrow(/encrypted/);
  });

  it("scans by key prefix with a resumable cursor and keeps card ops off the MCP role", async () => {
    const t = test();
    for (const id of ["a", "b", "c"]) await call(t, "put_card_record", { kind: "cards", key: `card:${id.repeat(64)}`, record_json: card(1), updated: "1" });
    const first = await call(t, "scan_card_records", { kind: "cards", prefix: "card:", limit: 2 });
    expect(first.map((r: any) => r.key[5])).toEqual(["a", "b"]);
    const rest = await call(t, "scan_card_records", { kind: "cards", prefix: "card:", after: first[1].key, limit: 2 });
    expect(rest.map((r: any) => r.key[5])).toEqual(["c"]);
    await expect(call(t, "get_card_record", { kind: "cards", key: "card:x" }, "mcp")).rejects.toThrow(/not allowed/);
  });
});
