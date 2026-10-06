import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { decodeMandateRequestLink, verifyMandateRequest } from "@chainpayhq/sdk";
import { createMerchantApp } from "../dist/app.js";
import { loadMandateRequestSettings } from "../dist/mandate-requests.js";
import { makeCustomSettlement } from "./settlement-fixture.mjs";

const SLOT = 400_000_000n;
const SELLER_SEED_HEX = "07".repeat(32);

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const unusedVerification = {
  async getFinalizedReceipt() {
    throw new Error("not used");
  },
  async getFinalizedTransaction() {
    throw new Error("not used");
  },
};

const lookup = {
  getCurrentSlot: async () => SLOT,
  getMintDecimals: async () => 6,
};

test("POST /mandate-requests returns a signed vendor link and a plain summary", async () => {
  const fixture = await makeCustomSettlement();
  const settings = loadMandateRequestSettings(
    { CHAINPAY_SELLER_SECRET_KEY: SELLER_SEED_HEX, CHAINPAY_APP_URL: "http://localhost:5173/" },
    fixture.config,
  );
  assert.equal(settings.throwawayKey, false);
  assert.equal(settings.requester, Keypair.fromSeed(Buffer.from(SELLER_SEED_HEX, "hex")).publicKey.toBase58());
  const app = createMerchantApp(fixture.config, fixture.references, {
    ...unusedVerification,
    mandateRequests: { settings, lookup },
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.base}/mandate-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poNumber: "PO-1042" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["link", "summary"]);
    assert.match(body.link, /^http:\/\/localhost:5173\/app\/requests\/permission#req=[A-Za-z0-9_-]+$/);
    assert.ok(body.link.length < 2000);
    assert.match(
      body.summary,
      /^Asks for up to 0\.1 \S+ per payment, 1 \S+ total, 30 days\. Payee .+….+\. Link valid 7 days\.$/,
    );
    const signed = decodeMandateRequestLink(body.link);
    const verified = await verifyMandateRequest(signed, SLOT);
    assert.equal(verified.valid, true, verified.reason);
    assert.equal(signed.payload.role, "vendor");
    assert.equal(signed.payload.requester, settings.requester);
    assert.equal(signed.payload.recipient, fixture.config.recipient);
    assert.equal(signed.payload.mint, fixture.config.mint);
    assert.equal(signed.payload.suggestedMaxPerPayment, fixture.config.amount);
    assert.equal(signed.payload.poNumber, "PO-1042");
    assert.equal(signed.payload.requesterName, "ChainPay demo merchant");

    const generated = await (await fetch(`${server.base}/mandate-requests`, { method: "POST" })).json();
    assert.match(decodeMandateRequestLink(generated.link).payload.poNumber, /^PO-[0-9A-F]{6}$/);

    const invalid = await fetch(`${server.base}/mandate-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poNumber: "P".repeat(65) }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /at most 64/);
    const wrongType = await fetch(`${server.base}/mandate-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poNumber: 1042 }),
    });
    assert.equal(wrongType.status, 400);
  } finally {
    await server.close();
  }
});

test("the seller secret never appears in a response", async () => {
  const fixture = await makeCustomSettlement();
  const settings = loadMandateRequestSettings({ CHAINPAY_SELLER_SECRET_KEY: SELLER_SEED_HEX }, fixture.config);
  const app = createMerchantApp(fixture.config, fixture.references, {
    ...unusedVerification,
    mandateRequests: { settings, lookup },
  });
  const server = await listen(app);
  try {
    const text = await (await fetch(`${server.base}/mandate-requests`, { method: "POST" })).text();
    const decoded = decodeMandateRequestLink(JSON.parse(text).link);
    const everything = `${text}${JSON.stringify(decoded)}`;
    assert.ok(!everything.includes(SELLER_SEED_HEX));
    assert.ok(!everything.includes(Buffer.from(SELLER_SEED_HEX, "hex").toString("base64")));
  } finally {
    await server.close();
  }
});

test("lookup failures are 502 and sign nothing; no key in production is 503", async () => {
  const fixture = await makeCustomSettlement();
  assert.equal(loadMandateRequestSettings({ NODE_ENV: "production" }, fixture.config), undefined);
  const dev = loadMandateRequestSettings({}, fixture.config);
  assert.equal(dev.throwawayKey, true);

  const failing = createMerchantApp(fixture.config, fixture.references, {
    ...unusedVerification,
    mandateRequests: {
      settings: dev,
      lookup: { getCurrentSlot: async () => { throw new Error("rpc https://secret.example down"); }, getMintDecimals: async () => 6 },
    },
  });
  const disabled = createMerchantApp(fixture.config, fixture.references, unusedVerification);
  const first = await listen(failing);
  const second = await listen(disabled);
  try {
    const failed = await fetch(`${first.base}/mandate-requests`, { method: "POST" });
    assert.equal(failed.status, 502);
    const failedBody = await failed.json();
    assert.doesNotMatch(failedBody.error, /secret\.example/);
    const off = await fetch(`${second.base}/mandate-requests`, { method: "POST" });
    assert.equal(off.status, 503);
    assert.match((await off.json()).error, /CHAINPAY_SELLER_SECRET_KEY/);
  } finally {
    await first.close();
    await second.close();
  }
});

test("GET / serves the Pay us with ChainPay page with no external assets", async () => {
  const fixture = await makeCustomSettlement();
  const app = createMerchantApp(fixture.config, fixture.references, unusedVerification);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /<title>Pay us with ChainPay<\/title>/);
    assert.match(html, />Request permission</);
    assert.match(html, /fetch\("\/mandate-requests"/);
    assert.match(html, /#0052ff/);
    assert.match(html, /#14213d/);
    assert.doesNotMatch(html, /<link |src="http|url\(http|@import/);
  } finally {
    await server.close();
  }
});
