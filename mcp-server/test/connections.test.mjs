import assert from "node:assert/strict";
import test from "node:test";
import { McpConnectionRegistry } from "../dist/connections.js";

test("tracks MCP connection identity and tool calls without exposing the token", () => {
  const registry = new McpConnectionRegistry();
  const registered = registry.register({ wallet: "wallet-1", agentName: "Invoice agent", scope: "Unscoped" });
  const request = { headers: { authorization: `Bearer ${registered.token}` } };

  registry.observe(request, "prepare_payment");
  registry.observe(request, "prepare_payment");
  registry.observe(request, "get_mandate");

  const [connection] = registry.list("wallet-1");
  assert.equal(connection.agentName, "Invoice agent");
  assert.equal(connection.totalCalls, 3);
  assert.deepEqual(connection.toolsCalled.map((tool) => [tool.name, tool.count]), [
    ["prepare_payment", 2],
    ["get_mandate", 1],
  ]);
  assert.equal("token" in connection, false);
});
