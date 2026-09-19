import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { createMcpServer, createStdioRuntime } from "../dist/server.js";
import {
  CURRENT_PROTOCOL_VERSION,
  HEADER_MISMATCH,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  PROTOCOL_VERSION_KEY,
  SERVER_INFO_KEY,
  SERVER_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION,
  decodeMcpNameHeader,
} from "../dist/protocol.js";
import { createHttpServer } from "../dist/http.js";
import { McpConnectionRegistry } from "../dist/connections.js";

const CURRENT = CURRENT_PROTOCOL_VERSION;

function modernMeta(overrides = {}) {
  return {
    [PROTOCOL_VERSION_KEY]: CURRENT,
    "io.modelcontextprotocol/clientCapabilities": {},
    ...overrides,
  };
}

function modernRequest(id, method, params = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: modernMeta(params._meta) },
  };
}

function modernHeaders(method, name) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": CURRENT,
    "Mcp-Method": method,
  };
  if (name !== undefined) headers["Mcp-Name"] = name;
  return headers;
}

function fixtureContext(overrides = {}) {
  return {
    client: {
      getConfig: async () => ({ fixture: true }),
      getSupportedAssets: async () => [{
        address: "asset-pda",
        authority: "authority",
        mint: "mint",
        tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        enabled: true,
        bump: 255,
      }],
      getMandate: async () => null,
    },
    ...overrides,
  };
}

async function withHttpServer(context, fn) {
  const { server } = createHttpServer(context, { host: "127.0.0.1", port: 3000, allowedOrigins: ["http://localhost:5173"] }, McpConnectionRegistry.inMemory());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function frontendCompatibilityHelper(base, method, params, token) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `MCP request failed (${response.status})`);
  return payload.result;
}

test("legacy initialize and modern discover share the same server instructions", async () => {
  const server = createMcpServer(fixtureContext());
  const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const discovered = await server.handle(modernRequest("discover-instructions", "server/discover"));
  assert.equal(initialized.result.instructions, SERVER_INSTRUCTIONS);
  assert.equal(discovered.result.instructions, SERVER_INSTRUCTIONS);
  // Assert the promises the instructions must keep, not one wording of them.
  // The phrasing is rewritten often; what must not disappear is that the owner
  // holds the funds and that the server never asks for key material.
  assert.match(SERVER_INSTRUCTIONS, /owner wallet holds the funds/i);
  assert.match(SERVER_INSTRUCTIONS, /never holds, receives, or asks for private keys/i);
  assert.match(SERVER_INSTRUCTIONS, /delegated signing/i);
});

test("implements MCP initialize and tool discovery", async () => {
  const server = createMcpServer({
    client: {
      getMandate: async () => null,
    },
  });
  const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initialized.result.serverInfo.name, "chainpay-mcp");
  assert.equal(initialized.result.instructions, SERVER_INSTRUCTIONS);

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

test("modern discover, list, and public call do not require initialize", async () => {
  const server = createMcpServer(fixtureContext());
  const discovered = await server.handle(modernRequest("discover-1", "server/discover"));
  assert.equal(discovered.result.resultType, "complete");
  assert.deepEqual(discovered.result.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.deepEqual(discovered.result.capabilities, { tools: {} });
  assert.equal(discovered.result.ttlMs, 300000);
  assert.equal(discovered.result.cacheScope, "public");
  assert.equal(discovered.result._meta[SERVER_INFO_KEY].name, "chainpay-mcp");
  assert.equal(discovered.result.serverInfo, undefined);

  const listed = await server.handle(modernRequest("list-1", "tools/list"));
  assert.equal(listed.result.resultType, "complete");
  assert.equal(listed.result.ttlMs, 300000);
  assert.equal(listed.result.cacheScope, "public");
  assert.equal(listed.result.nextCursor, undefined);
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)));

  const called = await server.handle(modernRequest("call-1", "tools/call", { name: "get_protocol_config", arguments: {} }));
  assert.equal(called.result.resultType, "complete");
  assert.equal(called.result._meta[SERVER_INFO_KEY].version, "0.1.0");
  assert.equal(called.result.structuredContent.config.fixture, true);
  assert.equal(called.result.ttlMs, undefined);
});

