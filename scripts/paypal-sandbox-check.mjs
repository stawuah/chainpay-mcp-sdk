#!/usr/bin/env node
// Quick sandbox feature check for the PayPal allowances work. Sandbox only.
// Usage: PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-sandbox-check.mjs
// Prints whether the app can vault a PayPal wallet and read the Disputes API.
// The secret is used for the token call and never printed.
const BASE = "https://api-m.sandbox.paypal.com";
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app) first.");
  process.exit(1);
}

async function token() {
  const response = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

async function call(bearer, method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `sandbox-check-${Date.now()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: response.status, json };
}

const bearer = await token();
console.log("token: ok");

const setup = await call(bearer, "POST", "/v3/vault/setup-tokens", {
  payment_source: {
    paypal: {
      usage_type: "MERCHANT",
      experience_context: {
        return_url: "https://example.com/paypal/?allowance=check",
        cancel_url: "https://example.com/paypal/?allowance=check&cancelled=true",
      },
    },
  },
});
const approve = (setup.json.links || []).find(l => l.rel === "approve" || l.rel === "payer-action");
console.log(`vault setup token (paypal wallet): HTTP ${setup.status} status=${setup.json.status || "-"}`);
if (approve) console.log(`  approve link: ${approve.href}`);
else console.log(`  error: ${setup.json.name || "-"} ${setup.json.message || ""}`.trim());

const disputes = await call(bearer, "GET", "/v1/customer/disputes?page_size=1");
const enabled = disputes.status === 200 && Array.isArray(disputes.json.items);
console.log(`disputes api: HTTP ${disputes.status} ${enabled ? "enabled" : `not enabled (${disputes.json.name || "-"})`}`);
