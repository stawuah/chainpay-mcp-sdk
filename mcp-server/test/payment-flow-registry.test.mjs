import assert from "node:assert/strict";
import test from "node:test";
import { McpConnectionRegistry } from "../dist/connections.js";

test("flow updates require the live revision and preserve identity and expiry", async () => {
  const registry = McpConnectionRegistry.inMemory();
  const initial = { flowId: "flow", wallet: "owner", paymentId: "payment_1", view: { state: "paying" }, createdAt: 1, updatedAt: 2, expiresAt: Date.now() + 60_000 };
  await registry.putFlow(initial);
  await assert.rejects(registry.putFlow({ ...initial, updatedAt: 3 }), /conflict/);
  const results = await Promise.allSettled([
    registry.putFlow({ ...initial, updatedAt: 3, view: { state: "confirming" } }, 2),
    registry.putFlow({ ...initial, updatedAt: 4, view: { state: "settled" } }, 2),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const latest = await registry.getFlow(initial.flowId);
  await assert.rejects(registry.putFlow({ ...latest, updatedAt: latest.updatedAt + 1, wallet: "other" }, latest.updatedAt), /another wallet/);
  await assert.rejects(registry.putFlow({ ...latest, updatedAt: latest.updatedAt + 1, paymentId: "payment_other" }, latest.updatedAt), /conflict/);
  await assert.rejects(registry.putFlow({ ...latest, updatedAt: latest.updatedAt + 1, expiresAt: latest.expiresAt + 1 }, latest.updatedAt), /conflict/);
  await assert.rejects(registry.putFlow(latest, latest.updatedAt), /conflict/);
  await assert.rejects(registry.putFlow({ ...latest, flowId: "missing", updatedAt: latest.updatedAt + 1 }, latest.updatedAt), /conflict/);
  await registry.putFlow({ ...initial, flowId: "expired", expiresAt: Date.now() - 1 });
  await assert.rejects(registry.putFlow({ ...initial, flowId: "expired", updatedAt: 3 }, 2), /conflict/);
  assert.deepEqual(await registry.getFlow(initial.flowId), latest);
});
