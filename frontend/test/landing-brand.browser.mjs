// Landing brand pass: hero motion lane playback rules, the use-case strip, and
// the PayPal use case. Ruling: _bmad-output/design-council/landing-brand-ruling-2026-10-04.md
// Expects the app on http://127.0.0.1:5189 like the other browser tests.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';

const BASE = process.env.CHAINPAY_BASE || 'http://127.0.0.1:5189';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

async function open(path, { viewport = { width: 1440, height: 900 }, reducedMotion = 'no-preference', pet = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const clipRequests = [];
  page.on('request', (r) => { if (r.url().includes('hero-boundary.mp4')) clipRequests.push(r.url()); });
  await page.route('https://**/*', (r) => r.abort());
  if (!pet) await page.addInitScript(() => localStorage.setItem('chainpay.pet.hidden', '1'));
  await page.goto(BASE + path, { waitUntil: 'load' });
  return { page, context, clipRequests };
}

const playing = (page) => page.evaluate(() => { const v = document.querySelector('.hero-lane video'); return Boolean(v && !v.paused && v.currentTime > 0); });
const paused = (page) => page.evaluate(() => document.querySelector('.hero-lane video')?.paused ?? true);
async function expectWithin(page, check, label, ms = 250) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check(page)) return; await page.waitForTimeout(25); }
  assert.ok(await check(page), label);
}
// Plays the pet's side of the contract exactly as src/pet-presence.ts does: markers in the DOM plus the event.
const petState = (page, speaking, perchSelector) => page.evaluate(({ speaking, perchSelector }) => {
  const perch = perchSelector ? document.querySelector(perchSelector) : null;
  document.documentElement.toggleAttribute('data-pet-speaking', speaking);
  document.querySelectorAll('[data-pet-perched]').forEach((e) => e.removeAttribute('data-pet-perched'));
  perch?.setAttribute('data-pet-perched', '');
  window.dispatchEvent(new CustomEvent('chainpay:pet-state', { detail: { speaking, perch } }));
}, { speaking, perchSelector });

