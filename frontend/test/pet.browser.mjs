// Site pet: bounds, panel behaviour, hide, and where he must not appear.
// Expects the app on http://127.0.0.1:5189 like the other browser tests.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:5189';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

async function open(path, { viewport = { width: 1280, height: 800 }, reducedMotion = 'no-preference', needs, firstVisit = false, bond } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://**/*', (r) => r.abort());
  await page.addInitScript(({ seed, firstVisit, bond }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('chainpay.pet.debug', '1');
    if (seed) localStorage.setItem('chainpay.pet.v1', JSON.stringify({ needs: seed, at: Date.now(), bornAt: Date.now(), lowPower: false, lastAction: {}, grumpyUntil: 0 }));
    // Returning visitor today, so he skips the boot-up and greeting.
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!firstVisit) localStorage.setItem('chainpay.pet.bond.v1', JSON.stringify({ lastVisitDay: today, streak: 1, visitDays: 1, xp: 0, ...bond }));
  }, { seed: needs ?? null, firstVisit, bond: bond ?? {} });
  await page.goto(BASE + path, { waitUntil: 'load' });
  return { page, context };
}

async function inViewport(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.cp-pet').getBoundingClientRect();
    const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
    return b.left >= 0 && b.top >= 0 && b.right <= w && b.bottom <= h;
  });
}

