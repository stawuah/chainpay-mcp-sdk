import assert from "node:assert/strict";
import { chromium } from "playwright";
const BASE_URL = (process.env.CHAINPAY_PREVIEW_URL || "http://127.0.0.1:5189").replace(/\/$/, "");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
const requests = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === new URL(BASE_URL).origin) return route.continue();
  requests.push({ path: url.pathname, method: request.method() });
  const body = request.postDataJSON();
  let payload = {};
  if (url.pathname.endsWith("/auth/challenge")) payload = { challenge_id: "fixture", message: "Fixture login only" };
  else if (url.pathname.endsWith("/auth/session")) payload = { token: "fixture-session", wallet: "11111111111111111111111111111111", expires_at_ms: Date.now() + 60000 };
  else if (url.pathname === "/mcp") payload = { jsonrpc: "2.0", id: body?.id, result: body?.method === "tools/list" ? { tools: [] } : {} };
  else if (url.pathname.endsWith("/connections")) payload = { connections: [] };
  else if (body?.jsonrpc) {
    const results = { getAccountInfo: { context: { slot: 1 }, value: null }, getProgramAccounts: [], getBalance: { context: { slot: 1 }, value: 0 }, getTokenAccountsByOwner: { context: { slot: 1 }, value: [] }, getSlot: 100, getRecentPerformanceSamples: [{ slot: 100, numSlots: 10, numTransactions: 0, samplePeriodSecs: 4 }] };
    payload = { jsonrpc: "2.0", id: body.id, result: results[body.method] ?? null };
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
});
try {
  await page.goto(`${BASE_URL}/test/fixtures/owner-onboarding.html`);
  await page.getByRole("heading", { name: /Connect your wallet/ }).waitFor();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `overflow at ${width}px`);
    if (width === 768) await page.screenshot({ path: "/tmp/chainpay-onboarding-tablet.png", fullPage: true });
    const action = await page.getByRole("link", { name: /Get Phantom.*official/ }).boundingBox();
    assert.ok(action && action.y + action.height <= 900, `wallet action below fold at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "/tmp/chainpay-onboarding-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/chainpay-onboarding-mobile.png", fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".owner-entry-card").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.getByRole("button", { name: /Connect wallet/ }).count(), 0);
  assert.equal(await page.getByRole("link", { name: /Get Phantom.*official/ }).count(), 1);
  await page.getByRole("button", { name: "More wallets" }).click();
  assert.equal(await page.getByRole("link", { name: /Get MetaMask.*official/ }).count(), 1);
  await page.getByRole("button", { name: "Refresh wallets" }).click();
  assert.match(await page.getByRole("status").innerText(), /Still no wallet/);
  await page.evaluate(() => window.onboardingFixture.register());
  await page.getByRole("button", { name: /Fixture Wallet.*Connect wallet/ }).waitFor();
  await page.evaluate(() => window.onboardingFixture.state.unregister());
  await page.getByRole("button", { name: /Fixture Wallet/ }).waitFor({ state: "detached" });
  await page.evaluate(() => window.onboardingFixture.register());
  await page.getByRole("button", { name: /Fixture Wallet.*Connect wallet/ }).click();
  await page.getByRole("heading", { name: "Welcome to your workspace" }).waitFor();
  assert.equal(await page.evaluate(() => window.onboardingFixture.state.messages), 0);
  assert.equal(requests.filter(r => r.path.endsWith("/auth/challenge")).length, 0);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Fixture login canceled" }).waitFor();
  // Advance beyond the old 8s polling interval: cancellation must never cause another signature.
  await page.waitForTimeout(8500);
  assert.equal(await page.evaluate(() => window.onboardingFixture.state.messages), 1);
  await page.evaluate(() => { window.onboardingFixture.state.rejectLogin = false; });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Set your spending limits." }).waitFor();
  assert.equal(await page.evaluate(() => window.onboardingFixture.state.messages), 2);
  await page.getByRole("button", { name: "Review mandate", exact: true }).click();
  await page.getByRole("heading", { name: "How should payments be approved?" }).waitFor();
  assert.equal(await page.evaluate(() => window.onboardingFixture.state.transactions), 0);
  assert.equal(requests.some(r => /transactions\/submit|managed-signers\/provision|payments\/execute/.test(r.path)), false);
  assert.deepEqual(errors, []);
  console.log("PASS: official no-wallet links, late discovery/removal, connect without login, canceled login without polling retries, explicit retry and real permission form; zero financial signatures.");
} catch (error) { console.error("Fixture errors:", errors); console.error((await page.locator("body").innerText()).slice(0, 6000)); throw error; } finally { await browser.close(); }
