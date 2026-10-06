import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { prepareCrossmintPayment, executeCrossmintPayment, crossmintPaymentStatus } from "../dist/tools/crossmint.js";
import { fetchCrossmintOrder } from "../dist/tools/crossmint-provider.js";
import { authorizeTool } from "../dist/authorization.js";
import { normalizeToolOutcome } from "../dist/outcome.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** What api.devnet.solana.com's getGenesisHash returns (not the truncated CAIP-2 reference). */
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Crossmint's memo shape: a JWT naming the order, between fixed markers. */
function memoFor(orderIdentifier, nonce = "nonce-1") {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `------BEGIN MEMO------${segment({ alg: "HS256", typ: "JWT" })}.${segment({ nonce, orderIdentifier, iat: 1791203887 })}.c2lnbmF0dXJl------END MEMO------`;
}
function crossmintWire(transfer, owner, memo) {
  const memoIx = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [{ pubkey: new PublicKey(owner), isSigner: true, isWritable: false }], data: Buffer.from(memo) });
  return new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: PublicKey.default.toBase58() }).add(transfer, memoIx).serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
function fixture() {
  const owner = addr(), mandate = addr(), source = addr(), recipient = addr();
  const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(1234567n, 1); data[9] = 6;
  const instruction = new TransactionInstruction({ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [source, mint, recipient, owner].map((a, i) => ({ pubkey: new PublicKey(a), isSigner: i === 3, isWritable: i === 0 || i === 2 })), data });
  const memo = memoFor("order_1");
  const delivery = addr();
  const raw = { order: { orderId: "order_1", phase: "payment", lineItems: [{ chain: "solana", tokenLocator: "solana:token-address", metadata: { name: "Test item" }, quantity: 1, delivery: { status: "awaiting-payment", recipient: { locator: `solana:${delivery}`, walletAddress: delivery } } }], quote: { status: "valid", expiresAt: "2030-01-01T00:00:00Z", totalPrice: { amount: "1.234567", currency: "usdc" } }, payment: { method: "solana", currency: "usdc", status: "awaiting-payment", preparation: { chain: "solana", payerAddress: owner, serializedTransaction: crossmintWire(instruction, owner, memo), transactionParameters: { amount: "1234567", memo } } } } };
  let preparations = 0;
  const context = { principal: { wallet: owner, scope: null }, backendUrl: "https://relay.invalid", backendAuthToken: "caller-token", client: {
    connection: { getGenesisHash: async () => DEVNET_GENESIS_HASH, getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 }) },
    getMandate: async () => ({ address: mandate, owner, approvedAgent: owner, sourceTokenAccount: source, allowedMint: mint }),
    preparePayment: async () => { preparations++; return { receiptAddress: addr(), preflight: { valid: true, checks: [] }, transaction: { feePayer: owner, requiredSigners: [owner], instructions: [{ name: "execute_payment", programId: instruction.programId.toBase58(), keys: instruction.keys.map(k => ({ address: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data }] } }; },
  } };
  /** Re-prepare the order with a new memo, as Crossmint does when it re-quotes. */
  const withMemo = (next) => { const changed = structuredClone(raw); changed.order.payment.preparation.transactionParameters.memo = next; changed.order.payment.preparation.serializedTransaction = crossmintWire(instruction, owner, next); return changed; };
  return { raw, memo, withMemo, context, args: { orderId: "order_1", mandate, agent: owner }, preparations: () => preparations };
}
function configure(t) {
  const fetch = globalThis.fetch, enabled = process.env.CHAINPAY_CROSSMINT_ENABLED, key = process.env.CROSSMINT_API_KEY, authSecret = process.env.CHAINPAY_CROSSMINT_AUTH_SECRET;
  process.env.CHAINPAY_CROSSMINT_ENABLED = "true"; process.env.CROSSMINT_API_KEY = "test-provider-secret"; process.env.CHAINPAY_CROSSMINT_AUTH_SECRET = "test-only".repeat(8);
  t.after(() => { globalThis.fetch = fetch; for (const [name, value] of [["CHAINPAY_CROSSMINT_ENABLED", enabled], ["CROSSMINT_API_KEY", key], ["CHAINPAY_CROSSMINT_AUTH_SECRET", authSecret]]) value === undefined ? delete process.env[name] : process.env[name] = value; });
}

test("disabled checkout performs no provider request", async t => {
  configure(t); delete process.env.CHAINPAY_CROSSMINT_ENABLED;
  globalThis.fetch = async () => { throw new Error("unexpected network"); };
  await assert.rejects(fetchCrossmintOrder("order_1"), /disabled/);
});
test("preparation is read-only and returns the original Crossmint continuation without credentials", async t => {
  configure(t); const f = fixture(); const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(f.raw); };
  const result = await prepareCrossmintPayment(f.context, f.args);
  assert.equal(result.structuredContent.action, "crossmint_agent_signature_required");
  assert.equal(result.structuredContent.payment.amount, "1234567");
  assert.equal(result.structuredContent.continuation.tool, "execute_crossmint_payment");
  assert.equal(normalizeToolOutcome(result).kind, "payment_approval_required");
  assert.equal(calls.length, 1); assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error"); assert.match(calls[0].url, /^https:\/\/staging.crossmint.com\//);
  assert(!JSON.stringify(result).includes("test-provider-secret"));
});
test("stale terms are rejected before relay submission", async t => {
  configure(t); const f = fixture(); const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return url.startsWith("https://relay.invalid") ? new Response(null, { status: 404 }) : Response.json(f.raw); };
  const result = await executeCrossmintPayment(f.context, { ...f.args, signingMode: "human", signedTransaction: "original", expectedTerms: "old" });
  assert.equal(result.structuredContent.action, "crossmint_rejected_before_submission");
  assert(calls.every(c => c.init.method !== "POST"));
});
test("payer mutation requires explicit owner intent and cannot run through execution or scoped preparation", async t => {
  configure(t); const f = fixture(); const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(init.method); return Response.json(f.raw); };
  await prepareCrossmintPayment(f.context, { ...f.args, preparePayer: true });
  assert.deepEqual(calls, ["GET", "PATCH"]);
  f.context.principal.scope = { version: 1, mandates: [f.args.mandate], agents: { [f.args.mandate]: f.args.agent }, tools: ["prepare_crossmint_payment"] };
  await assert.rejects(prepareCrossmintPayment(f.context, { ...f.args, preparePayer: true }), /owner session/);
  assert.equal(calls.at(-1), "GET");
  await assert.rejects(authorizeTool(f.context, "execute_crossmint_payment", f.args), /not permitted/);
});
test("existing confirmed operation resumes while disabled and retains confirmation if provider readback fails", async t => {
  configure(t); const f = fixture(); delete process.env.CHAINPAY_CROSSMINT_ENABLED;
  const id = `payment_${"a".repeat(64)}`, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/proof")) throw new Error("timeout");
    return Response.json({ connector: "crossmint", connector_reference: "order_1", idempotency_key: "key", payment: { payment_id: id, status: "confirmed", signature: "signature", receipt_address: "receipt", mandate: f.args.mandate } });
  };
  const result = await crossmintPaymentStatus(f.context, { paymentId: id });
  assert.equal(result.structuredContent.status, "confirmed"); assert.equal(result.structuredContent.providerStatus, "unknown");
  assert.equal(f.preparations(), 0); assert(calls.every(url => url.startsWith("https://relay.invalid")));
});
test("provider identity and response-size mismatches fail closed", async t => {
  configure(t); const f = fixture(); f.raw.order.orderId = "different";
  globalThis.fetch = async () => Response.json(f.raw);
  await assert.rejects(fetchCrossmintOrder("order_1"), /different order/);
  globalThis.fetch = async () => new Response("x".repeat(128001));
  await assert.rejects(fetchCrossmintOrder("order_1"), /exceeds/);
});

