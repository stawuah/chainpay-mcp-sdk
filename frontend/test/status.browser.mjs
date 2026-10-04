import assert from "node:assert/strict";
import { BASE_URL, launchBrowser } from "./browser/_helpers.mjs";

// /status against a mocked /status/v1 feed. All other external requests are blocked.
const SHOTS = process.env.CHAINPAY_STATUS_SHOTS || "/tmp/chainpay-status";
const DAY = 86_400_000;
const IDS = ["web", "relay", "mcp", "solana", "program"];
const dayKey = (at) => new Date(at).toISOString().slice(0, 10);
function feed({ at, gapDaysAgo = null }) {
  const now = Date.now();
  const days = Array.from({ length: 90 }, (_, i) => {
    const total = i === 0 ? Math.max(1, Math.floor((now % DAY) / 300_000)) : i === gapDaysAgo ? 3 : 288;
    return { day: dayKey(now - i * DAY), total, up: total, degraded: 0, down: 0 };
  });
  return { generatedAt: now, incidents: [], components: IDS.map((id) => ({ id, state: "up", at, latencyMs: 120, days })) };
}

const browser = await launchBrowser();
const errors = [];

async function open(context, body) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://**/*", (route) => route.request().url().endsWith("/status/v1")
    ? route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    : route.abort());
  await page.goto(`${BASE_URL}/status`);
  await page.waitForFunction(() => /operational|unknown|outage|slow/i.test(document.querySelector(".status-banner h2")?.textContent ?? ""));
  return page;
}
const rows = (page) => page.$$eval(".status-current", (els) => els.map((el) => el.textContent.trim()));
const tooltipBox = (page) => page.evaluate(() => {
  const el = document.querySelector(".status-tooltip");
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return { left: box.left, right: box.right, text: el.textContent };
});

// Desktop: stale data is unknown on every row; hover shows and mouse-leave hides the tooltip.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page = await open(context, feed({ at: Date.now() - 3 * DAY }));
  assert.equal(await page.textContent(".status-banner h2"), "Status unknown");
  assert.deepEqual(await rows(page), Array(5).fill("Unknown"), "stale rows must not read Operational");
  await page.screenshot({ path: `${SHOTS}-stale-1440.png`, fullPage: true });
  await page.close();

  page = await open(context, feed({ at: Date.now() - 60_000, gapDaysAgo: 3 }));
  assert.equal(await page.textContent(".status-banner h2"), "All systems operational");
  assert.deepEqual(await rows(page), Array(5).fill("Operational"));
  const bars = page.locator(".status-row").first().locator(".status-bars .status-bar");
  assert.equal(await bars.count(), 90);
  assert.match(await bars.nth(86).getAttribute("class"), /status-bar-gaps/);
  await bars.nth(86).hover();
  const tip = await tooltipBox(page);
  assert.ok(tip, "hover shows the tooltip");
  assert.match(tip.text, /Partial data/);
  assert.match(tip.text, /3 of 288 checks ran/);
  await page.screenshot({ path: `${SHOTS}-gaps-1440.png` });
  await page.mouse.move(5, 5);
  assert.equal(await tooltipBox(page), null, "mouse leave hides the tooltip");
  await page.close();
  await context.close();
}

// Phones: a tap keeps the tooltip open, edge tooltips stay on-screen, and a tap elsewhere closes it.
for (const width of [390, 320]) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  const page = await open(context, feed({ at: Date.now() - 60_000 }));
  const bars = page.locator(".status-row").first().locator(".status-bars .status-bar");
  const count = await bars.count();
  assert.equal(count, 30);
  for (const index of [0, Math.floor(count / 2), count - 1]) {
    await bars.nth(index).tap();
    await page.waitForTimeout(100);
    const tip = await tooltipBox(page);
    assert.ok(tip, `${width}px: tooltip stays after tapping bar ${index}`);
    assert.ok(tip.left >= 0 && tip.right <= width, `${width}px bar ${index}: tooltip ${Math.round(tip.left)}–${Math.round(tip.right)} inside the viewport`);
    assert.match(await bars.nth(index).getAttribute("class"), /is-active/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${width}px: no horizontal scroll (overflow ${overflow})`);
    await page.screenshot({ path: `${SHOTS}-tap-${width}-bar${index}.png` });
  }
  await page.locator(".status-title-row h1").tap();
  await page.waitForTimeout(100);
  assert.equal(await tooltipBox(page), null, `${width}px: a tap elsewhere closes the tooltip`);
  await page.close();
  await context.close();
}

await browser.close();
assert.deepEqual(errors, []);
console.log("PASS: /status stale rows read Unknown, partial-data days are not green, tap tooltips persist and stay on-screen at 390/320px, outside tap closes, no horizontal scroll.");
