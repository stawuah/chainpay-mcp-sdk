import assert from "node:assert/strict";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);

await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=malformed`);
await page.getByRole("heading", { name: "Payment receipt" }).waitFor();
const malformed = page.getByRole("alert");
assert.ok(await malformed.count() > 0);
assert.match(await malformed.textContent(), /not a valid Solana account/i);
assert.equal(await page.locator("[data-stamp='paid']").count(), 0);
assert.equal((await page.locator("body").innerText()).includes("Prepared in Requests"), false);

await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=settled`);
await page.getByText("4.500000 USDC").waitFor();
assert.match(await page.locator("body").innerText(), /No seller statement|seller/i);
assert.equal((await page.locator("body").innerText()).includes("Prepared in Requests"), false);
assert.equal((await page.locator("body").innerText()).includes("Connect wallet"), false);
assert.ok(await page.locator("[data-stamp='paid'][data-tone='yes']").count() > 0);

await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=not_found`);
await page.getByRole("heading", { name: "No ChainPay receipt exists at this address." }).waitFor();
assert.equal(await page.locator("[data-stamp='paid']").count(), 0);

// Limits at payment from the receipt's on-chain snapshot; no purchase claim without a link.
await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=v2`);
await page.getByRole("heading", { name: "Spending permission at payment" }).waitFor();
let body = await page.locator("body").innerText();
assert.match(body, /4\.50 USDC ≤ 5 USDC per payment/);
assert.match(body, /12 of 50 USDC used after this payment/);
assert.match(body, /Payment 3 of 10/);
assert.match(body, /Recorded on Solana at payment/);
assert.match(body, /If paid today: blocked — the spending permission is paused/);
assert.equal(body.includes("Order match"), false);
assert.equal(await page.locator("[data-stamp]").count(), 3, "no fourth stamp");

// Relay observation that already counts later payments: running totals left out.
await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=relay`);
await page.getByText("Seen by the ChainPay relay after payment, not stored on Solana").waitFor();
body = await page.locator("body").innerText();
assert.equal(body.includes("used after this payment"), false);
assert.match(body, /over today’s 3 USDC per-payment limit/);

// Audit link: details only after the signed request verifies against the receipt.
const purchaseFixture = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./fixtures/receipt-purchase.json", import.meta.url), "utf8"));
const fragment = Buffer.from(JSON.stringify(purchaseFixture.request)).toString("base64url");
await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=v2#purchase=${fragment}`);
await page.getByText("Market data API, October usage").waitFor();
assert.equal(await page.locator("[data-pill]").textContent(), "No order");
const tampered = structuredClone(purchaseFixture.request);
tampered.payload.description = "Something else";
await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=v2#purchase=${Buffer.from(JSON.stringify(tampered)).toString("base64url")}`);
await page.getByText(/Invoice not verified/).waitFor();
body = await page.locator("body").innerText();
assert.equal(body.includes("Something else"), false);
assert.equal(body.includes("INV-2026-0142"), false);

for (const width of [390, 320]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE_URL}/test/fixtures/verify-public.html?case=v2#purchase=${fragment}`);
  await page.getByText("Market data API, October usage").waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no horizontal scroll at ${width}px (overflow ${overflow})`);
}

assert.deepEqual(errors, []);
console.log("PASS: public verify malformed, settled, not-found, limits at payment (on-chain, relay), audit link pass/fail; no inbox attribution or wallet chrome.");
await browser.close();