test("reviewed execution forwards bound provider authorization and preserves uncertain submission", async t => {
  configure(t); const f = fixture(); let submission;
  globalThis.fetch = async () => Response.json(f.raw);
  const prepared = await prepareCrossmintPayment(f.context, f.args);
  const args = { ...prepared.structuredContent.continuation.arguments, signedTransaction: "original-signed-bytes" };
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/connector")) return new Response(null, { status: 404 });
    if (url.startsWith("https://staging.crossmint.com")) return Response.json(f.raw);
    submission = JSON.parse(init.body);
    throw new TypeError("fixture transport failed");
  };
  const result = await executeCrossmintPayment(f.context, args);
  assert.equal(result.structuredContent.status, "unknown");
  assert.match(result.structuredContent.payment_id, /^payment_[a-f0-9]{64}$/);
  assert.equal(submission.signed_transaction, "original-signed-bytes");
  assert.equal(submission.amount, "1234567");
  const authorization = submission.crossmint.terms.authorization;
  assert.equal(createHmac("sha256", process.env.CHAINPAY_CROSSMINT_AUTH_SECRET).update(authorization.payload).digest("hex"), authorization.mac);
  const bound = JSON.parse(authorization.payload);
  assert.equal(bound.owner, f.context.principal.wallet); assert.equal(bound.mandate, f.args.mandate);
  assert.equal(bound.invoiceHash, args.invoiceHash); assert.equal(bound.terms.amount, submission.amount);
  // The relay compares the whole bound terms object, so delivery terms are inside the MAC.
  assert.equal(bound.terms.items[0].deliveryRecipient, f.raw.order.lineItems[0].delivery.recipient.walletAddress);
  assert.equal(bound.terms.items[0].quantity, 1);
  assert.deepEqual(bound.terms.items, submission.crossmint.terms.items);
  // The memo the relay allows beside execute_payment is inside the MAC too.
  assert.equal(bound.terms.memo, f.memo);
  assert.equal(submission.crossmint.terms.memo, f.memo);
  assert(!JSON.stringify(result).includes(authorization.mac));
});

