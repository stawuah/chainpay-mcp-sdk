import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scoped = await readFile(join(frontendRoot, "src/ui/record-details.css"), "utf8");
const appWide = scoped.split("\n").filter((line) => /^\s*\.cp-app[\s.]/.test(line));
assert.deepEqual(appWide, [], "record-details.css must not contain app-wide .cp-app rules");

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);

const address = "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1";
const fixture = await (await page.request.get(`${BASE_URL}/test/fixtures/permission-details.html`)).text();
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname === "fonts.googleapis.com") {
    return route.fulfill({ contentType: "text/css", body: "" });
  }
  if (url.origin !== new URL(BASE_URL).origin) return route.abort();
  if (request.isNavigationRequest() && url.pathname.startsWith("/app/")) {
    return route.fulfill({ contentType: "text/html", body: fixture });
  }
  return route.continue();
});

await page.goto(`${BASE_URL}/app/mandates`);
const row = page.getByRole("row", { name: `Inspect spending permission ${address}`, exact: true });
await row.waitFor({ timeout: 10000 });

const mainBgBefore = await page.locator(".dashboard-main").evaluate((el) => getComputedStyle(el).backgroundColor);
const sidebarBefore = await page.locator(".dashboard-sidebar").evaluate((el) => getComputedStyle(el).borderRadius).catch(() => "n/a");

await row.click();
await page.getByRole("dialog", { name: "Spending permission" }).waitFor();

const mainBgAfter = await page.locator(".dashboard-main").evaluate((el) => getComputedStyle(el).backgroundColor);
assert.equal(mainBgAfter, mainBgBefore, "opening the record panel must not restyle dashboard-main background");

if (sidebarBefore !== "n/a") {
  const sidebarAfter = await page.locator(".dashboard-sidebar").evaluate((el) => getComputedStyle(el).borderRadius);
  assert.equal(sidebarAfter, sidebarBefore, "opening the record panel must not restyle sidebar radius");
}

assert.deepEqual(errors, []);
console.log("PASS: record-details.css scoped; permission panel does not restyle dashboard chrome.");
await browser.close();
