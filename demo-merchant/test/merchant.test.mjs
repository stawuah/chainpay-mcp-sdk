import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@chainpay/sdk";
import { createMerchantApp } from "../dist/app.js";
import { customPaymentRequired } from "../dist/config.js";
import {
  bindServedResponseLifecycle,
  serializeJsonBody,
  sha256Hex,
} from "../dist/delivery.js";
import {
  MerchantProofError,
  SOLANA_DEVNET_CAIP2,
  detectAndParsePaymentHeader,
  encodeCanonicalBase58,
  inspectPaymentHeader,
  parseCustomReceiptProof,
  publicProofErrorBody,
} from "../dist/proof.js";
import { AMOUNT, RESOURCE, makeCustomSettlement } from "./settlement-fixture.mjs";

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("parseCustomReceiptProof accepts JSON and base64 custom proofs and rejects malformed", () => {
  const agent = Keypair.generate();
  const receipt = Keypair.generate().publicKey.toBase58();
  const signature = encodeCanonicalBase58(agent.secretKey.subarray(0, 64));
  const proof = {
    version: "x402/1.0",
    scheme: "exact",
    network: "solana-devnet",
    payload: { signature, receiptPDA: receipt },
  };
  assert.deepEqual(parseCustomReceiptProof(JSON.stringify(proof)), proof);
  assert.deepEqual(parseCustomReceiptProof(Buffer.from(JSON.stringify(proof), "utf8").toString("base64")), proof);
  assert.throws(() => parseCustomReceiptProof(JSON.stringify([proof])), MerchantProofError);
  assert.throws(() => parseCustomReceiptProof("null"), MerchantProofError);
  assert.throws(() => parseCustomReceiptProof(JSON.stringify({ ...proof, extra: true })), MerchantProofError);
  assert.throws(() => parseCustomReceiptProof(JSON.stringify({ ...proof, version: "x402/2.0" })), MerchantProofError);
});

test("standard v2 documents are detected from body, not header name, and never parsed as custom proofs", () => {
  const v2 = {
    x402Version: 2,
    resource: { url: RESOURCE, mimeType: "application/json" },
    accepted: {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      amount: "100000",
      asset: Keypair.generate().publicKey.toBase58(),
      payTo: Keypair.generate().publicKey.toBase58(),
      maxTimeoutSeconds: 60,
      extra: { feePayer: Keypair.generate().publicKey.toBase58() },
    },
    payload: { transaction: Buffer.from("partially-signed").toString("base64") },
  };
  assert.equal(inspectPaymentHeader(JSON.stringify(v2)).kind, "standard-v2");
  assert.throws(() => parseCustomReceiptProof(JSON.stringify(v2)), MerchantProofError);
  try {
    detectAndParsePaymentHeader(JSON.stringify(v2));
    assert.fail("expected unsupported protocol");
  } catch (error) {
    assert.equal(error.category, "unsupported_protocol");
    assert.equal(error.mode, "unsupported-sponsor");
  }
  const numeric = { ...v2, accepted: { ...v2.accepted, amount: 100000 } };
  try {
    detectAndParsePaymentHeader(JSON.stringify(numeric));
    assert.fail("expected invalid numeric amount");
  } catch (error) {
    assert.equal(error.category, "invalid_proof");
  }
});

test("custom 402 challenge uses recipient token account and exact integer amount", async () => {
  const fixture = await makeCustomSettlement();
  const challenge = customPaymentRequired(fixture.config);
  assert.equal(challenge.version, "x402/1.0");
  assert.equal(challenge.accepts[0].payTo, fixture.config.recipient);
  assert.equal(challenge.accepts[0].payTo, fixture.config.recipient);
  assert.notEqual(challenge.accepts[0].payTo, fixture.owner);
  assert.equal(challenge.accepts[0].maxAmountRequired, AMOUNT);
  assert.equal(typeof challenge.accepts[0].maxAmountRequired, "string");
});