async function reviewed(t) {
  configure(t); const f = fixture();
  globalThis.fetch = async () => Response.json(f.raw);
  const prepared = await prepareCrossmintPayment(f.context, f.args);
  return { f, args: { ...prepared.structuredContent.continuation.arguments, signedTransaction: "original-signed-bytes" }, prepared };
}
/** Route relay and provider calls; any POST to a payment route is a second purchase attempt. */
function route(f, { connector = () => new Response(null, { status: 404 }), order = () => f.raw } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    if (url.endsWith("/connector")) return connector();
    if (url.startsWith("https://staging.crossmint.com")) return Response.json(order());
    if (/\/v1\/(managed-)?payments$/.test(url)) throw new Error("unexpected payment submission");
    throw new Error(`unexpected ${url}`);
  };
  return calls;
}
const submissions = (calls) => calls.filter(c => /\/v1\/(managed-)?payments$/.test(c.url));

test("the reviewed request shows who receives the item and how many", async t => {
  const { prepared, f } = await reviewed(t);
  const [item] = prepared.structuredContent.crossmint.items;
  assert.equal(item.quantity, 1);
  assert.equal(item.deliveryRecipient, f.raw.order.lineItems[0].delivery.recipient.walletAddress);
});

test("the prepared transaction is execute_payment then Crossmint's exact memo, unsigned", async t => {
  const { prepared, f } = await reviewed(t);
  const { instructions, requiredSigners, feePayer } = prepared.structuredContent.transaction;
  assert.deepEqual(instructions.map(ix => ix.name), ["execute_payment", "crossmint_order_memo"]);
  assert.equal(instructions[1].programId, MEMO_PROGRAM);
  assert.deepEqual(instructions[1].keys, []);
  assert.equal(Buffer.from(instructions[1].dataBase64, "base64").toString("utf8"), f.memo);
  assert.deepEqual(requiredSigners, [f.args.agent]); assert.equal(feePayer, f.args.agent);
  // The wallet-ready bytes carry the same two instructions.
  const unsigned = Transaction.from(Buffer.from(prepared.structuredContent.unsignedTransaction.value, "base64"));
  assert.equal(unsigned.instructions.length, 2);
  assert.equal(unsigned.instructions[1].programId.toBase58(), MEMO_PROGRAM);
  assert.equal(unsigned.instructions[1].data.toString("utf8"), f.memo);
  assert.equal(unsigned.instructions[1].keys.length, 0);
});

test("the owner review names the item being bought", async t => {
  const { prepared } = await reviewed(t);
  assert.equal(prepared.structuredContent.crossmint.itemLabel, "Test item");
  assert.equal(prepared.structuredContent.crossmint.items[0].name, "Test item");
  assert.match(prepared.content[0].text, /Item: \*\*Test item\*\* × 1/);
});

