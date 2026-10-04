// Bam Bam's sign-in loader and his game world (council ruling
// bam-bam-loader-ruling-2026-10-04). Expects the app on http://127.0.0.1:5189.
import assert from "node:assert/strict";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const browser = await launchBrowser();
const errors = [];

async function open(path, { reducedMotion = "no-preference", viewport = { width: 1280, height: 800 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await blockExternal(page);
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "load" });
  return { page, context };
}
const loader = (opts) => open("/test/fixtures/bam-bam-loader.html", opts);
const set = (page, next) => page.evaluate((n) => window.loaderFixture.set(n), next);
const done = (page) => page.evaluate(() => window.loaderFixture.done);
const LOADER_WAIT = 1500;
const go = (page) => page.getByRole("button", { name: "Go to dashboard" });

// 1. Opens over the dashboard with the exit focused, real stages only, one Bam Bam.
{
  const { page, context } = await loader();
  const dialog = page.getByRole("dialog", { name: "Opening your dashboard" });
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "Go to dashboard");
  const steps = await page.locator(".cp-bbl-step").allInnerTexts();
  assert.deepEqual(steps, ["Checking Devnet setup", "Reading your spending permissions", "Checking what your agents can see"]);
  assert.equal(await page.locator(".cp-bbl-step.is-current").innerText(), "Checking Devnet setup");
  await set(page, { stage: "permissions" });
  await page.locator(".cp-bbl-step.is-done").first().waitFor();
  assert.equal(await page.locator(".cp-bbl-step.is-current").innerText(), "Reading your spending permissions");
  await page.waitForTimeout(2500);
  assert.equal(await page.locator(".cp-pet-toggle, .cp-pet").count(), 0, "toggle and roaming robot step aside");
  assert.equal(await page.locator(".cp-bbl-skeleton").evaluate((el) => getComputedStyle(el.firstElementChild).animationName), "none", "skeleton never pulses");
  await go(page).click();
  await page.waitForFunction(() => window.loaderFixture.done === 1);
  await page.waitForFunction(() => document.activeElement?.id === "dashboard", null, { timeout: 2000 });
  await page.locator(".cp-pet-toggle").waitFor({ timeout: 10000 });
  await context.close();
}

// 2. Data lands with no game: closes by itself, never before 900ms.
{
  const { page, context } = await loader();
  const t0 = Date.now();
  await set(page, { status: "ready", stage: null });
  await page.waitForFunction(() => window.loaderFixture.done === 1, null, { timeout: 5000 });
  assert.ok(Date.now() - t0 >= 900 - 100, "minimum visible time");
  await context.close();
}

// 3. Error with no game: closes at once so the dashboard's error card shows.
{
  const { page, context } = await loader();
  await page.waitForTimeout(100);
  await set(page, { status: "error", stage: null });
  await page.waitForFunction(() => window.loaderFixture.done === 1, null, { timeout: 1500 });
  await context.close();
}

// 4. Hard cap: still loading at 8s, it steps aside.
{
  const { page, context } = await loader();
  await page.waitForTimeout(7000);
  assert.equal(await done(page), 0);
  await page.waitForFunction(() => window.loaderFixture.done === 1, null, { timeout: 3000 });
  await context.close();
}

// 5. Once a game starts it waits for the user; Esc closes the game, then leaves.
{
  const { page, context } = await loader();
  await page.getByRole("button", { name: "Play while you wait" }).click();
  await page.locator(".cp-snake, .cp-ttt").first().waitFor();
  assert.equal(await page.getByRole("radiogroup", { name: /Game|Difficulty/ }).count(), 0, "Bam Bam picks; no menus");
  await set(page, { status: "ready", stage: null });
  await page.waitForTimeout(LOADER_WAIT);
  assert.equal(await done(page), 0, "never closes on its own once a game started");
  await page.locator(".cp-bbl-bar", { hasText: "Dashboard's ready" }).waitFor();
  assert.match(await go(page).getAttribute("class"), /is-primary/);
  await page.getByRole("button", { name: "Close game" }).focus();
  await page.keyboard.press("Escape");
  await page.locator(".cp-bbl-stack").waitFor();
  assert.equal(await done(page), 0, "first Esc only closes the game");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.loaderFixture.done === 1);
  await context.close();
}

// 6. Reduced motion: the flat robot drawing, no WebGL.
{
  const { page, context } = await loader({ reducedMotion: "reduce" });
  await page.locator(".cp-bbl-robot svg.cp-pet-still").waitFor({ timeout: 10000 });
  assert.equal(await page.locator(".cp-bbl-robot canvas").count(), 0);
  await context.close();
}

// 7. 390px: no horizontal scroll, exit full width.
{
  const { page, context } = await loader({ viewport: { width: 390, height: 844 } });
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
  const box = await go(page).boundingBox();
  assert.ok(box.width >= 300, "full-width exit on phones");
  await context.close();
}

// 8. Tic-tac-toe by keyboard: you play, Bam Bam answers in blue.
{
  const { page, context } = await open("/test/fixtures/bam-bam-world.html?game=ttt", { reducedMotion: "reduce" });
  const board = page.getByRole("grid", { name: "Tic-tac-toe board" });
  await board.waitFor();
  await page.getByRole("gridcell", { name: "Row 2, column 2, empty" }).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.getByRole("gridcell", { name: "Row 1, column 2, X" }).waitFor();
  await page.locator(".cp-ttt-cell .cp-ttt-piece.is-bam").first().waitFor({ timeout: 3000 });
  assert.equal(await page.locator(".cp-ttt-cell .cp-ttt-piece").count(), 2);
  await page.keyboard.press("9");
  await page.getByRole("gridcell", { name: /Row 3, column 3, (X|O)/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.worldFixture.closed === 1);
  await context.close();
}

// 9. Snake: starts, steers, pauses when the window loses focus.
{
  const { page, context } = await open("/test/fixtures/bam-bam-world.html?game=snake");
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForTimeout(1800);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".cp-snake-card").count(), 0, "running");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.getByText("Paused").waitFor();
  await page.getByRole("button", { name: "Resume" }).first().waitFor();
  await context.close();
}

// 10. Phones get the visor turn pad.
{
  const { page, context } = await open("/test/fixtures/bam-bam-world.html?game=snake", { viewport: { width: 390, height: 844 } });
  await page.getByRole("button", { name: "Turn left" }).waitFor();
  await page.getByRole("button", { name: "Turn right" }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
  await context.close();
}

assert.deepEqual(errors, []);
await browser.close();
console.log("PASS: loader stages, exits, timing, game hold, Esc levels, reduced motion, 390px; tic-tac-toe by keyboard; snake pause; visor pad.");
