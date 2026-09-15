import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  DEFAULT_PROGRAM_ID,
  DELIVERY_CANONICAL_FIXTURE_JSON,
  DELIVERY_CANONICAL_FIXTURE_SIGNATURE,
  DELIVERY_FIXTURE_RECEIPT_ADDRESS,
  DELIVERY_FIXTURE_SELLER_ADDRESS,
  DELIVERY_FIXTURE_SELLER_SEED,
  DELIVERY_HASH_FIXTURE_SHA256,
  canonicalDeliveryPayload,
  signDeliveryAttestation,
  verifyDeliveryAttestation,
} from "@chainpay/sdk";
import { createMerchantApp } from "../dist/app.js";
import { loadSellerPublishConfig, sellerPublishConfigFromSecret } from "../dist/config.js";
import { bindServedResponseLifecycle, serializeJsonBody, sha256Hex } from "../dist/delivery.js";
import { createAxumDeliveryPublisher } from "../dist/publisher.js";
import { makeCustomSettlement } from "./settlement-fixture.mjs";

const FIXTURE_SERVED_AT = "2026-09-15T04:16:00.000Z";
const BACKEND = "http://127.0.0.1:18080";
const OTHER_SELLER = "11111111111111111111111111111111";

function fixtureSecretBase64() {
  return Buffer.from(DELIVERY_FIXTURE_SELLER_SEED).toString("base64");
}

function sellerConfig() {
  return sellerPublishConfigFromSecret({
    backendUrl: BACKEND,
    programId: DEFAULT_PROGRAM_ID,
    secretKey: Uint8Array.from(DELIVERY_FIXTURE_SELLER_SEED),
    trustedSeller: DELIVERY_FIXTURE_SELLER_ADDRESS,
  });
}

function jsonResponse(status, body) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function publicDto(envelope) {
  return {
    payload: envelope.payload,
    signature: envelope.signature,
    publishedAt: "2026-09-15T04:16:01.000Z",
  };
}

async function fixtureEnvelope(contentHash = DELIVERY_HASH_FIXTURE_SHA256, servedAt = FIXTURE_SERVED_AT) {
  return signDeliveryAttestation({
    version: 1,
    statement: "chainpay.response-served",
    cluster: "devnet",
    programId: DEFAULT_PROGRAM_ID,
    receiptAddress: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
    seller: DELIVERY_FIXTURE_SELLER_ADDRESS,
    contentHash,
    servedAt,
  }, Uint8Array.from(DELIVERY_FIXTURE_SELLER_SEED));
}

function publishInput(contentHash = DELIVERY_HASH_FIXTURE_SHA256) {
  return {
    receiptAddress: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
    contentHash,
    body: Buffer.from("unused"),
    programId: DEFAULT_PROGRAM_ID,
    cluster: "devnet",
  };
}