test("a changed order memo on re-fetch requires a fresh owner review", async t => {
  const { f, args } = await reviewed(t);
  const calls = route(f, { order: () => f.withMemo(memoFor("order_1", "nonce-2")) });
  const result = await executeCrossmintPayment(f.context, args);
  assert.equal(result.structuredContent.action, "crossmint_rejected_before_submission");
  assert.equal(result.structuredContent.reviewRequired, true);
  assert.equal(submissions(calls).length, 0);
});

test("a re-fetched memo for another order, disagreeing memo copies or an unnamed item are refused before submission", async t => {
  for (const changed of [
    (f) => f.withMemo(memoFor("another_order")),
    (f) => { const raw = structuredClone(f.raw); raw.order.payment.preparation.transactionParameters.memo = memoFor("order_1", "nonce-3"); return raw; },
    (f) => { const raw = structuredClone(f.raw); raw.order.lineItems[0].metadata = {}; return raw; },
  ]) {
    const { f, args } = await reviewed(t);
    const order = changed(f);
    const calls = route(f, { order: () => order });
    const result = await executeCrossmintPayment(f.context, args);
    assert.equal(result.structuredContent.action, "crossmint_rejected_before_submission");
    assert.equal(submissions(calls).length, 0);
  }
});

test("a changed delivery wallet or quantity at the same price requires a fresh owner review", async t => {
  for (const change of [
    (item) => { const moved = addr(); item.delivery.recipient = { locator: `solana:${moved}`, walletAddress: moved }; },
    (item) => { item.quantity = 2; },
    (item) => { item.tokenLocator = "solana:other-token"; },
    (item) => { item.metadata.name = "Another item"; },
  ]) {
    const { f, args } = await reviewed(t);
    const changed = structuredClone(f.raw); change(changed.order.lineItems[0]);
    const calls = route(f, { order: () => changed });
    const result = await executeCrossmintPayment(f.context, args);
    assert.equal(result.structuredContent.action, "crossmint_rejected_before_submission");
    assert.equal(result.structuredContent.reviewRequired, true);
    assert.match(result.structuredContent.message, /delivery wallet/);
    assert.equal(submissions(calls).length, 0);
  }
});

test("expired quote, payer mismatch and amount mismatch stop before any submission", async t => {
  for (const change of [
    (order) => { order.quote.expiresAt = "2000-01-01T00:00:00Z"; },
    (order) => { order.quote.status = "expired"; },
    (order) => { order.payment.preparation.payerAddress = addr(); },
    (order) => { order.quote.totalPrice.amount = "1.234568"; },
  ]) {
    const { f, args } = await reviewed(t);
    const changed = structuredClone(f.raw); change(changed.order);
    const calls = route(f, { order: () => changed });
    const result = await executeCrossmintPayment(f.context, args);
    assert.equal(result.structuredContent.action, "crossmint_rejected_before_submission");
    assert.equal(submissions(calls).length, 0);
  }
});

test("replay and refresh resume the original operation, even after the quote expired", async t => {
  const { f, args } = await reviewed(t);
  const before = f.preparations();
  const expired = structuredClone(f.raw); expired.order.quote.expiresAt = "2000-01-01T00:00:00Z"; expired.order.phase = "completed";
  let id;
  const calls = route(f, {
    order: () => expired,
    connector: () => Response.json({ connector: "crossmint", connector_reference: "order_1", idempotency_key: "key", payment: { payment_id: id, status: "submitted", mandate: f.args.mandate } }),
  });
  globalThis.fetch = ((inner) => async (url, init) => { id ??= url.match(/payment_[a-f0-9]{64}/)?.[0]; return inner(url, init); })(globalThis.fetch);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executeCrossmintPayment(f.context, args);
    assert.equal(result.structuredContent.payment_id, id);
    assert.equal(result.structuredContent.action, "crossmint_payment_pending");
  }
  assert.equal(submissions(calls).length, 0);
  assert.equal(f.preparations(), before, "no second payment is prepared");
  assert(calls.every(c => !c.url.startsWith("https://staging.crossmint.com")), "a known operation is resumed before the provider is asked again");
});

test("an ambiguous original-operation check never turns into a replacement purchase", async t => {
  const { f, args } = await reviewed(t);
  const calls = route(f, { connector: () => new Response("upstream", { status: 502 }) });
  await assert.rejects(executeCrossmintPayment(f.context, args), /do not submit a replacement/);
  assert.equal(submissions(calls).length, 0);
});

