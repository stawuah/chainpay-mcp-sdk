import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID, canonicalPaymentRequest } from "@chainpayhq/sdk";
import { callTool, TOOL_DEFINITIONS } from "../dist/index.js";
import { McpConnectionRegistry } from "../dist/connections.js";
import { createHttpServer } from "../dist/http.js";
import { createDemoStoreRequest, DEVNET_USDC_MINT } from "../dist/demo-store.js";
import { recordFlow } from "../dist/payment-flows.js";
import { PAYMENT_WIDGET_URI } from "../dist/widget/resource.js";

const USDC = DEVNET_USDC_MINT;
const WALLET = Keypair.generate().publicKey.toBase58();
const OTHER_WALLET = Keypair.generate().publicKey.toBase58();
const MANDATE = Keypair.generate().publicKey.toBase58();
const AGENT = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const RECEIPT = Keypair.generate().publicKey.toBase58();
const SIGNATURE = "5".repeat(88);

const PASSING = [
  "mandate_status", "approved_agent", "mint", "recipient", "amount_positive", "per_payment_limit", "total_limit",
  "payment_count_limit", "cooldown", "expiry", "invoice_hash", "payment_id", "signature_reference", "duplicate_invoice", "token_program",
].map((name) => ({ name, ok: true, message: `${name} ok` }));

async function signedRequest(product = "market-report") {
  const data = Buffer.alloc(165);
  new PublicKey(USDC).toBuffer().copy(data, 0);
  const previous = process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT;
  process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT = RECIPIENT;
  try {
    const created = await createDemoStoreRequest({
      client: {
        commitment: "confirmed",
        connection: { getAccountInfo: async () => ({ owner: new PublicKey(SPL_TOKEN_PROGRAM_ID), data }) },
        getMintDecimals: async () => 6,
        getCurrentSlot: async () => 1_000n,
      },
    }, product, "https://store.test");
    return created.request;
  } finally {
    if (previous === undefined) delete process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT;
    else process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT = previous;
  }
}

/** Owner session for WALLET with a 21 USDC cap and 30 USDC left; every flow write is captured. */
function harness({ preflight = { valid: true, checks: PASSING }, failPutAfter = Infinity, wallet = WALLET } = {}) {
  const flows = McpConnectionRegistry.inMemory();
  const writes = [];
  const putFlow = flows.putFlow.bind(flows);
  flows.putFlow = async (record, expectedUpdatedAt) => {
    if (writes.length >= failPutAfter) throw new Error("storage down");
    writes.push(structuredClone(record.view));
    return putFlow(record, expectedUpdatedAt);
  };
  const context = {
    principal: { wallet, scope: null },
    flows,
    backendUrl: "https://relay.test",
    backendAuthToken: "session-token",
    client: {
      getMandate: async () => ({ address: MANDATE, owner: WALLET, approvedAgent: AGENT, allowedMint: USDC, maxPerPayment: 21_000_000n, totalLimit: 50_000_000n, amountSpent: 20_000_000n }),
      getMintDecimals: async () => 6,
      getCurrentSlot: async () => 1_000n,
      preparePayment: async () => ({
        receiptAddress: RECEIPT,
        preflight,
        transaction: {
          feePayer: AGENT,
          requiredSigners: [AGENT],
          instructions: [{ name: "fixture", programId: SystemProgram.programId.toBase58(), keys: [{ address: AGENT, isSigner: true, isWritable: true }], data: new Uint8Array() }],
        },
      }),
      connection: { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }) },
    },
  };
  return { context, flows, writes };
}

