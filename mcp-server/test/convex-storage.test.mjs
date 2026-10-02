import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { ConvexStorage } from "../dist/convex-storage.js";
import { McpConnectionRegistry } from "../dist/connections.js";

async function server(t, handler) {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test("uncertain mutations are sent once and service secrets are not exposed in errors", async t => {
  let calls = 0;
  const origin = await server(t, (req) => { calls++; req.socket.destroy(); });
  const secret = "s".repeat(48);
  const client = new ConvexStorage(origin, secret);
  await assert.rejects(client.call("mcp.register", {}), error => /uncertain/.test(error.message) && !error.message.includes(secret));
  assert.equal(calls, 1);
});
test("registry uses role storage and decodes inbox JSON without leaking credential hashes", async t => {
  const requests = [];
  const origin = await server(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    assert.equal(req.headers.authorization, `Bearer ${"m".repeat(48)}`);
    let value;
    if (request.operation === "mcp.register") { const { tokenHash, revokedAt, ...publicRecord } = request.args.record; assert.match(tokenHash, /^[a-f0-9]{64}$/); value = publicRecord; }
    else if (request.operation === "mcp.appendInboxMessage") value = request.args.record;
    else if (request.operation === "mcp.rateLimit") value = false;
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ value }));
  });
  const registry = new McpConnectionRegistry(undefined, new ConvexStorage(origin, "m".repeat(48)));
  const registered = await registry.register({ wallet: "owner", agentName: "Agent" });
  assert.equal("tokenHash" in registered.connection, false);
  const message = await registry.appendInboxMessage("owner", "user", { amount: "18446744073709551615" });
  assert.deepEqual(message.content, { amount: "18446744073709551615" });
  assert.equal(await registry.rateLimit("owner", 100, 20, 60_000), false);
  assert.equal(requests[2].args.now, "100");
});
test("rejects unsafe storage destinations and malformed success envelopes", async t => {
  assert.throws(() => new ConvexStorage("http://example.com", "s".repeat(48)));
  assert.throws(() => new ConvexStorage("https://example.com/?secret=x", "s".repeat(48)));
  const origin = await server(t, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{}'); });
  await assert.rejects(new ConvexStorage(origin, "s".repeat(48)).call("ping", {}), /Invalid storage response/);
});