function publisherWith(fetchImpl) {
  return createAxumDeliveryPublisher(sellerConfig(), {
    now: () => new Date(FIXTURE_SERVED_AT),
    sleep: async () => undefined,
    log() {},
    fetchImpl,
  });
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("seller publish is disabled without key or backend URL and never reads the MCP demo key", () => {
  assert.equal(loadSellerPublishConfig({}, DEFAULT_PROGRAM_ID), undefined);
  assert.equal(loadSellerPublishConfig({ CHAINPAY_SELLER_SECRET_KEY: fixtureSecretBase64() }, DEFAULT_PROGRAM_ID), undefined);
  assert.equal(loadSellerPublishConfig({ CHAINPAY_BACKEND_URL: BACKEND }, DEFAULT_PROGRAM_ID), undefined);
  assert.equal(loadSellerPublishConfig({
    CHAINPAY_DEMO_MERCHANT_SECRET_KEY: fixtureSecretBase64(),
    CHAINPAY_BACKEND_URL: BACKEND,
  }, DEFAULT_PROGRAM_ID), undefined);
});

test("seller publish accepts the SDK 0x07 fixture key and rejects a mismatched trusted seller", () => {
  const loaded = loadSellerPublishConfig({
    CHAINPAY_SELLER_SECRET_KEY: fixtureSecretBase64(),
    CHAINPAY_BACKEND_URL: `${BACKEND}/`,
    CHAINPAY_TRUSTED_SELLER: DELIVERY_FIXTURE_SELLER_ADDRESS,
  }, DEFAULT_PROGRAM_ID);
  assert.equal(loaded.seller, DELIVERY_FIXTURE_SELLER_ADDRESS);
  assert.equal(loaded.backendUrl, BACKEND);
  assert.equal(JSON.stringify(loaded).includes(fixtureSecretBase64()), false);

  assert.throws(
    () => loadSellerPublishConfig({
      CHAINPAY_SELLER_SECRET_KEY: fixtureSecretBase64(),
      CHAINPAY_BACKEND_URL: BACKEND,
      CHAINPAY_TRUSTED_SELLER: OTHER_SELLER,
    }, DEFAULT_PROGRAM_ID),
    /CHAINPAY_TRUSTED_SELLER/,
  );
});

test("SDK fixture bytes stay canonical when the merchant publisher signs", async () => {
  const envelope = await fixtureEnvelope();
  assert.equal(canonicalDeliveryPayload(envelope.payload), DELIVERY_CANONICAL_FIXTURE_JSON);
  assert.equal(envelope.signature, DELIVERY_CANONICAL_FIXTURE_SIGNATURE);
});

test("HTTP 200 finish POSTs one frozen envelope; early close and 402 do not publish", async () => {
  const calls = [];
  const envelope = await fixtureEnvelope();
  const publisher = publisherWith(async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    if ((init.method ?? "GET") === "GET") return jsonResponse(404);
    return jsonResponse(200, publicDto(envelope));
  });

  const aborted = new EventEmitter();
  aborted.statusCode = 200;
  bindServedResponseLifecycle(aborted, {
    contentHash: DELIVERY_HASH_FIXTURE_SHA256,
    receiptAddress: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
    programId: DEFAULT_PROGRAM_ID,
    publisher,
    body: Buffer.from("x"),
  });
  aborted.emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);

  const paymentRequired = new EventEmitter();
  paymentRequired.statusCode = 402;
  bindServedResponseLifecycle(paymentRequired, {
    contentHash: DELIVERY_HASH_FIXTURE_SHA256,
    receiptAddress: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
    programId: DEFAULT_PROGRAM_ID,
    publisher,
    body: Buffer.from("x"),
  });
  paymentRequired.emit("finish");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);

  let finished;
  const ok = new EventEmitter();
  ok.statusCode = 200;
  bindServedResponseLifecycle(ok, {
    contentHash: DELIVERY_HASH_FIXTURE_SHA256,
    receiptAddress: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
    programId: DEFAULT_PROGRAM_ID,
    publisher,
    body: Buffer.from("x"),
    onWork: (work) => {
      finished = work;
    },
  });
  ok.emit("finish");
  await finished;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, `${BACKEND}/v1/delivery-attestations`);
  assert.equal(calls[1].body, JSON.stringify({ payload: envelope.payload, signature: envelope.signature }));
});

test("publisher reuses a matching trusted statement and does not POST", async () => {
  const envelope = await fixtureEnvelope();
  const calls = [];
  const publisher = createAxumDeliveryPublisher(sellerConfig(), {
    now: () => new Date("2026-09-15T04:17:00.000Z"),
    sleep: async () => undefined,
    log() {},
    async fetchImpl(_url, init = {}) {
      calls.push(init.method ?? "GET");
      return jsonResponse(200, publicDto(envelope));
    },
  });
  await publisher.publish(publishInput());
  assert.deepEqual(calls, ["GET"]);
});

test("publisher never treats an older hash as proof of a new body", async () => {
  const previous = await fixtureEnvelope();
  const calls = [];
  const publisher = publisherWith(async (_url, init = {}) => {
    calls.push(init.method ?? "GET");
    return jsonResponse(200, publicDto(previous));
  });
  await publisher.publish(publishInput("aa".repeat(32)));
  assert.deepEqual(calls, ["GET"]);
});

