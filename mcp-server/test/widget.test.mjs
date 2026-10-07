import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID, verifyPaymentRequest } from "@chainpayhq/sdk";
import { createMcpServer } from "../dist/server.js";
import { TOOL_DEFINITIONS } from "../dist/index.js";
import { paymentWidgetView } from "../dist/widget/view.js";
import { paymentWidgetHtml, PAYMENT_WIDGET_URI, PAYMENT_WIDGET_OPENAI_URI } from "../dist/widget/resource.js";
import { createDemoStoreRequest, DEVNET_USDC_MINT, DemoStoreError } from "../dist/demo-store.js";

const USDC = DEVNET_USDC_MINT;
const TOKEN_PROGRAM = SPL_TOKEN_PROGRAM_ID;
const MANDATE = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const MERCHANT = Keypair.generate().publicKey.toBase58();

const PASSING = [
  "mandate_status", "approved_agent", "mint", "recipient", "amount_positive", "per_payment_limit",
  "total_limit", "payment_count_limit", "cooldown", "expiry", "invoice_hash", "payment_id",
  "signature_reference", "duplicate_invoice", "token_program",
].map((name) => ({ name, ok: true, message: `${name} ok` }));

function checksWith(overrides) {
  return PASSING.map((item) => overrides[item.name] ? { ...item, ok: false, message: overrides[item.name] } : item);
}

function payload(amount = "10000000") {
  return {
    version: 1, cluster: "devnet", merchant: MERCHANT, invoice: "inv-1", mint: USDC, tokenProgram: "spl-token",
    recipient: RECIPIENT, amount, decimals: 6, nonce: "n", expiresAtSlot: "999", description: "Market data report",
  };
}

// A mandate with a 21 USDC per-payment cap and 30 USDC left of a 50 USDC limit.
function context({ amountSpent = 20_000_000n } = {}) {
  return {
    client: {
      getMintDecimals: async () => 6,
      getMandate: async () => ({ address: MANDATE, maxPerPayment: 21_000_000n, totalLimit: 50_000_000n, amountSpent, allowedMint: USDC }),
    },
  };
}

const result = (structuredContent) => ({ structuredContent, content: [{ type: "text", text: "x" }] });
const quoteArgs = (amount) => ({ mandate: MANDATE, agent: MANDATE, request: { payload: payload(amount), signature: "sig" } });

test("a quoted 10 USDC request is ready, with six proven checks and exact limits", async () => {
  const view = await paymentWidgetView(context(), "quote_payment_request", quoteArgs(), result({
    action: "payment_request_quoted",
    verification: { valid: true, payload: payload() },
    quote: { preflight: { valid: true, checks: PASSING } },
  }));
  assert.equal(view.state, "ready");
  assert.equal(view.amount, "10");
  assert.equal(view.symbol, "USDC");
  assert.equal(view.product, "Market data report");
  assert.equal(view.cluster, "Solana Devnet");
  assert.match(view.merchant, /^Merchant /, "an unknown merchant key is never given a name");
  assert.deepEqual(view.checks, [
    "Merchant signature verified",
    "Payment request has not been used",
    "Permission is active",
    "Token matches permission",
    "Recipient verified",
    "Request has not expired",
  ]);
  assert.deepEqual(view.limits, { requested: "10", cap: "21", remaining: "30", after: "20", withinLimits: true });
});

test("a 25 USDC request over the 21 USDC cap is blocked before anything is signed", async () => {
  const view = await paymentWidgetView(context(), "quote_payment_request", quoteArgs("25000000"), result({
    action: "payment_request_blocked",
    verification: { valid: true, payload: payload("25000000") },
    check: { preflight: { valid: false, checks: checksWith({ per_payment_limit: "Payment exceeds the per-payment limit" }) } },
  }));
  assert.equal(view.state, "blocked");
  assert.equal(view.reason, "Requested amount exceeds the 21 USDC per-payment cap.");
  assert.equal(view.reasonKind, "limits");
  assert.equal(view.rejectedBeforeBroadcast, true);
  assert.equal(view.limits.withinLimits, false);
  assert.equal(view.limits.after, undefined);
  assert.equal(view.checks, undefined, "a blocked card never shows passed checks");
});

