import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { BASE_URL, launchBrowser } from "./browser/_helpers.mjs";

// Isolated visual review: all network traffic except local Vite assets is blocked.
const browser = await launchBrowser();
const output = process.env.CHAINPAY_REDESIGN_ARTIFACTS || "/tmp/chainpay-redesign-review";
await mkdir(output, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
const forbidden = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== new URL(BASE_URL).origin || /\/(api|rpc|v1)(\/|$)/.test(url.pathname)) {
    forbidden.push(url.href);
    return route.abort();
  }
  return route.continue();
});
const click = (name) => page.getByRole("button", { name, exact: true }).click();
const screenshot = async (name) => {
  const dismiss = page.getByRole("button", { name: "Dismiss notice", exact: true });
  if (await dismiss.count()) await dismiss.click();
  return page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
};
async function fits() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Document overflows viewport");
}
try {
  await page.goto(`${BASE_URL}/test/fixtures/dashboard-redesign.html`);
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await fits();
  await screenshot("overview-desktop");
  await page.getByRole("button", { name: "A payment is ready for review", exact: false }).click();
  await page.getByRole("dialog", { name: "Review payment" }).waitFor();
  await screenshot("payment-review");
  await click("Simulate approval");
  assert.equal(await page.getByText("1 item", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Data assistant’s permission expires tomorrow", { exact: true }).count(), 1);

  await click("7Hn9…mK2p");
  await page.getByRole("dialog", { name: "Connected wallet" }).waitFor();
  await screenshot("wallet-menu");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Connected wallet" }).count(), 0);
  await click("7Hn9…mK2p");
  await click("Change wallet");
  await page.getByRole("button", { name: "Solflare Sample wallet", exact: false }).click();
  await click("Simulate connection");
  await page.getByRole("heading", { name: "Sign in to ChainPay" }).waitFor();
  await screenshot("wallet-sign-in");
  await click("Simulate sign-in");

  await click("New permission");
  await screenshot("permission-method-desktop");
  assert.equal(await page.getByRole("radio", { name: "Ask me each time", exact: false }).isChecked(), true);
  await click("Set spending limits");
  await page.getByLabel("Maximum per payment (USDC)").fill("301");
  await click("Review permission");
  await page.getByRole("alert").getByText("The per-payment limit cannot exceed the total allowance.").waitFor();
  await page.getByLabel("Maximum per payment (USDC)").fill("0.1234567");
  await click("Review permission");
  await page.getByRole("alert").getByText("This mint supports 6 decimal places.").waitFor();
  await page.getByLabel("Maximum per payment (USDC)").fill("25.123456");
  await page.getByLabel("Maximum per payment (USDC)").blur();
  await screenshot("permission-limits-desktop");
  await click("Review permission");
  await page.getByText("25.123456 USDC", { exact: true }).waitFor();
  await screenshot("permission-review-desktop");
  await click("Back");
  assert.equal(await page.getByLabel("Maximum per payment (USDC)").inputValue(), "25.123456");
  await click("Review permission");
  await click("Simulate wallet approval");
  await page.getByRole("heading", { name: "Your permission is ready" }).waitFor();
  await click("Finish preview");
  await page.getByText("Permission preview complete. No permission was created on-chain.").waitFor();

  await page.getByLabel("Preview state").selectOption("setup");
  await click("New permission");
  await page.getByRole("radio", { name: "Automatically within my limits", exact: false }).check();
  await click("Set spending limits");
  await click("Review permission");
  await page.getByRole("alert").getByText("Prepare your token account before continuing.").waitFor();
  await screenshot("permission-prerequisite");
  await click("Preview account setup");
  await click("Simulate account preparation");
  await click("Review permission");
  await page.getByText("Automatic within limits", { exact: true }).waitFor();
  await page.getByRole("main").getByRole("button", { name: "Spending permissions", exact: true }).click();

  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
    if (width <= 800) await click("Open navigation");
    await click("Overview");
    for (const state of ["attention", "healthy", "empty", "loading", "error"]) {
      await page.getByLabel("Preview state").selectOption(state);
      await fits();
      await screenshot(`overview-${state}-${width}`);
    }
    await page.getByLabel("Preview state").selectOption("healthy");
    await click("New permission");
    await fits();
    await screenshot(`permission-method-${width}`);
    await click("Set spending limits");
    await fits();
    await screenshot(`permission-limits-${width}`);
    await click("Review permission");
    await fits();
    await screenshot(`permission-review-${width}`);
    await page.getByRole("main").getByRole("button", { name: "Spending permissions", exact: true }).click();
  }

  await click("Open navigation");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "Open navigation" }).getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByRole("button", { name: "Open navigation" }).evaluate((el) => document.activeElement === el), true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByLabel("Preview state").selectOption("loading");
  assert.equal(await page.locator(".dp-skeleton").first().evaluate((el) => getComputedStyle(el).animationName), "none");

  // Equivalent CSS viewport at 200% desktop zoom; explicit CSS zoom catches fixed-width children too.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByLabel("Preview state").selectOption("healthy");
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  await fits();
  await screenshot("zoom-200");
  assert.deepEqual(errors, [], "Browser runtime errors");
  assert.deepEqual(forbidden, [], "Preview attempted external or financial network traffic");
  console.log(`PASS: preview flows, exact inputs, prerequisites, wallet dialogs, keyboard navigation, 390/768/1440 layouts, 200% zoom, reduced motion, and no external/financial requests. Screenshots: ${output}`);
} finally {
  await browser.close();
}
