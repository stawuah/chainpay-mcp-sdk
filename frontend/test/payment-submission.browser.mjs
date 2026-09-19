import assert from "node:assert/strict";
import { BASE_URL, launchBrowser } from "./browser/_helpers.mjs";

const browser = await launchBrowser();
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [], submissions = [];
    let recover = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(BASE_URL).origin) return route.continue();
      let body;
      try { body = request.postDataJSON(); } catch {}
      let payload = {};
      if (url.pathname.endsWith("/auth/challenge")) payload = { challenge_id: "fixture", message: "Fixture login" };
      else if (url.pathname.endsWith("/auth/session")) payload = { token: "fixture-session", wallet: "11111111111111111111111111111111", expires_at_ms: Date.now() + 60_000 };
      else if (url.pathname === "/mcp") {
        if (body?.params?.name === "execute_payment") {
          submissions.push(body);
          payload = { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Fixture relay response was lost" } };
        } else payload = { jsonrpc: "2.0", id: body?.id, result: { content: [] } };
      } else if (url.pathname.includes("/v1/payments/")) {
        if (!recover) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Fixture not found" }) });
        payload = { status: "confirmed", payment_id: url.pathname.split("/").at(-1), signature: "fixture-finalized-signature", receipt_address: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1" };
      } else if (url.pathname.endsWith("/connections")) payload = { connections: [] };
      else if (url.pathname.endsWith("/inbox")) payload = { inbox: [] };
      else if (body?.jsonrpc) payload = { jsonrpc: "2.0", id: body.id, result: body.method === "getBalance" ? { context: { slot: 1 }, value: 0 } : [] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`${BASE_URL}/test/fixtures/payment-submission.html`);
    const prepare = page.getByRole("button", { name: "Prepare payment", exact: true });
    if (!await prepare.isVisible()) await page.getByRole("button", { name: /New payment/ }).click();
    await page.getByRole("textbox", { name: "Recipient wallet address", exact: true }).fill("11111111111111111111111111111111");
    await prepare.click();
    const approve = page.getByRole("button", { name: "Approve payment", exact: true });
    await approve.waitFor();
    await approve.focus();
    await page.keyboard.press("Enter");
    await page.locator(".builder-error").filter({ hasText: "Fixture relay response was lost" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Waiting for wallet…" }).count(), 0);
    assert.equal(await approve.isDisabled(), true);
    assert.equal(await prepare.isDisabled(), true);
    assert.equal(submissions.length, 1);
    assert.equal(await page.evaluate(() => window.submissionFixture.approvals), 1);
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("chainpay.pending-operations.v1"))[0]);
    assert.equal((await stored()).status, "unknown");
    assert.equal((await stored()).wire, "AA==");
    await page.getByRole("button", { name: "Check status", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Status unavailable (404)" }).waitFor();
    assert.equal((await stored()).status, "unknown", "404 must not clear uncertainty");
    await page.screenshot({ path: `/tmp/chainpay-payment-error-${width}.png`, fullPage: true });
    recover = true;
    await page.getByRole("button", { name: "Check status", exact: true }).click();
    await page.getByText("Payment confirmed on Devnet", { exact: true }).waitFor();
    assert.equal(await page.locator(".builder-error").count(), 0);
    assert.equal((await stored()).status, "confirmed");
    assert.equal((await stored()).wire, undefined);
    assert.equal(await page.evaluate(() => window.submissionFixture.approvals), 1);
    assert.equal(submissions.length, 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS: desktop/mobile payment error shown after fixture approval; keyboard approval; 404 retains original bytes; recovery restores receipt link without another approval or submission. No live services used.");
} finally { await browser.close(); }
