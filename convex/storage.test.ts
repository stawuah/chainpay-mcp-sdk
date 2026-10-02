import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { parse, stringify } from "lossless-json";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const test = () => convexTest(schema, modules);
type Test = ReturnType<typeof test>;
const call = (t: Test, operation: string, args: Record<string, any>, role: "backend" | "mcp" = "backend") => t.mutation(internal.storage.execute, { role, operation, args });
const payment = (status = "prepared", updated = 100) => JSON.stringify({ payment_id: "p1", idempotency_key: "owner:key", mandate: "mandate", invoice_hash: "hash", receipt_address: "receipt", amount: "18446744073709551615", signing_mode: "human", status, created_at_ms: 100, updated_at_ms: updated });
afterEach(() => vi.unstubAllEnvs());

describe("storage invariants", () => {
  it("preserves full-width nested numbers and grants exactly one operation claim", async () => {
    const t = test(); const intent = '{"amount":18446744073709551615,"nested":{"slot":9007199254740993}}';
    const args = { id: "op", owner: "owner", intent_json: intent, initial_json: "{}" };
    const results = await Promise.all([call(t, "claim_operation", args), call(t, "claim_operation", { ...args, owner: "other" })]);
    expect(results.filter(r => r[0])).toHaveLength(1);
    const original = results.find(r => r[0]);
    expect(await call(t, "operation_record", { id: "op" })).toEqual(original.slice(1));
    expect(results[0][2]).toBe(intent); expect(results[1][2]).toBe(intent);
  });
  it("retains terminal records, exact amounts, and uniqueness", async () => {
    const t = test(); await call(t, "put_payment", { record_json: payment("confirmed", 200) });
    await call(t, "put_payment", { record_json: payment("submitted", 300) });
    const read = await call(t, "get_payment", { payment_id: "p1" });
    expect(JSON.parse(read).status).toBe("confirmed"); expect(JSON.parse(read).amount).toBe("18446744073709551615");
    await expect(call(t, "put_payment", { record_json: payment().replace('"p1"', '"p2"') })).rejects.toThrow(/Idempotency/);
  });
  it("consumes challenges and auth once across concurrent requests", async () => {
    const t = test(); const challenge = { challenge_id: "c", owner_wallet: "w", mandate_pda: "m", message: "msg", expires_at_ms: 200, consumed_at_ms: null, created_at_ms: 100 };
    await call(t, "put_managed_signer_challenge", { challenge_json: JSON.stringify(challenge) });
    const results = await Promise.all([call(t, "consume_managed_signer_challenge", { challenge_id: "c", consumed_at_ms: "200" }), call(t, "consume_managed_signer_challenge", { challenge_id: "c", consumed_at_ms: "200" })]);
    expect(results.sort()).toEqual([false, true]);
    await call(t, "put_auth", { key: "nonce", value_json: '{"nested":18446744073709551615}', expires: "200" });
    const auth = await Promise.all([call(t, "get_auth", { key: "nonce", now: "199", consume: true }), call(t, "get_auth", { key: "nonce", now: "199", consume: true })]);
    expect(auth.filter(Boolean)).toEqual(['{"nested":18446744073709551615}']);
  });
  it("preserves x402 proof numbers while merging updates and rejects regressions", async () => {
    const t = test();
    const record = '{"x402_payment_id":"x","idempotency_key":"owner:key","resource":"https://merchant","payment_id":null,"status":"confirmed","challenge":{"amount":18446744073709551615},"proof":{"slot":9007199254740993},"response_status":200,"created_at_ms":100,"updated_at_ms":200}';
    await call(t, "put_x402", { record_json: record });
    await call(t, "put_x402", { record_json: record.replace('"confirmed"', '"prepared"').replace('"updated_at_ms":200', '"updated_at_ms":300') });
    expect(await call(t, "find_x402_by_idempotency", { key: "owner:key" })).toBe(record);
    await call(t, "put_x402", { record_json: record.replace('"confirmed"', '"verified"').replace('"proof":{"slot":9007199254740993}', '"proof":null') });
    expect(await call(t, "find_x402_by_idempotency", { key: "owner:key" })).toContain('"proof":{"slot":9007199254740993}');
  });
  it("enforces immutable seller statements", async () => {
    const t = test(); const record = { cluster: "devnet", program_id: "program", receipt_address: "receipt", seller: "seller", content_hash: "a".repeat(64), canonical_payload: "signed", signature: "sig", served_at: "2026-10-02T00:00:00Z", published_at_ms: 100 };
    const put = (r: unknown) => call(t, "put_delivery_attestation", { record_json: JSON.stringify(r) });
    expect((await put(record)).kind).toBe("created"); expect((await put(record)).kind).toBe("unchanged");
    const conflict = await put({ ...record, signature: "different", published_at_ms: 200 }); expect(conflict.kind).toBe("conflict"); expect(JSON.parse(conflict.record_json).published_at_ms).toBe(100);
  });
  it("shares counters, rejects cross-service operations, and revokes only the owner", async () => {
    const t = test(); const record = { id: "conn", tokenHash: "a".repeat(64), wallet: "owner", agentName: "agent", scope: "scope", connectedAt: "2026-10-02T00:00:00.000Z", lastSeenAt: null, totalCalls: 0, toolsCalled: [], revokedAt: null };
    await call(t, "mcp.register", { record }, "mcp");
    expect(await call(t, "auth_connection", { hash: record.tokenHash })).toEqual({ wallet: "owner", scope: "scope" });
    expect(await call(t, "mcp.revoke", { wallet: "other", id: "conn", now: record.connectedAt }, "mcp")).toBe(false);
    await expect(call(t, "put_payment", { record_json: payment() }, "mcp")).rejects.toThrow(/not allowed/);
    const counters = await Promise.all(Array.from({ length: 5 }, () => call(t, "mcp.rateLimit", { key: "agent", now: "100", limit: 3, windowMs: 1000 }, "mcp")));
    expect(counters.filter(Boolean)).toHaveLength(3);
    expect(await call(t, "mcp.revoke", { wallet: "owner", id: "conn", now: record.connectedAt }, "mcp")).toBe(true);
    expect(await call(t, "auth_connection", { hash: record.tokenHash })).toBeNull();
  });
  it("fails closed for missing credentials and isolates service HTTP permissions", async () => {
    const t = test();
    const request = (token: string, operation: string, args = {}) => t.fetch("/internal/storage/v1", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, args }) });
    expect((await request("bad", "ping")).status).toBe(401);
    vi.stubEnv("CHAINPAY_CONVEX_MCP_SECRET", "m".repeat(32)); vi.stubEnv("CHAINPAY_CONVEX_BACKEND_SECRET", "b".repeat(32));
    expect((await request("m".repeat(32), "put_payment")).status).toBe(403);
    expect(await (await request("b".repeat(32), "ping")).json()).toEqual({ value: { version: 1 } });
    vi.stubEnv("CHAINPAY_MAINTENANCE", "true");
    expect((await request("b".repeat(32), "put_payment", { record_json: payment() })).status).toBe(503);
  });
  it("rejects dangling payment references and invalid numeric or signer states", async () => {
    const t = test();
    const x402 = { x402_payment_id: "x", idempotency_key: "w:key", status: "prepared", payment_id: "missing", created_at_ms: 1, updated_at_ms: 1 };
    await expect(call(t, "put_x402", { record_json: JSON.stringify(x402) })).rejects.toThrow(/Linked payment/);
    await expect(call(t, "put_payment", { record_json: payment().replace('"18446744073709551615"', '"18446744073709551616"') })).rejects.toThrow(/unsigned 64-bit/);
    await expect(call(t, "put_payment", { record_json: payment().replace('"human"', '"unknown"') })).rejects.toThrow(/signing mode/);
    const signer = { signer_id: "s", owner_wallet: "w", mandate_pda: "m", public_key: "p", provider: "privy", provider_wallet_id: "id", provider_policy_id: "policy", signing_mode: "delegated", status: "unknown", created_at_ms: 1, updated_at_ms: 1 };
    await expect(call(t, "put_managed_signer", { signer_json: JSON.stringify(signer) })).rejects.toThrow(/signer status/);
  });
  it("blocks HTTP migration unless both gates are enabled and isolates reads by wallet", async () => {
    const t = test(); vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_SECRET", "g".repeat(32)); vi.stubEnv("CHAINPAY_CONVEX_MCP_SECRET", "m".repeat(32));
    const request = (token: string, operation: string, args: unknown) => t.fetch("/internal/storage/v1", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, args }) });
    expect((await request("g".repeat(32), "migration.export", { table: "payments", cursor: null, limit: 10 })).status).toBe(403);
    vi.stubEnv("CHAINPAY_MAINTENANCE", "true"); vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_ENABLED", "true");
    expect((await request("m".repeat(32), "migration.export", { table: "payments", cursor: null, limit: 10 })).status).toBe(403);
    expect((await request("g".repeat(32), "migration.export", { table: "payments", cursor: null, limit: 10 })).status).toBe(200);
    vi.stubEnv("CHAINPAY_MAINTENANCE", "false");
    for (const wallet of ["owner", "other"]) {
      const record = { id: wallet, wallet, role: "assistant", content_json: '{"amount":18446744073709551615}', createdAt: "2026-10-02T00:00:00.000Z" };
      expect((await request("m".repeat(32), "mcp.appendInboxMessage", { record })).status).toBe(200);
    }
    const response = await (await request("m".repeat(32), "mcp.listInbox", { wallet: "owner", limit: 10 })).json();
    expect(response.value).toHaveLength(1); expect(response.value[0].wallet).toBe("owner"); expect(response.value[0].content_json).toContain("18446744073709551615");
  });
});