test("mocked Axum POST 409 GETs the existing statement and reuses a matching hash", async () => {
  const envelope = await fixtureEnvelope();
  const calls = [];
  const publisher = createAxumDeliveryPublisher(sellerConfig(), {
    now: () => new Date("2026-09-15T04:17:00.000Z"),
    sleep: async () => undefined,
    log() {},
    async fetchImpl(_url, init = {}) {
      calls.push(init.method ?? "GET");
      if ((init.method ?? "GET") === "GET") {
        return calls.includes("POST") ? jsonResponse(200, publicDto(envelope)) : jsonResponse(404);
      }
      return jsonResponse(409, { error: "A conflicting delivery attestation already exists for this receipt and seller" });
    },
  });
  await publisher.publish(publishInput());
  assert.deepEqual(calls, ["GET", "POST", "GET"]);
});

test("mocked Axum POST 409 with a different hash does not become proof of the new body", async () => {
  const previous = await fixtureEnvelope();
  const newerHash = "bb".repeat(32);
  let posts = 0;
  const publisher = publisherWith(async (_url, init = {}) => {
    if ((init.method ?? "GET") === "GET") {
      return posts === 0 ? jsonResponse(404) : jsonResponse(200, publicDto(previous));
    }
    posts += 1;
    return jsonResponse(409, { error: "conflict" });
  });
  await publisher.publish(publishInput(newerHash));
  assert.equal(posts, 1);
});

test("mocked Axum outage retries the identical signed bytes and leaves the statement absent", async () => {
  const envelope = await fixtureEnvelope();
  const posts = [];
  const sleeps = [];
  const publisher = createAxumDeliveryPublisher(sellerConfig(), {
    now: () => new Date(FIXTURE_SERVED_AT),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log() {},
    async fetchImpl(_url, init = {}) {
      if ((init.method ?? "GET") === "GET") return jsonResponse(404);
      posts.push(init.body);
      throw new Error("connect ECONNREFUSED");
    },
  });
  await assert.rejects(() => publisher.publish(publishInput()), /ECONNREFUSED/);
  const frozen = JSON.stringify({ payload: envelope.payload, signature: envelope.signature });
  assert.deepEqual(posts, [frozen, frozen, frozen]);
  assert.deepEqual(sleeps, [200, 800]);
});

test("paid HTTP 200 publishes through mocked Axum; 402 and verify failure do not", async () => {
  const fixture = await makeCustomSettlement("fixture-nonce-publish");
  const posts = [];
  const publisher = publisherWith(async (_url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return jsonResponse(404);
    const envelope = JSON.parse(init.body);
    posts.push(envelope);
    const verified = await verifyDeliveryAttestation(envelope, { programId: DEFAULT_PROGRAM_ID });
    assert.equal(verified.valid, true);
    assert.equal(envelope.payload.receiptAddress, fixture.proof.payload.receiptPDA);
    assert.equal(envelope.payload.seller, DELIVERY_FIXTURE_SELLER_ADDRESS);
    return jsonResponse(200, { ...envelope, publishedAt: FIXTURE_SERVED_AT });
  });

  const app = createMerchantApp(fixture.config, fixture.references, {
    async getFinalizedReceipt() {
      return fixture.receipt;
    },
    async getFinalizedTransaction() {
      return fixture.wireResult;
    },
    publisher,
  });
  const server = await listen(app);
  try {
    const missing = await fetch(`${server.base}/data`);
    assert.equal(missing.status, 402);
    await app.waitForDeliveryWork();
    assert.deepEqual(posts, []);

    const failed = await fetch(`${server.base}/data`, { headers: { "X-PAYMENT": "not-json" } });
    assert.equal(failed.status, 402);
    await app.waitForDeliveryWork();
    assert.deepEqual(posts, []);

    const paid = await fetch(`${server.base}/data`, {
      headers: { "X-PAYMENT": JSON.stringify(fixture.proof) },
    });
    assert.equal(paid.status, 200);
    const paidBody = Buffer.from(await paid.arrayBuffer());
    assert.equal(sha256Hex(paidBody), sha256Hex(serializeJsonBody(JSON.parse(paidBody.toString("utf8")))));
    await app.waitForDeliveryWork();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].payload.contentHash, sha256Hex(paidBody));
    assert.deepEqual(app.delivery.publishedReceipts(), [fixture.proof.payload.receiptPDA]);
  } finally {
    await server.close();
  }
});
