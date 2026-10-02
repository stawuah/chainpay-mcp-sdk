import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser/_helpers.mjs";

// Own the server so both compile-time flag states are exercised in one command.
// The real dashboard/receipt loader render against inert fixture account reads.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browser = await launchBrowser();
try {
  for (const enabled of [false, true]) {
    const server = await createServer({
      root,
      define: { "import.meta.env.VITE_CHAINPAY_CROSSMINT": JSON.stringify(String(enabled)) },
      server: { host: "127.0.0.1", port: 0, open: false },
    });
    const context = await browser.newContext({ viewport: { width: enabled ? 390 : 1440, height: 1000 } });
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        // Also prevent local proxy routes from contacting real services.
        if (url.origin !== origin || /^\/(api|rpc)(\/|$)/.test(url.pathname)) return route.abort();
        return route.continue();
      });
      await page.goto(`${origin}/test/fixtures/dashboard-harness.html?tab=assistant&crossmint&crossmint-review`);
      const record = (title) => page.locator(".owner-request-record").filter({
        has: page.locator(".owner-request-summary strong", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
      });
      async function expand(title) {
        const row = record(title);
        const toggle = row.locator(".owner-request-summary");
        await toggle.focus();
        await page.keyboard.press("Enter");
        await row.locator(".purchase-card").waitFor();
        return row;
      }
      const matching = await expand("Mad Lads #1234");
      assert.equal(await matching.getByRole("button", { name: "Approve payment in wallet", exact: true }).count(), 1);
      assert.equal(await matching.getByRole("img", { name: "Crossmint", exact: true }).count(), enabled ? 1 : 0);
      for (const [title, detail] of [
        ["Mad Lads #1235", "Ask your agent for a new quote."],
        ["Mad Lads #1236", "Nothing was submitted."],
        ["Mad Lads #1234 (again)", "Nothing new was submitted."],
      ]) {
        const row = await expand(title);
        assert.equal(await row.locator(".owner-status").textContent(), "Blocked");
        assert.ok((await row.innerText()).includes(detail));
        assert.equal(await row.locator(".agent-approval-card").count(), 0, `${title}: flag=${enabled}`);
        assert.equal(await row.getByRole("button", { name: "Approve payment in wallet", exact: true }).count(), 0);
      }
      await page.getByRole("tab", { name: "Completed", exact: true }).click();
      for (const [title, label] of [
        ["Mad Lads #1230", "Crossmint reports order complete"],
        ["Mad Lads #1231", "Waiting for Crossmint"],
        ["Mad Lads #1229", "Crossmint reports a refund"],
      ]) {
        const row = await expand(title);
        const receipt = row.locator(".receipt-card");
        await receipt.waitFor();
        assert.equal(await receipt.getAttribute("data-paid"), "yes");
        assert.match(await receipt.locator(".receipt-card-amount").innerText(), /4\.500001 USDC\s+4500001 base units/);
        assert.equal(await receipt.locator('[data-stamp="allowed"] b').textContent(), "Allowed");
        assert.equal(await receipt.locator('[data-stamp="paid"] b').textContent(), "Paid");
        const seller = receipt.locator('[data-stamp="seller"]');
        assert.notEqual(await seller.getAttribute("data-tone"), "yes");
        if (enabled) {
          assert.equal(await seller.locator("b").textContent(), label);
          if (title === "Mad Lads #1230") assert.match(await seller.innerText(), /Reported by Crossmint at .+Not checked on Solana\./s);
          if (title === "Mad Lads #1229") assert.match(await seller.innerText(), /cannot confirm the refund reached your wallet/);
        } else {
          assert.doesNotMatch(await seller.innerText(), /Crossmint/);
        }
        assert.equal(await receipt.locator('a[href="/verify/2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1"]').count(), 1);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS: Crossmint flag=${enabled}; actual approval guard and receipt forwarding; keyboard expansion; ${enabled ? "390px" : "1440px"}.`);
    } finally {
      await context.close();
      await server.close();
    }
  }
} finally {
  await browser.close();
}