async function withRelay(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return Response.json(handler(String(url), init));
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("open_payment opens the card at its first step and moves no funds", async () => {
  const { context, writes } = harness();
  const request = await signedRequest();
  await withRelay(() => ({}), async (calls) => {
    const opened = await callTool(context, "open_payment", { request, mandate: MANDATE, agent: AGENT });
    const data = opened.structuredContent;
    assert.equal(data.action, "payment_opened");
    assert.match(data.flowId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(data.flowUrl, `https://chainpay-mcp.vercel.app/pay/${data.flowId}`);
    assert.deepEqual([data.widget.state, data.widget.currentStep, data.widget.amount, data.widget.symbol], ["paying", 0, "10", "USDC"]);
    assert.equal(data.widget.merchant, undefined, "nothing is named before the request is verified");
    const expectedHash = createHash("sha256").update(canonicalPaymentRequest(request.payload)).digest("hex");
    assert.equal(data.continuation.tool, "execute_payment");
    assert.equal(data.continuation.arguments.invoiceHash, expectedHash);
    assert.equal(data.continuation.arguments.flowId, data.flowId);
    assert.equal(data.continuation.arguments.signingMode, "delegated");
    assert.deepEqual(calls, [], "opening the card calls no relay");
    assert.equal(writes.length, 1);
  });
});

test("execute_payment records each step as it really happens, then the outcome", async () => {
  const { context, flows, writes } = harness();
  const request = await signedRequest();
  const opened = (await callTool(context, "open_payment", { request, mandate: MANDATE, agent: AGENT })).structuredContent;
  await withRelay(() => ({ payment_id: "payment_1", status: "submitted", signature: SIGNATURE }), async (calls) => {
    const result = await callTool(context, "execute_payment", opened.continuation.arguments);
    assert.equal(result.structuredContent.action, "payment_pending");
    assert.ok(calls.some((url) => url.endsWith("/v1/managed-payments")));
  });
  assert.deepEqual(writes.map((view) => [view.state, view.currentStep]), [
    ["paying", 0], // opened
    ["paying", 0], // request verified: merchant and product named
    ["paying", 2], // prepared and within policy
    ["confirming", 4], // relay returned a signature
  ]);
  assert.equal(writes[1].merchant, "Halden Data Co.");
  assert.equal(writes[1].product, "Market data report");

  await withRelay(() => ({ payment_id: "payment_1", status: "confirmed", signature: SIGNATURE, mandate: MANDATE, mint: USDC, amount: "10000000", receipt_address: RECEIPT }), async () => {
    const waited = await callTool(context, "wait_for_payment", { paymentId: (await flows.getFlow(opened.flowId)).paymentId, flowId: opened.flowId, timeoutMs: "0" });
    assert.equal(waited.structuredContent.action, "payment_terminal");
  });
  const settled = (await flows.getFlow(opened.flowId)).view;
  assert.equal(settled.state, "settled");
  assert.equal(settled.receipt, RECEIPT);
  assert.equal(settled.merchant, "Halden Data Co.", "earlier proven fields stay on the card");
  assert.equal(settled.explorerUrl, `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`);
  assert.equal(settled.mandate, undefined, "the public card never carries the mandate");
});

test("a 25 USDC request over the cap stops the card at the guardrail, before anything is signed", async () => {
  const blocked = { valid: false, checks: PASSING.map((item) => item.name === "per_payment_limit" ? { ...item, ok: false, message: "Payment exceeds the per-payment limit" } : item) };
  const { context, flows } = harness({ preflight: blocked });
  const request = await signedRequest("annual-license");
  const opened = (await callTool(context, "open_payment", { request, mandate: MANDATE, agent: AGENT })).structuredContent;
  await withRelay(() => ({}), async (calls) => {
    const result = await callTool(context, "execute_payment", opened.continuation.arguments);
    assert.equal(result.structuredContent.action, "rejected_by_preflight");
    assert.deepEqual(calls, [], "nothing reached the relay");
  });
  const view = (await flows.getFlow(opened.flowId)).view;
  assert.equal(view.state, "blocked");
  assert.equal(view.reason, "Requested amount exceeds the 21 USDC per-payment cap.");
  assert.equal(view.rejectedBeforeBroadcast, true);
});

test("another wallet can't drive or overwrite someone else's card", async () => {
  const { context, flows } = harness();
  const request = await signedRequest();
  const opened = (await callTool(context, "open_payment", { request, mandate: MANDATE, agent: AGENT })).structuredContent;
  const intruder = { ...context, principal: { wallet: OTHER_WALLET, scope: null } };
  await assert.rejects(callTool(intruder, "wait_for_payment", { paymentId: "payment_1", flowId: opened.flowId }), /another wallet/);
  await assert.rejects(flows.putFlow({ ...(await flows.getFlow(opened.flowId)), wallet: OTHER_WALLET }), /another wallet/);
  await assert.rejects(callTool(context, "wait_for_payment", { paymentId: "payment_1", flowId: "not-a-card" }), /not a ChainPay payment card id/);
});

test("a storage failure never changes the payment result", async () => {
  const request = await signedRequest();
  const relay = () => ({ payment_id: "payment_1", status: "submitted", signature: SIGNATURE });
  const run = async (failPutAfter) => {
    const { context } = harness({ failPutAfter });
    const opened = (await callTool(context, "open_payment", { request, mandate: MANDATE, agent: AGENT })).structuredContent;
    const result = await withRelay(relay, () => callTool(context, "execute_payment", opened.continuation.arguments));
    return result.structuredContent;
  };
  const healthy = await run(Infinity);
  const broken = await run(1); // the card opens, then every later write fails
  const { context: down } = harness();
  down.flows.getFlow = async () => { throw new Error("storage down"); };
  const opened = (await callTool(harness().context, "open_payment", { request, mandate: MANDATE, agent: AGENT })).structuredContent;
  const unreadable = await withRelay(relay, () => callTool(down, "execute_payment", opened.continuation.arguments));
  assert.equal(unreadable.structuredContent.action, healthy.action, "an unreadable card store doesn't block paying");
  assert.equal(broken.action, healthy.action);
  assert.equal(broken.payment_id, healthy.payment_id);
  assert.equal(broken.signature, healthy.signature);
});

test("without a flowId, execute_payment behaves exactly as before", async () => {
  const { context, writes } = harness();
  const request = await signedRequest();
  const opened = (await callTool(context, "open_payment", { request, mandate: MANDATE, agent: AGENT })).structuredContent;
  const { flowId: _flowId, ...args } = opened.continuation.arguments;
  const before = writes.length;
  const result = await withRelay(() => ({ payment_id: "payment_1", status: "submitted", signature: SIGNATURE }), () => callTool(context, "execute_payment", args));
  assert.equal(result.structuredContent.action, "payment_pending");
  assert.equal(result.structuredContent.widget.flowId, undefined);
  assert.equal(writes.length, before, "no card is written");
});

test("only quote and open render a card; wait stays callable from the card", () => {
  const withCard = TOOL_DEFINITIONS.filter((tool) => tool._meta?.ui?.resourceUri === PAYMENT_WIDGET_URI).map((tool) => tool.name).sort();
  assert.deepEqual(withCard, ["open_payment", "quote_payment_request"]);
  const wait = TOOL_DEFINITIONS.find((tool) => tool.name === "wait_for_payment");
  assert.deepEqual(wait._meta, { "openai/widgetAccessible": true });
  assert.ok(TOOL_DEFINITIONS.find((tool) => tool.name === "execute_payment").inputSchema.properties.flowId);
});

test("a scoped connection that may pay may open the card", async () => {
  const { context } = harness();
  const request = await signedRequest();
  const scoped = { ...context, principal: { wallet: WALLET, scope: { version: 1, mandates: [MANDATE], tools: ["execute_payment"], agents: { [MANDATE]: AGENT } } } };
  const opened = await callTool(scoped, "open_payment", { request, mandate: MANDATE, agent: AGENT });
  assert.equal(opened.structuredContent.action, "payment_opened");
  const quoteOnly = { ...context, principal: { wallet: WALLET, scope: { version: 1, mandates: [MANDATE], tools: ["quote_payment_request"], agents: { [MANDATE]: AGENT } } } };
  await assert.rejects(callTool(quoteOnly, "open_payment", { request, mandate: MANDATE, agent: AGENT }), /not permitted/);
});

test("the /pay page and status show only the card, and unknown cards are 404", async () => {
  const registry = McpConnectionRegistry.inMemory();
  const { context } = harness();
  context.flows = registry;
  const request = await signedRequest();
  const opened = (await callTool(context, "open_payment", { request, mandate: MANDATE, agent: AGENT })).structuredContent;
  const { server } = createHttpServer({ client: {}, flows: registry }, { host: "127.0.0.1", port: 1 }, McpConnectionRegistry.inMemory());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await fetch(`${base}/pay/${opened.flowId}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("access-control-allow-origin"), "*");
    assert.equal(status.headers.get("cache-control"), "no-store");
    const body = await status.json();
    assert.equal(body.view.state, "paying");
    const text = JSON.stringify(body);
    for (const secret of ["session-token", MANDATE, WALLET, request.signature]) assert.ok(!text.includes(secret), "no token, mandate, wallet or signature");

    const page = await fetch(`${base}/pay/${opened.flowId}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("__CHAINPAY_FLOW__"));
    assert.ok(!html.includes(MANDATE));

    assert.equal((await fetch(`${base}/pay/AAAAAAAAAAAAAAAAAAAAAA/status`)).status, 404);
    assert.equal((await fetch(`${base}/pay/nope`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("a card cannot be driven by another payment from the same wallet", async () => {
  const { context, flows } = harness();
  const opened = (await callTool(context, "open_payment", { request: await signedRequest(), mandate: MANDATE, agent: AGENT })).structuredContent;
  const other = (await callTool(context, "open_payment", { request: await signedRequest("annual-license"), mandate: MANDATE, agent: AGENT })).structuredContent;
  const before = await flows.getFlow(opened.flowId);
  await withRelay(() => ({}), async (calls) => {
    await assert.rejects(callTool(context, "execute_payment", { ...other.continuation.arguments, flowId: opened.flowId }), /another payment/);
    await assert.rejects(callTool(context, "wait_for_payment", { flowId: opened.flowId, paymentId: "payment_other" }), /another payment/);
    assert.deepEqual(calls, []);
  });
  assert.deepEqual(await flows.getFlow(opened.flowId), before);
});

test("human preparation never records authorization before a signature", async () => {
  const { context, writes, flows } = harness();
  const opened = (await callTool(context, "open_payment", { request: await signedRequest(), mandate: MANDATE, agent: AGENT, signingMode: "human" })).structuredContent;
  await withRelay(() => ({}), async (calls) => {
    const result = await callTool(context, "execute_payment", opened.continuation.arguments);
    assert.equal(result.structuredContent.action, "agent_signature_required");
    assert.deepEqual(calls, []);
  });
  assert.ok(writes.every((view) => view.currentStep === undefined || view.currentStep <= 2));
  assert.equal((await flows.getFlow(opened.flowId)).view.state, "signature");
});

test("a thrown preparation error updates the open card to unknown", async () => {
  const { context, flows } = harness();
  const opened = (await callTool(context, "open_payment", { request: await signedRequest(), mandate: MANDATE, agent: AGENT })).structuredContent;
  context.client.preparePayment = async () => { throw new Error("RPC unavailable"); };
  await assert.rejects(callTool(context, "execute_payment", opened.continuation.arguments), /RPC unavailable/);
  assert.equal((await flows.getFlow(opened.flowId)).view.state, "unknown");
});

test("concurrent pending updates cannot overwrite a settled card", async () => {
  const { context, flows } = harness();
  const opened = (await callTool(context, "open_payment", { request: await signedRequest(), mandate: MANDATE, agent: AGENT })).structuredContent;
  const { paymentId } = await flows.getFlow(opened.flowId);
  const originalPut = flows.putFlow.bind(flows);
  let release;
  let entered;
  const blocked = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let paused = false;
  flows.putFlow = async (record, expected) => {
    if (!paused && record.view.state === "confirming") { paused = true; entered(); await gate; }
    return originalPut(record, expected);
  };
  const late = recordFlow(context, opened.flowId, { version: 1, state: "confirming", currentStep: 4 }, paymentId);
  await blocked;
  await recordFlow(context, opened.flowId, { version: 1, state: "settled", signature: SIGNATURE, receipt: RECEIPT }, paymentId);
  release();
  await late;
  const view = (await flows.getFlow(opened.flowId)).view;
  assert.equal(view.state, "settled");
  assert.equal(view.receipt, RECEIPT);
});

test("full status updates discard stale refusal and financial evidence", async () => {
  const { context, flows } = harness();
  const opened = (await callTool(context, "open_payment", { request: await signedRequest(), mandate: MANDATE, agent: AGENT })).structuredContent;
  const { paymentId } = await flows.getFlow(opened.flowId);
  await recordFlow(context, opened.flowId, { version: 1, state: "blocked", reason: "Old refusal", rejectedBeforeBroadcast: true, limits: { remaining: "30" } }, paymentId);
  await recordFlow(context, opened.flowId, { version: 1, state: "unknown" }, paymentId);
  const view = (await flows.getFlow(opened.flowId)).view;
  assert.equal(view.reason, undefined);
  assert.equal(view.rejectedBeforeBroadcast, undefined);
  assert.equal(view.limits, undefined);
  assert.equal(view.amount, "10");
});


test("unverified signed bytes do not advance the authorization step", async () => {
  const { context, writes } = harness();
  const opened = (await callTool(context, "open_payment", { request: await signedRequest(), mandate: MANDATE, agent: AGENT, signingMode: "human" })).structuredContent;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.equal(writes.at(-1).currentStep, 2);
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  };
  try {
    const result = await callTool(context, "execute_payment", { ...opened.continuation.arguments, signedTransaction: "invalid" });
    assert.equal(result.structuredContent.action, "backend_rejected");
    assert.ok(writes.every((view) => view.currentStep === undefined || view.currentStep <= 2));
  } finally { globalThis.fetch = originalFetch; }
});