test("optional clientInfo is accepted and capabilities are not retained", async () => {
  const server = createMcpServer(fixtureContext());
  const first = await server.handle(modernRequest(1, "server/discover", {
    _meta: modernMeta({
      "io.modelcontextprotocol/clientInfo": { name: "chainpay-dashboard", version: "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": { experimental: { remember: { me: true } } },
    }),
  }));
  assert.equal(first.result.resultType, "complete");
  const second = await server.handle(modernRequest(2, "tools/list"));
  assert.equal(second.result.resultType, "complete");
  assert.deepEqual(second.result.capabilities ?? { tools: {} }, { tools: {} });
});

test("unsupported mirrored version returns -32022 data", async () => {
  const server = createMcpServer(fixtureContext());
  const response = await server.handle({
    jsonrpc: "2.0",
    id: "bad-version",
    method: "tools/list",
    params: { _meta: modernMeta({ [PROTOCOL_VERSION_KEY]: "1900-01-01" }) },
  });
  assert.equal(response.error.code, UNSUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(response.error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal(response.error.data.requested, "1900-01-01");
});

test("modern initialize and ping are unsupported methods", async () => {
  const server = createMcpServer(fixtureContext());
  const initialized = await server.handle(modernRequest(1, "initialize"));
  assert.equal(initialized.error.code, METHOD_NOT_FOUND);
  const ping = await server.handle(modernRequest(2, "ping"));
  assert.equal(ping.error.code, METHOD_NOT_FOUND);
});

test("unknown tool is invalid params; execution failure uses CallToolResult", async () => {
  const server = createMcpServer(fixtureContext({
    client: { getConfig: async () => null },
  }));
  const unknown = await server.handle(modernRequest(1, "tools/call", { name: "not_a_tool", arguments: {} }));
  assert.equal(unknown.error.code, INVALID_PARAMS);
  const failed = await server.handle(modernRequest(2, "tools/call", { name: "get_protocol_config", arguments: {} }));
  assert.equal(failed.error, undefined);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.resultType, "complete");
  assert.equal(failed.result.content[0].type, "text");
});

test("legacy initialize, ping, list, call, and initialized stay available", async () => {
  const server = createMcpServer(fixtureContext());
  const initialized = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
  });
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "chainpay-mcp");
  assert.equal(initialized.result.resultType, undefined);
  const ping = await server.handle({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(ping.result, {});
  const listed = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(listed.result.resultType, undefined);
  assert.ok(listed.result.tools.length > 0);
  const called = await server.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_protocol_config", arguments: {} },
  });
  assert.equal(called.result.structuredContent.config.fixture, true);
  const notice = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notice, null);
});

test("rejects invalid JSON-RPC envelopes without crashing", async () => {
  const server = createMcpServer(fixtureContext());
  const batch = await server.handle([]);
  assert.equal(batch.error.code, INVALID_REQUEST);
  const clientResult = await server.handle({ jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(clientResult.error.code, INVALID_REQUEST);
  const badParams = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: [] });
  assert.equal(badParams.error.code, INVALID_REQUEST);
  const nullParams = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: null });
  assert.equal(nullParams.error.code, INVALID_REQUEST);
  const modernNullId = await server.handle({ ...modernRequest(null, "tools/list"), id: null });
  assert.equal(modernNullId.error.code, INVALID_REQUEST);
  const objectId = await server.handle({ jsonrpc: "2.0", id: {}, method: "tools/list" });
  assert.equal(objectId.error.code, INVALID_REQUEST);
  const zero = await server.handle(modernRequest(0, "server/discover"));
  assert.equal(zero.id, 0);
  assert.equal(zero.result.resultType, "complete");
  const empty = await server.handle(modernRequest("", "server/discover"));
  assert.equal(empty.id, "");
});

