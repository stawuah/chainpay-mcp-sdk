import assert from "node:assert/strict";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);

await page.goto(`${BASE_URL}/test/fixtures/dashboard-nav.html`);
await page.getByRole("navigation").waitFor();

const labels = ["Overview", "Spending permissions", "Payments", "Agents", "Receipts", "Requests", "Developer tools", "Protocol", "Settings"];
for (const label of labels) {
  assert.ok(
    await page.getByRole("button", { name: label }).count() > 0,
    `missing sidebar destination: ${label}`,
  );
}
assert.equal(await page.getByRole("button", { name: "Connect MCP" }).count(), 0);

await page.getByRole("button", { name: /^Agents$/ }).click();
assert.equal(await page.getByTestId("active-tab").textContent(), "agents");

await page.getByRole("button", { name: /^Requests/ }).click();
assert.equal(await page.getByTestId("active-tab").textContent(), "assistant");

await page.goto(`${BASE_URL}/app/connect-mcp`);
await page.getByRole("heading", { name: /Set up your first mandate|Agents/i }).waitFor();
assert.equal((await page.locator("body").innerText()).includes("Connect MCP"), false);

assert.deepEqual(errors, []);
console.log("PASS: sidebar destinations, Requests label, no Connect MCP; /app/connect-mcp compat route loads.");
await browser.close();
