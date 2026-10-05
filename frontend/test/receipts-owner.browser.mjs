// Owner Receipts tab in the dashboard harness: limits at payment, the signed
// invoice from a stand-in relay session, Share with details, and Export CSV.
// No wallet, no backend, external requests blocked. Not payment evidence.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const V1 = "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1";
const V2 = "3Rcpt2v2SnapshotFixture111111111111111111";

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);
await page.addInitScript(() => { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); });

await page.goto(`${BASE_URL}/test/fixtures/dashboard-harness.html?tab=receipts&receipts`);
await page.locator(`button[aria-label="Preview USDC receipt ${V2}"]`).waitFor();

// v2 receipt: on-chain snapshot plus the owner's verified invoice.
await page.locator(`button[aria-label="Preview USDC receipt ${V2}"]`).click();
const card = page.locator(".receipt-preview-card .receipt-card");
await card.getByText("Market data API, October usage").waitFor();
let text = await card.innerText();
assert.match(text, /4\.50 USDC ≤ 5 USDC per payment/);
assert.match(text, /Recorded on Solana at payment/);
assert.match(text, /If paid today: within limits/);
assert.match(text, /Invoice signed by seller/);
assert.equal(text.includes("details private"), false);
assert.equal(await card.locator("[data-stamp]").count(), 3);

await card.getByRole("button", { name: /Share with details/ }).click();
await page.getByText("Receipt link with invoice details copied.").waitFor();
const copied = await page.evaluate(() => navigator.clipboard.readText());
assert.match(copied, new RegExp(`/verify/${V2}#purchase=[A-Za-z0-9_-]+$`));

// Following the copied audit link on /verify shows the same details, verified there.
const fragment = copied.split("#purchase=")[1];
const fixture = JSON.parse(await readFile(new URL("./fixtures/receipt-purchase.json", import.meta.url), "utf8"));
assert.deepEqual(JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")), fixture.request);

// v1 receipt: nothing recorded, today's limits instead, no Order match.
await page.locator(`button[aria-label="Preview USDC receipt ${V1}"]`).click();
await card.getByText("Not recorded for this receipt. These are today’s limits, not the ones at payment.").waitFor();
text = await card.innerText();
assert.equal(text.includes("Order match"), false);
assert.match(text, /Status today/);

// Export CSV downloads one file with both receipts.
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Export CSV" }).click(),
]);
assert.match(download.suggestedFilename(), /^chainpay-receipts-\d{4}-\d{2}-\d{2}\.csv$/);
const csv = await readFile(await download.path(), "utf8");
const lines = csv.trimEnd().split("\r\n");
assert.equal(lines.length, 3);
assert.match(lines[0], /^Date,Description,Amount,Payee,Reference,/);
assert.ok(lines.some((line) => line.includes(V2) && line.includes(",on-chain,")));
assert.ok(lines.some((line) => line.includes(V1) && line.includes(",not-recorded,")));
await page.getByText(/Saved chainpay-receipts-.*· 2 receipts\./).waitFor();

for (const width of [390, 320]) {
  await page.setViewportSize({ width, height: 900 });
  await page.locator(`button[aria-label="Preview USDC receipt ${V2}"]`).click();
  await card.getByText("Market data API, October usage").waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no horizontal scroll at ${width}px (overflow ${overflow})`);
  const exportBox = await page.getByRole("button", { name: "Export CSV" }).boundingBox();
  assert.ok(exportBox && exportBox.height >= 44, `Export CSV is at least 44px tall at ${width}px`);
}

assert.deepEqual(errors, []);
console.log("PASS: owner receipts show limits at payment, the verified invoice, Share with details, and Export CSV.");
await browser.close();
