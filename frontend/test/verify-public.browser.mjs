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

assert.deepEqual(errors, []);
console.log("PASS: public verify malformed, settled, and not-found; no inbox attribution or wallet chrome.");
await browser.close();