test("id-less tools/call never executes", async () => {
  let reads = 0;
  const server = createMcpServer({
    client: {
      getConfig: async () => {
        reads += 1;
        return { fixture: true };
      },
    },
  });
  const modern = await server.handle({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "get_protocol_config", arguments: {}, _meta: modernMeta() },
  });
  assert.equal(modern.error.code, INVALID_REQUEST);
  const legacy = await server.handle({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "get_protocol_config", arguments: {} },
  });
  assert.equal(legacy.error.code, INVALID_REQUEST);
  assert.equal(reads, 0);
});

test("private tools stay unauthorized across modern and legacy envelopes", async () => {
  const server = createMcpServer(fixtureContext());
  const modern = await server.handle(modernRequest(1, "tools/call", {
    name: "list_mandates",
    arguments: { owner: Keypair.generate().publicKey.toBase58() },
  }));
  assert.match(modern.error.message, /Sign in/);
  const legacy = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_mandates", arguments: { owner: Keypair.generate().publicKey.toBase58() } },
  });
  assert.match(legacy.error.message, /Sign in/);
});

test("decodes Mcp-Name sentinels strictly", () => {
  assert.equal(decodeMcpNameHeader("get_protocol_config").value, "get_protocol_config");
  const encoded = `=?base64?${Buffer.from("get_protocol_config", "utf8").toString("base64")}?=`;
  assert.equal(decodeMcpNameHeader(encoded).value, "get_protocol_config");
  const literal = "=?base64?literal?=";
  const wrapped = `=?base64?${Buffer.from(literal, "utf8").toString("base64")}?=`;
  assert.equal(decodeMcpNameHeader(wrapped).value, literal);
  assert.equal(decodeMcpNameHeader("=?base64?QQ?=").ok, false);
  assert.equal(decodeMcpNameHeader("=?base64?//4=?=").ok, false);
});

