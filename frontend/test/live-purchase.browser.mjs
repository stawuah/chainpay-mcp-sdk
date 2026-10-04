import assert from "node:assert/strict";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);

await page.goto(`${BASE_URL}/test/fixtures/live-purchase.html`);
await page.getByTestId("pending-total").waitFor();
await page.locator('.purchase-card [data-amount-state="verified"]').first().waitFor();

assert.equal(await page.getByTestId("pending-total").textContent(), "2");
assert.equal(await page.getByTestId("waiting").textContent(), "1");

const body = await page.locator("body").innerText();
assert.match(body, /Vendor invoice #42/);
assert.match(body, /4\.50*\s*USDC/);
assert.doesNotMatch(body, /\bbase units\b/, "amounts go through the shared Amount, never raw base units");
assert.match(body, /Waiting for wallet approval/i);
assert.match(body, /Over-limit purchase/);
assert.match(body, /exceeds this permission/i);
assert.equal(body.includes("assistant commentary only"), false);

const cards = page.locator(".purchase-card");
assert.equal(await cards.count(), 2);

assert.deepEqual(errors, []);
console.log("PASS: live purchase cards from structured fields; attention counts; blocked limit copy.");
await browser.close();
