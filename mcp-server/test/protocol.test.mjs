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
  assert.ok(tools.result.tools.some((tool) => tool.name === "get_supported_assets"));
});

test("lists the scalable SupportedAsset registry", async () => {
  const server = createMcpServer({
    client: {
      getSupportedAssets: async () => [{
        address: "asset-pda",
        authority: "authority",
        mint: "mint",
        tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        enabled: true,
        bump: 255,
      }],
    },
  });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_supported_assets", arguments: {} },
  });
  assert.equal(response.result.structuredContent.assets[0].tokenProgramKind, "token-2022");
});

test("returns JSON-RPC errors for unknown methods", async () => {
  const server = createMcpServer({ client: {} });
  const response = await server.handle({ jsonrpc: "2.0", id: 3, method: "unknown" });
  assert.equal(response.error.code, -32601);
});
