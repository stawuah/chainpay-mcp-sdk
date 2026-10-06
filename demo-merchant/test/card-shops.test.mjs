import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { CARD_SANDBOX_MERCHANTS } from "@chainpayhq/sdk";
import { CARD_SHOPS, loadCardShopSettings, mountCardShops } from "../dist/card-shops.js";

const SECRET = "runner-secret-0123456789abcdef0123456789abcdef";
const CAPABILITY = `cpcap_v1_${"A".repeat(43)}`;
const PAN = "4111111111111111";

async function listen(deps) {
  const app = express();
  mountCardShops(app, deps);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** Axum double for POST /v1/cards/checkout/redeem. */
function axum(reply) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      const { status, body } = typeof reply === "function" ? reply(JSON.parse(init.body)) : reply;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  };
}

const settings = { apiUrl: "https://relay.test", runnerSecret: SECRET };

test("the two fixture shops match the connector's registry and hashes", async () => {
  assert.deepEqual(CARD_SHOPS.map((s) => [s.ref, s.acceptorId, s.mcc, s.fixture]), [
    ["demo-approved", "DEMO-DATAAPI", 5734, "approved"],
    ["demo-unapproved", "DEMO-OTHERSHOP", 5999, "unapproved"],
  ]);
  assert.equal(CARD_SHOPS.length, CARD_SANDBOX_MERCHANTS.length);
  const server = await listen({});
  try {
    const list = await (await fetch(`${server.base}/card-shops`)).json();
    assert.equal(list.sandbox, true);
    assert.deepEqual(list.shops.map((s) => s.merchantIdHash), [
      "c641205da7b4735f8b074cd50780e178cc28433179e3d34a9807df9dc5874a6e",
      "bf1ff5b21426217893bab740bd3d1b18fd67f32b52e1f4dff6b6ce4dad72bc24",
    ]);
    assert.deepEqual(list.shops[0].checkout.arguments, { merchantRef: "demo-approved", amountCents: "2000", currency: "USD" });
    const page = await fetch(`${server.base}/card-shops/demo-approved`, { headers: { accept: "text/html" } });
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    const html = await page.text();
    assert.match(html, /ChainPay demo shop/);
    assert.match(html, /\$20\.00/);
    assert.match(html, /never sees a card number/);
    assert.doesNotMatch(html, /<input|<form|<script/i, "nowhere to type card details, no scripts");
    assert.equal((await fetch(`${server.base}/card-shops/nope`)).status, 404);
  } finally {
    await server.close();
  }
});

test("approved shop: redeems for its own ref and price, returns an order with no card data", async () => {
  const relay = axum({ status: 200, body: { runId: "ab".repeat(16), state: "submitted", lithicToken: "txn-123", pan: PAN, cvv: "123", embedUrl: "https://lithic/embed?x" } });
  const server = await listen({ settings, fetch: relay.fetch });
  try {
    const response = await fetch(`${server.base}/card-shops/demo-approved/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: CAPABILITY }) });
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.order.state, "sent_to_card_network");
    assert.equal(body.order.amountCents, "2000");
    assert.equal(body.runId, "ab".repeat(16));
    assert.ok(!text.includes(PAN) && !/cvv|embed|lithicToken|txn-123/i.test(text), `no card data or issuer token in ${text}`);
    assert.equal(relay.calls.length, 1);
    assert.equal(relay.calls[0].url, "https://relay.test/v1/cards/checkout/redeem");
    assert.equal(relay.calls[0].headers.authorization, `Bearer ${SECRET}`);
    assert.deepEqual(relay.calls[0].body, { capability: CAPABILITY, merchantRef: "demo-approved", amountCents: "2000" });
  } finally {
    await server.close();
  }
});

test("unapproved shop: the card's rules refuse it and the shop says so plainly", async () => {
  const relay = axum({ status: 409, body: { code: "intent_refused", detail: "MerchantMismatch", message: `raw upstream text ${PAN}` } });
  const server = await listen({ settings, fetch: relay.fetch });
  try {
    const response = await fetch(`${server.base}/card-shops/demo-unapproved/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: CAPABILITY }) });
    assert.equal(response.status, 409);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "The card's rules refused this checkout.", code: "intent_refused" });
    assert.ok(!text.includes(PAN), "Axum's text is never forwarded");
    assert.deepEqual(relay.calls[0].body, { capability: CAPABILITY, merchantRef: "demo-unapproved", amountCents: "1000" });
  } finally {
    await server.close();
  }
});

test("checkout takes only a capability, never card details", async () => {
  const relay = axum({ status: 500, body: {} });
  const server = await listen({ settings, fetch: relay.fetch });
  const post = (body) => fetch(`${server.base}/card-shops/demo-approved/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const body of [{ capability: CAPABILITY, pan: PAN }, { pan: PAN }, { capability: PAN }, { capability: CAPABILITY, amountCents: "1" }, [CAPABILITY]]) {
      const response = await post(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok(!(await response.text()).includes(PAN));
    }
    assert.equal(relay.calls.length, 0, "nothing reached ChainPay");
    assert.equal((await post({ capability: CAPABILITY })).status, 502, "unknown upstream failure is a 502, not a pass");
  } finally {
    await server.close();
  }
  const off = await listen({});
  try {
    const response = await fetch(`${off.base}/card-shops/demo-approved/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: CAPABILITY }) });
    assert.equal(response.status, 503);
  } finally {
    await off.close();
  }
});

test("runner settings need both values, a long secret and https", () => {
  assert.equal(loadCardShopSettings({}), undefined);
  assert.deepEqual(loadCardShopSettings({ CHAINPAY_CARDS_API_URL: "https://relay.test/", CHAINPAY_CARDS_RUNNER_SECRET: SECRET }), settings);
  assert.ok(loadCardShopSettings({ CHAINPAY_CARDS_API_URL: "http://127.0.0.1:8080", CHAINPAY_CARDS_RUNNER_SECRET: SECRET }));
  assert.throws(() => loadCardShopSettings({ CHAINPAY_CARDS_API_URL: "https://relay.test" }), /both/);
  assert.throws(() => loadCardShopSettings({ CHAINPAY_CARDS_API_URL: "https://relay.test", CHAINPAY_CARDS_RUNNER_SECRET: "short" }), /32 characters/);
  assert.throws(() => loadCardShopSettings({ CHAINPAY_CARDS_API_URL: "http://relay.test", CHAINPAY_CARDS_RUNNER_SECRET: SECRET }), /https/);
});