test("status keeps payment, delivery and refund apart: completed order, failed delivery, refund", async t => {
  configure(t); const f = fixture(); delete process.env.CHAINPAY_CROSSMINT_ENABLED;
  const id = `payment_${"b".repeat(64)}`;
  // The relay's sanitized observation of Crossmint's documented failed-delivery example.
  const proof = { orderId: "order_1", orderPhase: "completed", paymentStatus: "completed", delivery: "failed", refunded: { amount: "1.234567", currency: "usdc" }, deliveries: [{ status: "failed", failureCode: "slippage-tolerance-exceeded" }], evidenceSource: "crossmint-staging-orders-api", reportedAtMs: 1_790_000_000_000 };
  globalThis.fetch = async (url) => url.endsWith("/proof")
    ? Response.json({ proof })
    : Response.json({ connector: "crossmint", connector_reference: "order_1", idempotency_key: "key", payment: { payment_id: id, status: "confirmed", signature: "signature", receipt_address: "receipt", mandate: f.args.mandate } });
  const result = await crossmintPaymentStatus(f.context, { paymentId: id });
  const { crossmint } = result.structuredContent;
  assert.equal(result.structuredContent.status, "confirmed");
  assert.equal(crossmint.phase, "completed");
  assert.equal(crossmint.paymentStatus, "completed");
  assert.equal(crossmint.delivery, "failed");
  assert.equal(crossmint.refunded, true);
  assert.deepEqual(crossmint.refund, { amount: "1.234567", currency: "usdc" });
  assert.equal(crossmint.deliveries[0].failureCode, "slippage-tolerance-exceeded");
  assert.equal(result.structuredContent.providerDelivery, "failed");
  assert.equal(f.preparations(), 0);
});

test("only Devnet's full genesis hash passes the network check", async t => {
  for (const genesis of ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"]) {
    configure(t); const f = fixture(); const calls = [];
    f.context.client.connection.getGenesisHash = async () => genesis;
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(f.raw); };
    await assert.rejects(prepareCrossmintPayment(f.context, f.args), /requires Solana Devnet/);
    assert.equal(calls.length, 0, "the provider is not asked about an order on another network");
  }
});

/** Submit a reviewed order and answer the relay POST with `status`. */
async function submitWithRelayAnswer(t, status, body) {
  const { f, args } = await reviewed(t);
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith("/connector")) return new Response(null, { status: 404 });
    if (url.startsWith("https://staging.crossmint.com")) return Response.json(f.raw);
    if (/\/v1\/payments$/.test(url)) { posts.push(JSON.parse(init.body)); return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }); }
    throw new Error(`unexpected ${url}`);
  };
  return { f, args, posts, result: await executeCrossmintPayment(f.context, args) };
}

test("a relay 5xx after broadcast is an unknown outcome to resume, never a rejection", async t => {
  for (const [status, body] of [[500, { error: "storage error: Convex storage error: storage request rejected (409)" }], [502, "Bad Gateway"], [409, { error: "conflict" }]]) {
    const { f, args, posts, result } = await submitWithRelayAnswer(t, status, body);
    const outcome = result.structuredContent;
    assert.equal(posts.length, 1);
    assert.notEqual(outcome.action, "backend_rejected");
    assert.equal(outcome.action, "crossmint_payment_pending");
    assert.equal(outcome.status, "unknown");
    assert.equal(outcome.httpStatus, status);
    // The same deterministic id the relay assigns and the dashboard tracks.
    const expected = `payment_${createHash("sha256").update(`${f.context.principal.wallet}:${posts[0].idempotency_key}`).digest("hex")}`;
    assert.equal(outcome.payment_id, expected);
    assert.deepEqual(outcome.continuation, { tool: "get_crossmint_payment", arguments: { paymentId: expected } });
    assert.match(outcome.message, /may already have been sent/);
    assert.match(outcome.message, /Do not retry/);
    assert.equal(normalizeToolOutcome(result).kind, "payment_pending");
    assert.equal(args.invoiceHash, posts[0].invoice_hash);
  }
});

test("only a relay refusal before broadcast is reported as backend_rejected", async t => {
  for (const status of [400, 401, 403, 404, 422]) {
    const { result } = await submitWithRelayAnswer(t, status, { error: "refused" });
    assert.equal(result.structuredContent.action, "backend_rejected");
    assert.equal(result.structuredContent.httpStatus, status);
    assert.equal(result.isError, true);
  }
});