test("HTTP custom 402 then mocked proof returns 200; standard v2 is unsupported without settlement", async () => {
  const fixture = await makeCustomSettlement();
  let receiptReads = 0;
  let transactionReads = 0;
  const published = [];
  const app = createMerchantApp(fixture.config, fixture.references, {
    async getFinalizedReceipt() {
      receiptReads += 1;
      return fixture.receipt;
    },
    async getFinalizedTransaction() {
      transactionReads += 1;
      return fixture.wireResult;
    },
    publisher: {
      async publish(input) {
        published.push(input.receiptAddress);
      },
    },
  });
  const server = await listen(app);
  try {
    const missing = await fetch(`${server.base}/data`);
    assert.equal(missing.status, 402);
    const challenge = await missing.json();
    assert.equal(challenge.version, "x402/1.0");
    assert.equal(challenge.accepts[0].payTo, fixture.config.recipient);
    await app.waitForDeliveryWork();
    assert.deepEqual(published, []);

    const paid = await fetch(`${server.base}/data`, {
      headers: { "X-PAYMENT": JSON.stringify(fixture.proof) },
    });
    assert.equal(paid.status, 200);
    const body = await paid.json();
    assert.equal(body.data, "Premium resource content");
    assert.equal(body.paidWith, fixture.proof.payload.receiptPDA);
    assert.equal(body.transactionSignature, fixture.proof.payload.signature);
    await app.waitForDeliveryWork();
    assert.deepEqual(published, [fixture.proof.payload.receiptPDA]);
    assert.equal(receiptReads, 1);
    assert.equal(transactionReads, 1);

    const v2 = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        amount: AMOUNT,
        asset: fixture.config.mint,
        payTo: fixture.owner,
        maxTimeoutSeconds: 60,
        extra: { feePayer: fixture.owner },
      },
      payload: { transaction: fixture.wireResult.transaction[0] },
    };
    const standard = await fetch(`${server.base}/data`, {
      headers: { "X-PAYMENT": JSON.stringify(v2) },
    });
    assert.equal(standard.status, 402);
    const standardBody = await standard.json();
    assert.equal(standardBody.code, "unsupported_protocol");
    assert.equal(standardBody.mode, "unsupported-sponsor");
    assert.equal(receiptReads, 1);
    assert.equal(transactionReads, 1);

    const named = await fetch(`${server.base}/data`, {
      headers: { "PAYMENT-SIGNATURE": JSON.stringify(v2) },
    });
    assert.equal(named.status, 402);
    assert.equal((await named.json()).mode, "unsupported-sponsor");
    assert.equal(receiptReads, 1);

    const malformed = await fetch(`${server.base}/data`, {
      headers: { "X-PAYMENT": "not-json" },
    });
    assert.equal(malformed.status, 402);
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.code, "invalid_proof");
    assert.equal(malformedBody.error, "Payment verification failed");
    assert.equal(JSON.stringify(malformedBody).includes("not-json"), false);
    assert.equal(receiptReads, 1);
    assert.equal(transactionReads, 1);
  } finally {
    await server.close();
  }
});

test("provider errors and URLs are scrubbed from public responses", async () => {
  const fixture = await makeCustomSettlement();
  const app = createMerchantApp(fixture.config, fixture.references, {
    async getFinalizedReceipt() {
      throw new Error("getAccountInfo failed https://user:secret@rpc.example/secret-path");
    },
    async getFinalizedTransaction() {
      throw new Error("should not run");
    },
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.base}/data`, {
      headers: { "X-PAYMENT": JSON.stringify(fixture.proof) },
    });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes("rpc.example"), false);
    assert.equal(body.includes("secret"), false);
    assert.equal(body.includes("https://"), false);
    const parsed = JSON.parse(body);
    assert.equal(parsed.code, "rpc_unavailable");
  } finally {
    await server.close();
  }
});

test("early close and 402 do not publish; 200 finish hashes exact bytes", async () => {
  const published = [];
  const publisher = {
    async publish(input) {
      published.push(input.contentHash);
    },
  };
  const body = serializeJsonBody({ data: "café\n\t" });
  const expectedHash = sha256Hex(body);
  assert.equal(expectedHash, createHash("sha256").update(body).digest("hex"));
  assert.match(expectedHash, /^[0-9a-f]{64}$/);

  const aborted = new EventEmitter();
  aborted.statusCode = 200;
  bindServedResponseLifecycle(aborted, {
    contentHash: expectedHash,
    receiptAddress: "receipt",
    programId: DEFAULT_PROGRAM_ID,
    publisher,
    body,
  });
  aborted.emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, []);

  const failed = new EventEmitter();
  failed.statusCode = 402;
  bindServedResponseLifecycle(failed, {
    contentHash: expectedHash,
    receiptAddress: "receipt",
    programId: DEFAULT_PROGRAM_ID,
    publisher,
    body,
  });
  failed.emit("finish");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, []);

  let finished;
  const ok = new EventEmitter();
  ok.statusCode = 200;
  bindServedResponseLifecycle(ok, {
    contentHash: expectedHash,
    receiptAddress: "receipt",
    programId: DEFAULT_PROGRAM_ID,
    publisher,
    body,
    onWork: (work) => {
      finished = work;
    },
  });
  ok.emit("finish");
  await finished;
  assert.deepEqual(published, [expectedHash]);
});

test("public proof errors never include stacks or configured credentials", () => {
  const mapped = publicProofErrorBody(new Error("boom at https://api.devnet.solana.com/?key=abc"));
  assert.equal(mapped.body.code, "invalid_proof");
  assert.equal(JSON.stringify(mapped.body).includes("devnet"), false);
  assert.equal(JSON.stringify(mapped.body).includes("abc"), false);
  assert.equal(JSON.stringify(mapped.body).includes("boom"), false);
});
