import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { prepareCrossmintPayment, executeCrossmintPayment, crossmintPaymentStatus } from "../dist/tools/crossmint.js";
import { fetchCrossmintOrder } from "../dist/tools/crossmint-provider.js";
import { authorizeTool } from "../dist/authorization.js";
import { normalizeToolOutcome } from "../dist/outcome.js";

const addr = () => Keypair.generate().publicKey.toBase58();
function fixture() {
  const owner = addr(), mandate = addr(), source = addr(), recipient = addr();
  const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(1234567n, 1); data[9] = 6;
  const instruction = new TransactionInstruction({ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [source, mint, recipient, owner].map((a, i) => ({ pubkey: new PublicKey(a), isSigner: i === 3, isWritable: i === 0 || i === 2 })), data });
  const transaction = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: PublicKey.default.toBase58() }).add(instruction);
  const raw = { order: { orderId: "order_1", phase: "payment", quote: { status: "valid", expiresAt: "2030-01-01T00:00:00Z", totalPrice: { amount: "1.234567", currency: "usdc" } }, payment: { method: "solana", currency: "usdc", status: "awaiting-payment", preparation: { chain: "solana", payerAddress: owner, serializedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") } } } };
  let preparations = 0;
  const context = { principal: { wallet: owner, scope: null }, backendUrl: "https://relay.invalid", backendAuthToken: "caller-token", client: {
    connection: { getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 }) },
    getMandate: async () => ({ address: mandate, owner, approvedAgent: owner, sourceTokenAccount: source, allowedMint: mint }),
    preparePayment: async () => { preparations++; return { receiptAddress: addr(), preflight: { valid: true, checks: [] }, transaction: { feePayer: owner, requiredSigners: [owner], instructions: [{ name: "fixture", programId: instruction.programId.toBase58(), keys: instruction.keys.map(k => ({ address: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data }] } }; },
  } };
  return { raw, context, args: { orderId: "order_1", mandate, agent: owner }, preparations: () => preparations };
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
  assert(!JSON.stringify(result).includes(authorization.mac));
});