// 1. B12: it plays, and pauses within 250ms for every blocking condition; it resumes only when all clear.
{
  const { page, context, clipRequests } = await open('/');
  // The landing renders once as a fallback and again inside the wallet controller; settle first.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => { const v = document.querySelector('.hero-lane video'); return v && !v.paused && v.currentTime > 0; }, null, { timeout: 15000 });
  assert.equal(clipRequests.length > 0, true);
  const button = page.getByRole('button', { name: 'Pause motion' });
  assert.equal(await button.getAttribute('aria-pressed'), null, 'the label is the state; no aria-pressed');
  assert.ok((await button.boundingBox()).height >= 44);

  await petState(page, true, null);
  await expectWithin(page, paused, 'pauses while the pet is speaking');
  await petState(page, false, '#landing-hero-heading');
  await page.waitForTimeout(300);
  assert.ok(await paused(page), 'stays paused while the pet sits on the hero heading');
  await petState(page, false, '#landing-dev-heading');
  await expectWithin(page, playing, 'a perch outside the hero does not block it', 1500);

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expectWithin(page, paused, 'pauses on a hidden tab');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expectWithin(page, playing, 'resumes when the tab is visible again', 1500);

  await page.evaluate(() => window.scrollTo(0, 2400));
  await expectWithin(page, paused, 'pauses offscreen', 1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectWithin(page, playing, 'resumes back on screen', 1500);

  // A manual pause wins over every condition clearing, and lasts for the session.
  await button.click();
  await expectWithin(page, paused, 'manual pause');
  await page.getByRole('button', { name: 'Play motion' }).waitFor();
  await petState(page, true, null);
  await petState(page, false, null);
  await page.evaluate(() => window.scrollTo(0, 2400));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  assert.ok(await paused(page), 'a manual pause is never overridden');
  await page.reload({ waitUntil: 'load' });
  await page.getByRole('button', { name: 'Play motion' }).waitFor();
  await page.waitForTimeout(800);
  assert.ok(await paused(page), 'the manual pause lasts for the session');
  await page.getByRole('button', { name: 'Play motion' }).click();
  await expectWithin(page, playing, 'play resumes on request', 3000);
  await context.close();
}

// 2. Reduced motion: poster only, the clip is never requested until asked for.
{
  const { page, context, clipRequests } = await open('/', { reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Play motion' }).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(clipRequests.length, 0, 'reduced motion never downloads the clip');
  assert.equal(await page.locator('.hero-lane video').getAttribute('poster'), '/landing/hero-boundary-poster.webp');
  await page.getByRole('button', { name: 'Play motion' }).click();
  await expectWithin(page, playing, 'pressing Play plays it', 5000);
  await context.close();
}

// 3. The real pet, first visit: the clip stays on its poster through his whole hello, then plays.
{
  const { page, context } = await open('/', { pet: true });
  await page.locator('.cp-pet-speech').waitFor({ timeout: 20000 });
  const html = await page.evaluate(() => ['data-pet-speaking', 'data-pet-greeting', 'data-pet-ready'].map((a) => document.documentElement.hasAttribute(a)));
  assert.deepEqual(html, [true, true, true]);
  for (let i = 0; i < 12; i++) {
    const t = await page.evaluate(() => document.querySelector('.hero-lane video').currentTime);
    if (!(await page.evaluate(() => document.documentElement.hasAttribute('data-pet-greeting')))) break;
    assert.equal(t, 0, 'the clip has not started while he says hello');
    await page.waitForTimeout(500);
  }
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-pet-greeting'), null, { timeout: 15000 });
  // After the hello it plays, unless he is (legitimately) talking or sitting on the hero heading again.
  const after = await page.waitForFunction(() => {
    const v = document.querySelector('.hero-lane video');
    if (!v.paused && v.currentTime > 0) return 'playing';
    if (document.documentElement.hasAttribute('data-pet-speaking')) return 'speaking';
    if (document.querySelector('.landing-hero [data-pet-perched]')) return 'perched';
    return false;
  }, null, { timeout: 15000 });
  assert.ok(['playing', 'speaking', 'perched'].includes(await after.jsonValue()));
  await context.close();
}

// 4. The strip: four tiles, only PayPal is "soon", links resolve, no motion, and the hero lost its slip.
{
  const { page, context } = await open('/');
  assert.equal(await page.locator('.hero-payment-slip').count(), 0);
  const strip = page.locator('#what-agents-pay-for');
  await strip.getByRole('heading', { name: 'What will your agent pay for?' }).waitFor();
  const tiles = strip.locator('.landing-use');
  assert.deepEqual(await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('href'))), [
    '/use-cases/pay-per-api-call', '/use-cases/one-tap-stop', '/use-cases/receipts-for-accounting', '/use-cases/paypal-invoices',
  ]);
  assert.deepEqual(await tiles.evaluateAll((els) => els.map((e) => e.querySelector('.landing-next-status')?.textContent ?? null)), [null, null, null, 'Coming soon']);
  assert.equal(await strip.getByRole('link', { name: 'See all use cases' }).count(), 1, 'exactly one visible "See all" link');
  const order = await page.evaluate(() => ['#how-it-works', '#what-agents-pay-for', '.landing-next', '#developers'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'story, strip, teaser, developers');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll at 390');
  assert.equal(await strip.getByRole('link', { name: 'See all use cases' }).count(), 1);
  await context.close();
}

// 5. PayPal use case: honest "not built yet" copy, and the 17-card grid closes its last row.
{
  const { page, context } = await open('/use-cases/paypal-invoices');
  await page.getByRole('heading', { level: 1, name: 'PayPal invoices, paid on Solana' }).waitFor();
  const text = await page.locator('main').innerText();
  assert.match(text, /Coming soon\. Not built yet\./);
  assert.doesNotMatch(text, /built and waiting/i);
  assert.match(text, /No money goes through PayPal/);
  await page.goto(BASE + '/use-cases', { waitUntil: 'load' });
  const cards = page.locator('.uc-grid > .uc-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 17);
  const [last, prev] = await page.evaluate(() => { const c = [...document.querySelectorAll('.uc-grid > .uc-card')]; return [c.at(-1), c.at(-2)].map((e) => e.getBoundingClientRect()); });
  assert.ok(Math.abs(last.top - prev.top) < 2 && last.width > prev.width * 1.8, 'the last row closes: the final card spans two columns');
  await context.close();
}

assert.deepEqual(errors, []);
await browser.close();
console.log('PASS: hero lane B12 rules (pet, hidden tab, offscreen, manual pause, session), reduced motion poster only, strip tiles and order, PayPal soon copy, 17-card grid closes.');
