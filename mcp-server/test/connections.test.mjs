import assert from "node:assert/strict";
import test from "node:test";
import { McpConnectionRegistry } from "../dist/connections.js";

test("tracks MCP connection identity and tool calls without exposing the token", async () => {
  const registry = McpConnectionRegistry.inMemory();
  const registered = await registry.register({ wallet: "wallet-1", agentName: "Invoice agent", scope: "Unscoped" });
  const request = { headers: { authorization: `Bearer ${registered.token}` } };

  await registry.observe(request, "prepare_payment");
  await registry.observe(request, "prepare_payment");
  await registry.observe(request, "get_mandate");

  const [connection] = await registry.list("wallet-1");
  assert.equal(connection.agentName, "Invoice agent");
  assert.equal(connection.totalCalls, 3);
  assert.deepEqual(connection.toolsCalled.map((tool) => [tool.name, tool.count]), [
    ["prepare_payment", 2],
    ["get_mandate", 1],
  ]);
  assert.equal("token" in connection, false);
  assert.equal("tokenHash" in connection, false);
});

test("persists inbox messages through the storage boundary", async () => {
  const registry = McpConnectionRegistry.inMemory();
  await registry.appendInboxMessage("wallet-1", "user", { message: "Check invoice 42" });
  await registry.appendInboxMessage("wallet-1", "assistant", { message: "Invoice checked", toolCalls: ["verify_payment_request"] });

  const messages = await registry.listInbox("wallet-1");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.role), ["assistant", "user"]);
});