describe("migration fidelity", () => {
  it("exports challenge consumption, connection observations, and revocation after import", async () => {
    const t = test(); vi.stubEnv("CHAINPAY_MAINTENANCE", "true"); vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_ENABLED", "true");
    const original = "2026-10-02T00:00:00.123456+00:00"; const now = "2026-10-02T00:00:00.123Z";
    const connection = { connection_id: "c", wallet_address: "w", agent_name: "Agent", scope: "Unscoped", token_hash: "a".repeat(64), created_at: original, last_seen_at: original, revoked_at: null, total_calls: 4, tools_called: [{ name: "balance", count: 4, lastCalledAt: original, legacy: "preserve until rewritten" }] };
    const challenge = { challenge_id: "challenge", owner_wallet: "w", mandate_pda: "m", message: "signed", expires_at_ms: 200, consumed_at_ms: null, created_at_ms: 100 };
    await t.mutation(internal.migration.importRows, { table: "agent_connections", rows: [JSON.stringify(connection)] });
    await t.mutation(internal.migration.importRows, { table: "managed_signer_challenges", rows: [JSON.stringify(challenge)] });
    const before = await t.query(internal.migration.exportRows, { table: "agent_connections", cursor: null, limit: 10 });
    expect(JSON.parse(before.rows[0])).toEqual(connection);
    vi.stubEnv("CHAINPAY_MAINTENANCE", "false");
    await call(t, "mcp.observe", { hash: connection.token_hash, name: "balance", now }, "mcp");
    await call(t, "mcp.revoke", { id: "c", wallet: "w", now }, "mcp");
    await call(t, "consume_managed_signer_challenge", { challenge_id: "challenge", consumed_at_ms: "150" });
    vi.stubEnv("CHAINPAY_MAINTENANCE", "true");
    const after = JSON.parse((await t.query(internal.migration.exportRows, { table: "agent_connections", cursor: null, limit: 10 })).rows[0]);
    expect(after.created_at).toBe(original); expect(after.last_seen_at).toBe(now); expect(after.revoked_at).toBe(now); expect(after.total_calls).toBe(5);
    expect(after.tools_called).toEqual([{ name: "balance", count: 5, lastCalledAt: now }]);
    const consumed = JSON.parse((await t.query(internal.migration.exportRows, { table: "managed_signer_challenges", cursor: null, limit: 10 })).rows[0]);
    expect(consumed.consumed_at_ms).toBe(150);
  });
  it("matches PostgreSQL rounding and rejects x402 updates older than the source microsecond timestamp", async () => {
    const t = test(); vi.stubEnv("CHAINPAY_MAINTENANCE", "true"); vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_ENABLED", "true");
    const row = { x402_payment_id: "x", idempotency_key: "owner:key", resource: "https://merchant", payment_id: null, receipt_address: null, transaction_signature: null, status: "confirmed", challenge: {}, proof: { value: "preserved" }, response_status: 200, error: null, created_at: "2026-10-02T00:00:00.123789+00:00", updated_at: "2026-10-02T00:00:00.123456+00:00" };
    await t.mutation(internal.migration.importRows, { table: "x402_payments", rows: [JSON.stringify(row)] });
    const record = JSON.parse(await call(t, "find_x402_by_idempotency", { key: "owner:key" }));
    expect(record.created_at_ms).toBe(Date.parse("2026-10-02T00:00:00.124Z"));
    vi.stubEnv("CHAINPAY_MAINTENANCE", "false");
    await call(t, "put_x402", { record_json: JSON.stringify({ ...record, status: "verified" }) });
    expect(JSON.parse(await call(t, "find_x402_by_idempotency", { key: "owner:key" })).status).toBe("confirmed");
    await call(t, "put_x402", { record_json: JSON.stringify({ ...record, status: "verified", updated_at_ms: record.updated_at_ms + 1, proof: null }) });
    vi.stubEnv("CHAINPAY_MAINTENANCE", "true");
    const out = JSON.parse((await t.query(internal.migration.exportRows, { table: "x402_payments", cursor: null, limit: 10 })).rows[0]);
    expect(out.created_at).toBe(row.created_at); expect(out.updated_at).toBe("2026-10-02T00:00:00.124Z"); expect(out.status).toBe("verified"); expect(out.proof).toEqual(row.proof);
  });
  it("round-trips every operational SQL table including opaque JSON and provider identifiers", async () => {
    const t = test(); vi.stubEnv("CHAINPAY_MAINTENANCE", "true"); vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_ENABLED", "true");
    const time = "2026-10-02T00:00:00.123456+00:00";
    const fixtures = {
      transactions: { transaction_id: "tx", idempotency_key: "txkey", status: "submitted", signature: null, slot: null, error: null, created_at_ms: 100, updated_at_ms: 200, created_at: time, updated_at: time },
      x402_payments: { x402_payment_id: "x", idempotency_key: "owner:key", resource: "https://merchant", payment_id: null, receipt_address: null, transaction_signature: null, status: "confirmed", challenge: { amount: "18446744073709551615" }, proof: { signature: "sig" }, response_status: 200, error: null, created_at: time, updated_at: time },
      managed_signer_challenges: { challenge_id: "c", owner_wallet: "w", mandate_pda: "m", message: "signed", expires_at_ms: 200, consumed_at_ms: null, created_at_ms: 100 },
      managed_signers: { signer_id: "s", owner_wallet: "w", public_key: "pub", provider: "privy", provider_wallet_id: "private-provider-id", provider_policy_id: "private-policy-id", mandate_pda: "m", signing_mode: "delegated", status: "active", created_at_ms: 100, updated_at_ms: 200, revoked_at_ms: null },
      delivery_attestations: { cluster: "devnet", program_id: "program", receipt_address: "receipt", seller: "seller", content_hash: "a".repeat(64), served_at: time, signature: "sig", canonical_payload: "exact", published_at_ms: 100 },
      operation_claims: { operation_id: "op", owner_wallet: "w", intent: { nested: [true, null] }, initial_record: { state: "unknown" } },
      owner_auth: { key: "session:hash", payload: ["arbitrary", { valid: true }], expires_at_ms: 200 },
      agent_connections: { connection_id: "conn", wallet_address: "w", agent_name: "Agent", scope: "Unscoped", token_hash: "a".repeat(64), created_at: time, last_seen_at: time, revoked_at: null, total_calls: 4, tools_called: [{ name: "balance", count: 4, lastCalledAt: time }] },
      inbox_messages: { message_id: "msg", wallet_address: "w", role: "assistant", content: ["arbitrary", { message: "Hello" }], created_at: time },
    } as const;
    for (const [table, fixture] of Object.entries(fixtures)) {
      const typedTable = table as keyof typeof fixtures;
      await t.mutation(internal.migration.importRows, { table: typedTable, rows: [JSON.stringify(fixture)] });
      const result = await t.query(internal.migration.exportRows, { table: typedTable, cursor: null, limit: 100 });
      expect(JSON.parse(result.rows[0])).toEqual(fixture);
    }
    expect(await call(t, "find_managed_signer_by_mandate", { mandate_pda: "m" })).toContain("private-provider-id");
  });
  it("requires maintenance, preserves SQL timestamps/numbers, and exports post-import writes", async () => {
    const t = test(); const sql = '{"payment_id":"p1","idempotency_key":"owner:key","mandate":"mandate","invoice_hash":"hash","receipt_address":"receipt","amount":18446744073709551615,"signing_mode":"human","status":"prepared","created_at_ms":100,"updated_at_ms":100,"created_at":"2026-10-02T00:00:00.123456+00:00","updated_at":"2026-10-02T00:00:00.123456+00:00"}';
    await expect(t.mutation(internal.migration.importRows, { table: "payments", rows: [sql] })).rejects.toThrow(/maintenance/);
    vi.stubEnv("CHAINPAY_MAINTENANCE", "true"); vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_ENABLED", "true");
    await t.mutation(internal.migration.importRows, { table: "payments", rows: [sql] });
    await t.mutation(internal.migration.importRows, { table: "payments", rows: [sql] });
    const page = await t.query(internal.migration.exportRows, { table: "payments", cursor: null, limit: 100 });
    expect(page.rows).toHaveLength(1); expect(stringify(parse(page.rows[0]))).toBe(stringify(parse(sql))); expect(page.done).toBe(true);
    vi.stubEnv("CHAINPAY_MAINTENANCE", "false"); await call(t, "put_payment", { record_json: payment("confirmed", 200) });
    vi.stubEnv("CHAINPAY_MAINTENANCE", "true");
    const updated = await t.query(internal.migration.exportRows, { table: "payments", cursor: null, limit: 100 });
    expect(updated.rows[0]).toContain('"status":"confirmed"'); expect(updated.rows[0]).toContain("18446744073709551615"); expect(updated.rows[0]).toContain(".123456+00:00");
  });
});