// 1. He loads after the page, roams, and never leaves the viewport.
{
  const { page, context } = await open('/');
  await page.locator('.cp-pet-body').waitFor({ timeout: 20000 });
  for (const [w, h] of [[1280, 800], [900, 600], [1600, 1000]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(2100);
    assert.ok(await inViewport(page), `robot left the viewport at ${w}x${h}`);
  }
  const b = await page.locator('.cp-pet-body').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(3000, 3000, { steps: 6 });
  await page.mouse.up();
  assert.ok(await inViewport(page), 'dragging past the corner pushed him off screen');
  await context.close();
}

// 2. Panel: opens beside him inside the viewport, suggests the lowest need,
//    Escape closes it and returns focus to him.
{
  const { page, context } = await open('/', { reducedMotion: 'reduce', needs: { battery: 30, joy: 62, clean: 85 } });
  const robot = page.getByRole('button', { name: 'ChainPay robot' });
  await robot.waitFor({ timeout: 20000 });
  await robot.click();
  const panel = page.getByRole('dialog', { name: '???' });
  await panel.waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cp-pet-panel', 'focus moves into the panel on open');
  const z = await page.evaluate(() => [getComputedStyle(document.querySelector('.cp-pet')).zIndex, getComputedStyle(document.querySelector('.cp-pet-panel')).zIndex]);
  assert.deepEqual(z, ['50', '51'], 'pet layers sit below app dialogs (60)');
  const box = await panel.boundingBox();
  assert.ok(box.x >= 16 && box.y >= 16 && box.x + box.width <= 1280 - 16 + 0.5 && box.y + box.height <= 800 - 16 + 0.5, JSON.stringify(box));
  assert.equal(await page.locator('.cp-pet-tile.is-suggested').count(), 1);
  assert.match(await page.locator('.cp-pet-tile.is-suggested').innerText(), /Charge/);
  await page.locator('.cp-pet-tile.is-suggested').click();
  await page.locator('.cp-pet-tile', { hasText: 'Charge' }).click({ force: true });
  assert.match(await page.locator('#cp-pet-line').innerText(), /still full\. back in 10m\./);
  assert.match(await page.locator('.cp-pet-tile', { hasText: 'Charge' }).innerText(), /Ready in 10m/);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.cp-pet-panel').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'ChainPay robot');
  // Outside press closes too.
  await robot.click();
  await panel.waitFor();
  await page.mouse.click(200, 400);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.cp-pet-panel').count(), 0);
  await context.close();
}

// 3. Phone: bottom sheet, robot stays visible.
{
  const { page, context } = await open('/', { viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' });
  const robot = page.getByRole('button', { name: 'ChainPay robot' });
  await robot.waitFor({ timeout: 20000 });
  await robot.click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.cp-pet-panel.is-sheet').count(), 1);
  assert.ok(await inViewport(page));
  await context.close();
}

// 4. Hide persists across reloads; the restore button brings him back.
{
  const { page, context } = await open('/', { reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'ChainPay robot' }).click({ timeout: 20000 });
  await page.getByRole('button', { name: 'Hide' }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Bring the robot back', 'focus lands on the restore button after Hide');
  await page.reload({ waitUntil: 'load' });
  const restore = page.getByRole('button', { name: 'Bring the robot back' });
  await restore.waitFor({ timeout: 20000 });
  assert.equal(await page.locator('.cp-pet').count(), 0);
  await restore.click();
  await page.locator('.cp-pet-body').waitFor({ timeout: 20000 });
  await context.close();
}

// 5. First visit: he boots up and says hello, without opening anything.
{
  const { page, context } = await open('/', { reducedMotion: 'reduce', firstVisit: true });
  await page.locator('.cp-pet.is-booting').waitFor({ timeout: 20000 });
  await page.locator('.cp-pet-speech', { hasText: "oh hi. i'm new here. no name yet." }).waitFor({ timeout: 8000 });
  assert.equal(await page.locator('.cp-pet-panel').count(), 0);
  await context.close();
}

// 6. Play: sweep a dust speck, answer a call, toss a coin, open the game, wear gear.
{
  const { page, context } = await open('/', { reducedMotion: 'reduce', bond: { xp: 18 } });
  const robot = page.getByRole('button', { name: /ChainPay robot/ });
  await robot.waitFor({ timeout: 20000 });
  await page.waitForFunction(() => window.__chainpayPet);

  await page.evaluate(() => window.__chainpayPet.spawnDust());
  await page.getByRole('button', { name: 'Sweep up the dust speck' }).click();
  await page.locator('.cp-pet-speech', { hasText: /got it|swept|visor/ }).waitFor();

  await page.evaluate(() => window.__chainpayPet.call());
  await page.getByRole('button', { name: 'ChainPay robot is calling you' }).click();
  assert.match(await page.locator('#cp-pet-line').innerText(), /you came|checking|thanks/);

  await page.getByRole('button', { name: 'Gear' }).click();
  const antenna = page.getByRole('button', { name: /Antenna/ });
  assert.equal(await antenna.getAttribute('aria-pressed'), 'true', 'crossing into Regular puts the antenna on automatically');
  await antenna.click();
  assert.equal(await antenna.getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Back' }).click();

  await page.locator('.cp-pet-tile', { hasText: 'Play' }).click();
  await page.getByRole('button', { name: 'Start' }).waitFor();
  assert.match(await page.locator('.cp-pet-game').innerText(), /No real USDC/);
  await page.getByRole('button', { name: 'Back' }).click();

  await page.getByRole('button', { name: 'Toss a coin' }).click();
  await page.mouse.click(400, 400);
  await page.locator('.cp-pet-speech', { hasText: /mine|caught|shiny|imaginary/ }).waitFor({ timeout: 5000 });
  assert.ok(await inViewport(page));

  // Dust and calls stay off the money pages.
  await page.goto(BASE + '/verify', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__chainpayPet);
  await page.evaluate(() => window.__chainpayPet.spawnDust());
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.cp-pet-speck').count(), 0, 'no specks on /verify');
  await context.close();
}

// 7. Pin: he stays where he was pinned, across reloads, until unpinned.
{
  const { page, context } = await open('/');
  const robot = page.getByRole('button', { name: /ChainPay robot/ });
  await robot.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await robot.click();
  await page.getByRole('button', { name: 'Pin here' }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);
  const pinned = await page.locator('.cp-pet').boundingBox();
  assert.equal(await page.locator('.cp-pet').getAttribute('data-mode'), 'pinned');
  await page.waitForTimeout(23000); // longer than his longest wander interval
  const later = await page.locator('.cp-pet').boundingBox();
  assert.ok(Math.abs(later.x - pinned.x) < 2 && Math.abs(later.y - pinned.y) < 2, 'a pinned robot does not wander');
  await page.reload({ waitUntil: 'load' });
  await page.locator('.cp-pet[data-mode="pinned"]').waitFor({ timeout: 20000 });
  await robot.click();
  await page.getByRole('button', { name: 'Unpin' }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('chainpay.pet.pin')), null);
  await context.close();
}

// 8. Tour: a line only ever shows for the section under the reading line.
{
  const LINES = { 'spend-limits': 'allowance part', 'payment-review': '4.50 USDC', receipts: 'receipts.', 'stay-in-control': 'pause or revoke', developers: 'devs:', faq: 'good questions' };
  const { page, context } = await open('/');
  await page.locator('.cp-pet-body').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  let said = 0;
  for (let step = 0; step < 10; step++) {
    await page.mouse.wheel(0, 640);
    for (let i = 0; i < (step % 3 === 0 ? 3 : 10); i++) {
      const s = await page.evaluate((LINES) => {
        const line = innerHeight * 0.45;
        let at = null;
        for (const id of Object.keys(LINES)) { const r = document.getElementById(id)?.getBoundingClientRect(); if (r && r.top <= line && r.bottom >= line) { at = id; break; } }
        const text = document.querySelector('.cp-pet-speech')?.textContent ?? '';
        return { at, shownFor: Object.keys(LINES).find((id) => text.includes(LINES[id])) ?? null };
      }, LINES);
      if (s.shownFor) said += 1;
      assert.ok(!s.shownFor || s.shownFor === s.at, `tour line for ${s.shownFor} shown while reading ${s.at}`);
      await page.waitForTimeout(250);
    }
  }
  assert.ok(said > 0, 'he commented on at least one section');
  await context.close();
}

// 9. Embeds live inside other people's pages: no robot.
{
  const { page, context } = await open('/embed/overview');
  await page.waitForTimeout(3000);
  assert.equal(await page.locator('.cp-pet, .cp-pet-return').count(), 0);
  await context.close();
}

assert.deepEqual(errors, []);
await browser.close();
console.log('pet browser checks passed');
