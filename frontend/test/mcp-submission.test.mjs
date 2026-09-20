import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as sdk from "@chainpay/sdk";

// Bundle the real runtime, session and durable settlement store together. Only
// wallet login and service responses are fixtures; no transaction is signed.
const bundle = await build({
  stdin: {
    contents: `export { callMcpTool } from "./src/owner/runtime";
      export { configureSession, setSessionWallet, ensureSessionReady } from "./src/session";
      export { listStoredOperations, reconcileSettlement, PendingSettlementError } from "./src/settlement";`,
    // fileURLToPath, not .pathname: a space in the checkout path stays
    // percent-encoded in a pathname and esbuild then resolves nothing.
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "ts",
  },
  bundle: true, write: false, platform: "node", format: "cjs",
  packages: "external", define: { "import.meta.env": "{}" },
});
const require = createRequire(import.meta.url);
// The SDK index re-exports every subpath (e.g. @chainpay/sdk/known-assets),
// so one loaded copy serves them all.
const loadDependency = name => name === "@chainpay/sdk" || name.startsWith("@chainpay/sdk/") ? sdk : require(name);
const args = {
  mandate: "fixture-mandate", invoiceHash: "ab".repeat(32),
  signingMode: "human", signedTransaction: "fixture-approved-bytes",
};

async function fixture(t, respond) {
  const original = Object.fromEntries(["fetch", "window", "location", "localStorage"].map(key => [key, globalThis[key]]));
  t.after(() => Object.assign(globalThis, original));
  const entries = new Map();
  globalThis.window = new EventTarget();
  globalThis.location = { href: "https://fixture.example/app" };
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(loadDependency, module, module.exports);
  const runtime = module.exports;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/auth/challenge")) return Response.json({ challenge_id: "fixture", message: "Fixture login" });
    if (url.endsWith("/auth/session")) return Response.json({ token: "fixture-token", wallet: "fixture-owner", expires_at_ms: Date.now() + 60_000 });
    return respond(url, init, runtime);
  };
  runtime.configureSession("https://chainpay-backend.onrender.com", "https://chainpay-mcp.onrender.com/mcp");
  runtime.setSessionWallet({ address: "fixture-owner", signMessage: async () => new Uint8Array(64) });
  await runtime.ensureSessionReady();
  return { ...runtime, calls };
}

async function expectUnknown(f, reason) {
  let timer;
  try {
    await assert.rejects(Promise.race([
      f.callMcpTool("execute_payment", args),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Submission handler is still hanging")), 250); }),
    ]), error => error instanceof f.PendingSettlementError && reason.test(error.message));
  } finally { clearTimeout(timer); }
  const [operation] = f.listStoredOperations();
  assert.equal(operation.status, "unknown");
  assert.equal(operation.wire, args.signedTransaction);
  assert.match(operation.result.error, reason);
  assert.equal(f.calls.filter(call => call.url.endsWith("/mcp")).length, 1, "never retry a submission automatically");
  return operation;
}

test("HTTP 200 with a legacy JSON-RPC error surfaces its reason without hanging", async t => {
  const f = await fixture(t, () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Fixture RPC read failed" } }));
  await expectUnknown(f, /Fixture RPC read failed/);
});

test("HTTP authentication errors preserve their string error body", async t => {
  const f = await fixture(t, () => Response.json({ error: "Fixture session expired" }, { status: 401 }));
  await expectUnknown(f, /Fixture session expired/);
});

test("a lost response preserves the original approval and a later status read can confirm it", async t => {
  const f = await fixture(t, url => {
    if (url.endsWith("/mcp")) throw new TypeError("Fixture connection lost");
    return Response.json({ status: "confirmed", signature: "fixture-signature", receipt_address: "fixture-receipt" });
  });
  const operation = await expectUnknown(f, /Fixture connection lost/);
  await f.reconcileSettlement(operation);
  assert.equal(f.listStoredOperations()[0].status, "confirmed");
  assert.equal(f.listStoredOperations()[0].wire, undefined);
});

test("a non-JSON gateway response remains recoverable and names its HTTP status", async t => {
  const f = await fixture(t, () => new Response("<html>Gateway unavailable</html>", { status: 502 }));
  await expectUnknown(f, /502/);
});

test("an opaque tool error without a payment ID is not proof that nothing was submitted", async t => {
  const f = await fixture(t, () => Response.json({ result: { isError: true, content: [{ type: "text", text: "Fixture response decoding failed" }] } }));
  await expectUnknown(f, /Fixture response decoding failed/);
});

test("a definite preflight rejection records its actual reason and clears signed bytes", async t => {
  const result = { isError: true, structuredContent: { action: "rejected_by_preflight", message: "Fixture mandate paused" } };
  const f = await fixture(t, () => Response.json({ result }));
  assert.deepEqual(await f.callMcpTool("execute_payment", args), result);
  assert.equal(f.listStoredOperations()[0].status, "failed");
  assert.equal(f.listStoredOperations()[0].wire, undefined);
  assert.match(f.listStoredOperations()[0].result.error, /Fixture mandate paused/);
});

test("an explicit relay validation rejection preserves the reason", async t => {
  const result = { isError: true, structuredContent: { action: "backend_rejected", httpStatus: 422, error: "Fixture invalid wire" } };
  const f = await fixture(t, () => Response.json({ result }));
  await f.callMcpTool("execute_payment", args);
  assert.equal(f.listStoredOperations()[0].status, "failed");
  assert.match(f.listStoredOperations()[0].result.error, /Fixture invalid wire/);
});

test("relay server errors retain the original approval", async t => {
  const f = await fixture(t, () => Response.json({ result: { isError: true, structuredContent: { action: "backend_rejected", httpStatus: 500, error: "Fixture relay unavailable" } } }));
  await expectUnknown(f, /Fixture relay unavailable/);
});

test("a reported unknown outcome immediately surfaces the relay transport error", async t => {
  const f = await fixture(t, (_url, _init, runtime) => Response.json({ result: { structuredContent: {
    status: "unknown", payment_id: runtime.listStoredOperations()[0].id, error: "Fixture relay timed out after 90s",
  } } }));
  await expectUnknown(f, /Fixture relay timed out after 90s/);
});

test("a confirmed response with the wrong operation ID cannot report success", async t => {
  const f = await fixture(t, () => Response.json({ result: { structuredContent: { status: "confirmed", payment_id: "payment_wrong", signature: "wrong-signature" } } }));
  await expectUnknown(f, /operation/i);
});

test("a matching confirmed response still returns its signature and receipt", async t => {
  const f = await fixture(t, (_url, _init, runtime) => Response.json({ result: { structuredContent: {
    status: "confirmed", payment_id: runtime.listStoredOperations()[0].id, signature: "fixture-signature", receipt_address: "fixture-receipt",
  } } }));
  const result = await f.callMcpTool("execute_payment", args);
  assert.equal(result.structuredContent.status, "confirmed");
  assert.equal(result.structuredContent.receiptAddress, "fixture-receipt");
  assert.equal(f.listStoredOperations()[0].wire, undefined);
});
