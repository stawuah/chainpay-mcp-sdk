import assert from 'node:assert/strict';
import { BASE_URL, blockExternal, launchBrowser } from './browser/_helpers.mjs';
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await blockExternal(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE_URL}/test/fixtures/dashboard-harness.html?tab=settings`);
    await page.locator('.owner-advanced-settings > summary').click();
    for (const destination of ['Developer tools', 'Protocol administration']) {
      await page.getByRole('button', { name: destination, exact: true }).click();
      await page.getByRole('button', { name: 'Back to settings', exact: true }).click();
      assert.equal(await page.locator('.owner-advanced-settings').evaluate(el => el.open), true);
    }
    assert.match(await page.locator('.owner-mcp-endpoint').innerText(), /\/mcp$/);
    await page.getByRole('button', { name: 'Copy MCP address' }).waitFor();
    await page.getByRole('button', { name: 'Connect agent', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back to settings', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/chainpay-advanced-settings-${width}.png`, fullPage: true });
    if (width === 1440) {
      const sidebar = page.locator('.dashboard-sidebar');
      const settings = await sidebar.getByRole('button', { name: 'Settings', exact: true }).boundingBox();
      const payments = await sidebar.getByRole('button', { name: 'Payments', exact: true }).boundingBox();
      assert.ok(settings.y - payments.y - payments.height < 40, 'no excessive navigation gap');
      await page.getByRole('button', { name: 'Collapse navigation' }).click();
      await sidebar.getByRole('button', { name: 'Back to site' }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Expand navigation' }).click();
      await page.setViewportSize({ width, height: 480 });
      await sidebar.getByRole('button', { name: 'Back to site' }).scrollIntoViewIfNeeded();
      const back = await sidebar.getByRole('button', { name: 'Back to site' }).boundingBox();
      assert.ok(back.y >= 0 && back.y + back.height <= 480, 'short viewport footer reachable');
    } else {
      await page.getByRole('button', { name: 'Open dashboard navigation' }).click();
      const drawer = page.getByTestId('dashboard-mobile-nav');
      await drawer.getByRole('button', { name: 'Payments', exact: true }).click();
      await page.getByRole('heading', { name: 'Payments', exact: true }).waitFor();
      await drawer.waitFor({ state: 'hidden' });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: advanced return paths, MCP entry, compact sidebar, collapsed footer, short viewport and mobile navigation.');
} finally { await browser.close(); }
