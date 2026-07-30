import assert from "node:assert/strict";
import test from "node:test";
import { createMcpServer } from "../dist/server.js";

test("implements MCP initialize and tool discovery", async () => {
  const server = createMcpServer({
    client: {
      getMandate: async () => null,
    },
  });
  const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initialized.result.serverInfo.name, "chainpay-mcp");

  const tools = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(tools.result.tools.some((tool) => tool.name === "execute_payment"));
  assert.ok(tools.result.tools.some((tool) => tool.name === "get_payment"));
});

test("returns JSON-RPC errors for unknown methods", async () => {
  const server = createMcpServer({ client: {} });
  const response = await server.handle({ jsonrpc: "2.0", id: 3, method: "unknown" });
  assert.equal(response.error.code, -32601);
});