test("each refusal maps to one plain reason", async () => {
  const cases = [
    [{ action: "payment_request_rejected", verification: { valid: false, reason: "Payment request signature is invalid" } }, "signature", "The merchant signature is invalid."],
    [{ action: "payment_request_rejected", verification: { valid: false, reason: "Payment request has expired" } }, "expired", "This payment request has expired."],
    [{ action: "duplicate_invoice", message: "This invoice hash already has a receipt under the mandate" }, "paid", "This invoice has already been paid."],
    [{ action: "payment_request_mismatch", message: "The merchant request names a different mint, recipient, or amount than this payment." }, "recipient", "The payment doesn't match what the merchant signed."],
    [{ action: "rejected_by_preflight", preflight: { valid: false, checks: checksWith({ mandate_status: "Mandate is paused" }) } }, "permission", "This spending permission is paused."],
    [{ action: "rejected_by_preflight", preflight: { valid: false, checks: checksWith({ mandate_status: "Mandate is revoked" }) } }, "permission", "This spending permission is revoked."],
  ];
  for (const [data, kind, reason] of cases) {
    const view = await paymentWidgetView(context(), "execute_payment", quoteArgs(), result(data));
    assert.equal(view.state, "blocked", data.action);
    assert.equal(view.reasonKind, kind, data.action);
    assert.equal(view.reason, reason, data.action);
    assert.equal(view.rejectedBeforeBroadcast, true, data.action);
  }
});

test("an unverified request never lends the card a merchant or product", async () => {
  const view = await paymentWidgetView(context(), "execute_payment", quoteArgs(), result({
    action: "payment_request_mismatch", message: "The merchant request did not verify.",
  }));
  assert.equal(view.merchant, undefined);
  assert.equal(view.product, undefined);
});