test("HTTP modern discover/list/call and header failures", async () => {
  await withHttpServer(fixtureContext(), async (base) => {
    const discover = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("server/discover"),
      body: JSON.stringify(modernRequest("discover-1", "server/discover")),
    });
    assert.equal(discover.status, 200);
    assert.match(discover.headers.get("content-type"), /application\/json/);
    const discovered = await discover.json();
    assert.equal(discovered.result.resultType, "complete");

    const listed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/list"),
      body: JSON.stringify(modernRequest("list-1", "tools/list")),
    });
    assert.equal(listed.status, 200);
    assert.ok((await listed.json()).result.tools.length > 0);

    const called = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/call", "get_protocol_config"),
      body: JSON.stringify(modernRequest("call-1", "tools/call", { name: "get_protocol_config", arguments: {} })),
    });
    assert.equal(called.status, 200);
    assert.equal((await called.json()).result.structuredContent.config.fixture, true);

    const missingVersion = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "tools/list" },
      body: JSON.stringify(modernRequest(1, "tools/list")),
    });
    assert.equal(missingVersion.status, 400);
    assert.equal((await missingVersion.json()).error.code, HEADER_MISMATCH);

    const missingMethod = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": CURRENT },
      body: JSON.stringify(modernRequest(2, "tools/list")),
    });
    assert.equal(missingMethod.status, 400);
    assert.equal((await missingMethod.json()).error.code, HEADER_MISMATCH);

    const missingName = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/call"),
      body: JSON.stringify(modernRequest(3, "tools/call", { name: "get_protocol_config", arguments: {} })),
    });
    assert.equal(missingName.status, 400);
    assert.equal((await missingName.json()).error.code, HEADER_MISMATCH);

    const mismatchName = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/call", "other_tool"),
      body: JSON.stringify(modernRequest(4, "tools/call", { name: "get_protocol_config", arguments: {} })),
    });
    assert.equal(mismatchName.status, 400);
    assert.equal((await mismatchName.json()).error.code, HEADER_MISMATCH);

    const mismatchVersion = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...modernHeaders("tools/list"), "MCP-Protocol-Version": "1900-01-01" },
      body: JSON.stringify(modernRequest(5, "tools/list")),
    });
    assert.equal(mismatchVersion.status, 400);
    assert.equal((await mismatchVersion.json()).error.code, HEADER_MISMATCH);

    const unsupported = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...modernHeaders("tools/list"), "MCP-Protocol-Version": "1900-01-01" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
        params: { _meta: modernMeta({ [PROTOCOL_VERSION_KEY]: "1900-01-01" }) },
      }),
    });
    assert.equal(unsupported.status, 400);
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.error.code, UNSUPPORTED_PROTOCOL_VERSION);
    assert.equal(unsupportedBody.error.data.requested, "1900-01-01");

    const encodedName = `=?base64?${Buffer.from("get_protocol_config", "utf8").toString("base64")}?=`;
    const encoded = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/call", encodedName),
      body: JSON.stringify(modernRequest(7, "tools/call", { name: "get_protocol_config", arguments: {} })),
    });
    assert.equal(encoded.status, 200);

    const unknownRpc = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("resources/list"),
      body: JSON.stringify(modernRequest(8, "resources/list")),
    });
    assert.equal(unknownRpc.status, 404);
    assert.equal((await unknownRpc.json()).error.code, METHOD_NOT_FOUND);

    const unknownTool = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/call", "missing_tool"),
      body: JSON.stringify(modernRequest(9, "tools/call", { name: "missing_tool", arguments: {} })),
    });
    assert.equal(unknownTool.status, 400);
    assert.equal((await unknownTool.json()).error.code, INVALID_PARAMS);

    const ignoredSession = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...modernHeaders("server/discover"), "Mcp-Session-Id": "stale", "Last-Event-ID": "99" },
      body: JSON.stringify(modernRequest(10, "server/discover")),
    });
    assert.equal(ignoredSession.status, 200);
    assert.equal(ignoredSession.headers.get("mcp-session-id"), null);

    const modernGet = await fetch(`${base}/mcp`, { method: "GET", headers: { "MCP-Protocol-Version": CURRENT } });
    assert.equal(modernGet.status, 405);
    const modernDelete = await fetch(`${base}/mcp`, { method: "DELETE", headers: { "MCP-Protocol-Version": CURRENT } });
    assert.equal(modernDelete.status, 405);

    const missingAccept = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": CURRENT, "Mcp-Method": "tools/list" },
      body: JSON.stringify(modernRequest(11, "tools/list")),
    });
    assert.equal(missingAccept.status, 400);

    const invalidJson = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/list"),
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error.code, PARSE_ERROR);

    const privateCall = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: modernHeaders("tools/call", "list_mandates"),
      body: JSON.stringify(modernRequest(12, "tools/call", {
        name: "list_mandates",
        arguments: { owner: Keypair.generate().publicKey.toBase58() },
      })),
    });
    assert.equal(privateCall.status, 401);
    assert.match((await privateCall.json()).error.message, /Sign in/);
  });
});

test("frontend helper list/call remains a headerless compatibility path", async () => {
  await withHttpServer(fixtureContext(), async (base) => {
    const tools = await frontendCompatibilityHelper(base, "tools/list");
    assert.ok(tools.tools.some((tool) => tool.name === "get_protocol_config"));
    const publicResult = await frontendCompatibilityHelper(base, "tools/call", { name: "get_protocol_config", arguments: {} });
    assert.equal(publicResult.structuredContent.config.fixture, true);
    await assert.rejects(
      frontendCompatibilityHelper(base, "tools/call", { name: "list_mandates", arguments: { owner: Keypair.generate().publicKey.toBase58() } }),
      /Sign in/,
    );
  });
});

test("unknown MCP origin is 403; allowed origin can preflight", async () => {
  await withHttpServer(fixtureContext(), async (base) => {
    const denied = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "Origin is not allowed");

    const allowed = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });
});

test("stdio cancellation suppresses a later tool response", async () => {
  let release;
  const pendingConfig = new Promise((resolve) => {
    release = resolve;
  });
  const lines = [];
  const runtime = createStdioRuntime({
    client: { getConfig: async () => pendingConfig },
  }, {
    writeStdout: (line) => lines.push(line),
  });
  const call = runtime.enqueue(JSON.stringify(modernRequest("slow-1", "tools/call", { name: "get_protocol_config", arguments: {} })));
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.enqueue(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "slow-1" },
  }));
  release({ fixture: true });
  await call;
  assert.equal(lines.join(""), "");
});
