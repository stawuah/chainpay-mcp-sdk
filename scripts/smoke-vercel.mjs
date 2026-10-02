#!/usr/bin/env node
// Creates an ephemeral, unfunded identity; signs only the login message.
// No transaction, mandate, token delegation, or payment is created.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const bs58 = require("bs58");
const relay = process.env.CHAINPAY_BACKEND_URL ?? "https://chainpay-relay.vercel.app";
const mcp = process.env.CHAINPAY_MCP_URL ?? "https://chainpay-mcp.vercel.app";
const origin = process.env.CHAINPAY_APP_URL ?? "https://chainpay-web-kappa.vercel.app";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const wallet = bs58.encode(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
let token;
async function request(base, path, { method = "GET", body, auth = false, status = 200, from = origin } = {}) {
  const response = await fetch(base + path, {
    method, headers: { Origin: from, ...(body ? { "Content-Type": "application/json" } : {}), ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, status, `${method} ${path}: expected ${status}, received ${response.status}`);
  if (status === 200) assert.equal(response.headers.get("access-control-allow-origin"), from);
  return response.json();
}
try {
  await request(relay, "/healthz");
  await request(mcp, "/healthz");
  const tools = await request(mcp, "/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
  assert.ok(tools.result.tools.length > 0);
  await request(mcp, "/connections", { status: 401 });
  await request(mcp, "/healthz", { from: "https://untrusted.example", status: 403 });
  const challenge = await request(relay, `/v1/auth/challenge?wallet=${wallet}`);
  assert.ok(challenge.message.includes("does not authorize a payment"));
  const proof = { challenge_id: challenge.challenge_id, signature: sign(null, Buffer.from(challenge.message), privateKey).toString("base64") };
  const login = await request(relay, "/v1/auth/session", { method: "POST", body: proof });
  token = login.token;
  assert.equal(login.wallet, wallet);
  await request(relay, "/v1/auth/session", { method: "POST", body: proof, status: 401 });
  assert.equal((await request(relay, "/v1/auth/session", { auth: true })).wallet, wallet);
  assert.deepEqual((await request(mcp, "/connections", { auth: true })).connections, []);
  assert.deepEqual((await request(mcp, "/inbox", { auth: true })).messages, []);
  await request(mcp, "/connections?wallet=other-owner", { auth: true, status: 403 });
  console.log("PASS: relay/MCP health, discovery, CORS, wallet-message login, replay rejection, authenticated storage reads and owner isolation.");
} finally {
  if (token) {
    await request(relay, "/v1/auth/session", { method: "DELETE", auth: true });
    await request(relay, "/v1/auth/session", { auth: true, status: 401 });
    console.log("PASS: ephemeral session revoked; no financial action performed.");
  }
}