test("settlement states come from returned fields, never a timer", async () => {
  const signature = "5".repeat(88);
  const receipt = Keypair.generate().publicKey.toBase58();
  const settled = await paymentWidgetView(context({ amountSpent: 30_000_000n }), "execute_payment", { ...quoteArgs(), signingMode: "delegated" }, result({
    action: "managed_payment_settled", status: "confirmed", signature, receiptAddress: receipt, payment_id: "p1",
  }));
  assert.equal(settled.state, "settled");
  assert.equal(settled.explorerUrl, `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  assert.equal(settled.receipt, receipt);
  assert.equal(settled.limits.remaining, "20", "remaining is read after the payment");
  assert.equal(settled.limits.after, undefined);

  const sent = await paymentWidgetView(context(), "execute_payment", { ...quoteArgs(), signingMode: "delegated" }, result({ action: "payment_pending", status: "submitted", signature, payment_id: "p1" }));
  assert.deepEqual([sent.state, sent.currentStep], ["confirming", 4]);

  const unsent = await paymentWidgetView(context(), "execute_payment", { ...quoteArgs(), signingMode: "delegated" }, result({ action: "payment_pending", payment_id: "p1" }));
  assert.deepEqual([unsent.state, unsent.currentStep], ["paying", 2], "without a signature, the card can't claim submission");

  const unknown = await paymentWidgetView(context(), "execute_payment", quoteArgs(), result({ action: "payment_outcome_unknown", status: "unknown", payment_id: "p1" }));
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.rejectedBeforeBroadcast, undefined);

  const failedUnsigned = await paymentWidgetView(context(), "execute_payment", quoteArgs(), result({ action: "payment_failed", status: "failed" }));
  assert.equal(failedUnsigned.state, "unknown", "a failure with no signature can't say whether funds moved");

  const failedOnChain = await paymentWidgetView(context(), "wait_for_payment", { paymentId: "p1" }, result({ action: "payment_terminal", status: "failed", signature, mandate: MANDATE, mint: USDC, amount: "10000000" }));
  assert.equal(failedOnChain.state, "blocked");
  assert.equal(failedOnChain.rejectedBeforeBroadcast, undefined, "an on-chain failure is not a pre-broadcast refusal");

  const confirmed = await paymentWidgetView(context(), "wait_for_payment", { paymentId: "p1" }, result({ action: "payment_terminal", status: "confirmed", signature, mandate: MANDATE, mint: USDC, amount: "10000000", receipt_address: receipt }));
  assert.equal(confirmed.state, "settled");
  assert.equal(confirmed.amount, "10");
});

test("tools without a card are left alone", async () => {
  assert.equal(await paymentWidgetView(context(), "list_mandates", {}, result({ action: "x" })), undefined);
});

test("the server lists and reads the payment card as an MCP App", async () => {
  const server = createMcpServer({ client: {} });
  const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.deepEqual(init.result.capabilities.extensions["io.modelcontextprotocol/ui"], { mimeTypes: ["text/html;profile=mcp-app"] });
  assert.deepEqual(init.result.capabilities.resources, { listChanged: false });

  const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "resources/list" });
  assert.deepEqual(listed.result.resources.map((item) => [item.uri, item.mimeType]), [
    [PAYMENT_WIDGET_URI, "text/html;profile=mcp-app"],
    [PAYMENT_WIDGET_OPENAI_URI, "text/html+skybridge"],
  ]);

  const read = await server.handle({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: PAYMENT_WIDGET_URI } });
  const html = read.result.contents[0].text;
  assert.equal(read.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.doesNotMatch(html, /__CHAINPAY_LOGO__|__TOKEN_ICONS__|__PREVIEW__/, "every placeholder is filled");
  assert.match(html, /data:image\/svg\+xml;base64,/, "the USDC art is inlined");
  for (const step of ["Request verified", "Guardrails passed", "Delegated authorization confirmed", "Submitting to Solana", "Waiting for confirmation", "Receipt recorded"]) {
    assert.ok(html.includes(step), step);
  }
  assert.ok(html.includes("No transaction was signed or submitted. No funds moved."));
  assert.doesNotMatch(html, /x402|execute_payment|quote_payment_request/, "the card never shows tool names or x402");

  const missing = await server.handle({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "ui://chainpay/nope.html" } });
  assert.equal(missing.error.code, -32002);
});

test("the three payment tools point at the card", () => {
  const withCard = TOOL_DEFINITIONS.filter((tool) => tool._meta?.ui?.resourceUri === PAYMENT_WIDGET_URI).map((tool) => tool.name).sort();
  assert.deepEqual(withCard, ["execute_payment", "quote_payment_request", "wait_for_payment"]);
  for (const tool of TOOL_DEFINITIONS.filter((item) => item._meta)) {
    assert.equal(tool._meta["openai/outputTemplate"], PAYMENT_WIDGET_OPENAI_URI);
  }
});

test("the preview page carries its illustrative label", () => {
  assert.ok(paymentWidgetHtml("<p>preview</p>").includes("<p>preview</p>"));
  assert.ok(!paymentWidgetHtml().includes("__PREVIEW__"));
});

function storeContext(recipient) {
  const data = Buffer.alloc(165);
  new PublicKey(USDC).toBuffer().copy(data, 0);
  return {
    client: {
      commitment: "confirmed",
      connection: { getAccountInfo: async (key) => key.toBase58() === recipient ? { owner: new PublicKey(TOKEN_PROGRAM), data } : null },
      getMintDecimals: async () => 6,
      getCurrentSlot: async () => 1_000n,
    },
  };
}

test("the demo store signs exact USDC invoices the SDK verifies", async () => {
  const recipient = Keypair.generate().publicKey.toBase58();
  const previous = process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT;
  process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT = recipient;
  try {
    const ten = await createDemoStoreRequest(storeContext(recipient), "market-report", "https://store.test");
    assert.equal(ten.request.payload.amount, "10000000");
    assert.equal(ten.request.payload.mint, USDC);
    assert.equal(ten.request.payload.tokenProgram, "spl-token");
    assert.equal(ten.request.payload.description, "Market data report");
    assert.equal(ten.request.payload.expiresAtSlot, "6000");
    const verified = await verifyPaymentRequest(ten.request, 1_000n);
    assert.equal(verified.valid, true, verified.reason);

    const license = await createDemoStoreRequest(storeContext(recipient), "annual-license", "https://store.test");
    assert.equal(license.request.payload.amount, "25000000");
    assert.notEqual(license.request.payload.nonce, ten.request.payload.nonce);

    const tampered = structuredClone(license.request);
    tampered.payload.amount = "10000000";
    assert.equal((await verifyPaymentRequest(tampered, 1_000n)).valid, false, "an edited amount breaks the merchant signature");

    await assert.rejects(createDemoStoreRequest(storeContext(recipient), "free-lunch", "https://store.test"), DemoStoreError);
  } finally {
    if (previous === undefined) delete process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT;
    else process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT = previous;
  }
});

test("the demo store refuses to sign without a payout account", async () => {
  const previous = process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT;
  delete process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT;
  try {
    await assert.rejects(createDemoStoreRequest(storeContext("x"), "market-report", "https://store.test"), (error) => error.status === 503);
  } finally {
    if (previous !== undefined) process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT = previous;
  }
});
