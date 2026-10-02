// Permission requests in the dashboard harness: the request card in Requests,
// the builder prefilled from it (budget request: the requester's agent signs),
// review differences, the link retry, Order match on a receipt, and the
// mandate Statement. No wallet, no backend, external requests blocked. The
// harness cannot sign or send a transaction. Fixture keys are deterministic;
// none of this is payment evidence.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const SHOTS = process.env.CHAINPAY_SHOTS_DIR || "/tmp";
await mkdir(SHOTS, { recursive: true });
const fixture = JSON.parse(await readFile(new URL("./fixtures/mandate-request.json", import.meta.url), "utf8"));
const harness = (query) => `${BASE_URL}/test/fixtures/dashboard-harness.html?${query}`;

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);

async function noOverflow(label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: no horizontal scroll (overflow ${overflow})`);
}

async function shoot(name, width) {
  await page.screenshot({ path: `${SHOTS}/pr4-${name}-${width}.png`, fullPage: true });
}

try {
  // 1. A purchase order link lands in Requests, expanded under Needs attention.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(harness("tab=assistant&permission=vendor"));
    const card = page.locator(".permission-request-card");
    await card.waitFor();
    const text = await card.innerText();
    assert.match(text, /PERMISSION REQUEST/i);
    assert.match(text, /Acme Data asks for a spending permission/);
    assert.match(text, /Purchase order PO-1042/);
    assert.match(text, /Not verified/);
    assert.match(text, /Signature valid/);
    assert.match(text, new RegExp(fixture.vendor.request.payload.requester));
    assert.match(text, /Suggested per payment\s+5 USDC/);
    assert.match(text, /Suggested total\s+50 USDC/);
    assert.match(text, /Expiry\s+≈ 30 days/);
    assert.match(text, /Expected payee/);
    assert.equal(await page.getByRole("tab", { name: "Needs attention", selected: true }).count(), 1);
    assert.equal(page.url().includes("#req="), true, "the link fragment stays in the URL");
    await noOverflow(`request card ${width}`);
    await shoot("request-card", width);
  }

  // Opening the same link again keeps one item.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(harness("tab=assistant&permission=vendor"));
  await page.locator(".permission-request-card").waitFor();
  assert.equal(await page.locator(".owner-request-record").filter({ hasText: "Acme Data asks for a spending permission" }).count(), 1);

  // Decline archives it locally.
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.getByRole("tab", { name: "Archived", exact: true }).click();
  await page.locator(".owner-request-record").filter({ hasText: "Acme Data" }).locator(".owner-request-summary").click();
  await page.getByText("Declined. Nothing was sent to the requester.").waitFor();

  // 2. A tampered link is blocked with its reason and no Review button.
  await page.goto(harness("tab=assistant&permission=tampered"));
  const blocked = page.locator(".permission-request-card[data-state=blocked]");
  await blocked.waitFor();
  assert.match(await blocked.innerText(), /Mandate request signature is invalid/);
  assert.equal(await blocked.getByRole("button", { name: "Review permission" }).count(), 0);
  await page.goto(harness("tab=assistant&permission=expired"));
  await page.locator(".permission-request-card[data-state=blocked]").filter({ hasText: "This request link has expired" }).waitFor();

  // 3. Budget request: Review permission opens the builder with the
  // requester's agent fixed and the limits prefilled.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(harness("tab=assistant&permission=grantee&ready&link=fail"));
    await page.locator(".permission-request-card").filter({ hasText: "Budget request" }).waitFor();
    assert.match(await page.locator(".permission-request-card").innerText(), /Agent that will sign/);
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    await page.getByRole("heading", { name: "How should payments be approved?" }).waitFor();
    const requester = page.getByRole("radio", { name: /Requester’s agent signs/ });
    assert.equal(await requester.isChecked(), true, "requester's agent preselected");
    assert.equal(await page.getByRole("radio", { name: /Approve each payment/ }).isDisabled(), true);
    assert.equal(await page.getByRole("radio", { name: /Automatic payments/ }).isDisabled(), true);
    await page.getByRole("button", { name: "Set spending limits" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Max per payment", exact: true }).inputValue(), "25");
    assert.equal(await page.getByRole("textbox", { name: "Total spend limit", exact: true }).inputValue(), "25");
    assert.ok(await page.getByText("Requested: 25 USDC").count() >= 2);
    await page.getByRole("textbox", { name: "Max per payment", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "Total spend limit", exact: true }).fill("30");
    await page.getByText("Above requested").waitFor();
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    await page.getByRole("button", { name: "Approve spending permission", exact: true }).waitFor();
    const summary = await page.locator(".mandate-summary").innerText();
    assert.match(summary, /From request\s+Hackathon API credits · /);
    assert.match(summary, /Requester’s agent signs/);
    assert.match(summary, /10 USDC \(requested 25 USDC\)/);
    assert.match(summary, /30 USDC \(requested 25 USDC\)/);
    assert.equal(summary.includes("Expected payee"), false, "a budget request has no payee");
    assert.match(summary, new RegExp(fixture.grantee.agent.slice(0, 4)));
    await noOverflow(`builder review ${width}`);
    await shoot("builder-review-grantee", width);
  }

  // Purchase order review: expected payee with its honest helper.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(harness("tab=assistant&permission=vendor&ready"));
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    await page.getByRole("radio", { name: /Approve each payment/ }).waitFor();
    assert.equal(await page.getByRole("radio", { name: /Requester’s agent signs/ }).count(), 0, "no third option for a purchase order");
    await page.getByRole("button", { name: "Set spending limits" }).click();
    await page.getByRole("textbox", { name: "Max per payment", exact: true }).fill("4");
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    await page.getByRole("button", { name: "Approve spending permission", exact: true }).waitFor();
    const summary = await page.locator(".mandate-summary").innerText();
    assert.match(summary, /From request\s+PO-1042 · /);
    assert.match(summary, /4 USDC \(requested 5 USDC\)/);
    assert.match(summary, /Total spend limit\s+50 USDC\n/, "an unchanged value carries no (requested …)");
    assert.match(summary, new RegExp(`Expected payee\\s+${fixture.vendor.request.payload.recipient}`));
    assert.match(summary, /Payments to anyone else are flagged on the receipt, not blocked by Solana\./);
    await noOverflow(`vendor review ${width}`);
    await shoot("builder-review", width);
  }

  // Real post-wallet continuation with invalid fixture wire bytes intercepted
  // entirely in memory: one approval, one submission, retry only the link.
  for (const failFirst of [false, true]) {
    await page.goto(harness(`tab=assistant&permission=vendor&ready&fixture-approval${failFirst ? "&link=fail" : ""}`));
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    await page.getByRole("button", { name: "Set spending limits" }).click();
    await page.getByRole("button", { name: "Review permission", exact: true }).click();
    await page.getByRole("button", { name: "Approve spending permission", exact: true }).click();
    if (failFirst) {
      await page.locator(".mandate-link-status").filter({ hasText: "Linking it to PO-1042 failed" }).waitFor();
      await page.getByRole("button", { name: "Retry link", exact: true }).click();
    }
    await page.locator(".mandate-created-heading").filter({ hasText: "Permission created · linked to PO-1042" }).waitFor();
    const evidence = await page.evaluate(() => window.permissionApprovalEvidence);
    assert.equal(evidence.signatures, 1);
    assert.equal(evidence.submissions, 1);
    assert.equal(evidence.links, failFirst ? 2 : 1);
    const inbox = await page.evaluate(() => JSON.parse(localStorage.getItem("chainpay.ai-inbox.v1:7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q") || "[]"));
    const item = inbox.find((entry) => entry.permissionRequest?.requestHash === fixture.vendor.requestHash);
    assert.equal(item.permissionRequest.link, "linked");
    assert.ok(item.permissionRequest.mandateAddress);
    // Clear this fixture's accepted request so the next scenario reviews anew.
    await page.evaluate(() => { localStorage.clear(); });
  }

  // Expiry between preview and approval never reaches the fixture wallet.
  await page.goto(harness("tab=assistant&permission=vendor&ready&fixture-approval"));
  await page.getByRole("button", { name: "Review permission", exact: true }).click();
  await page.getByRole("button", { name: "Set spending limits" }).click();
  await page.getByRole("button", { name: "Review permission", exact: true }).click();
  await page.evaluate((slot) => { window.permissionApprovalEvidence.slot = slot; }, fixture.vendor.request.payload.validUntilSlot);
  await page.getByRole("button", { name: "Approve spending permission", exact: true }).click();
  await page.locator(".builder-error").filter({ hasText: "This request link has expired" }).waitFor();
  assert.equal(await page.evaluate(() => window.permissionApprovalEvidence.signatures), 0);
  assert.equal(await page.evaluate(() => window.permissionApprovalEvidence.submissions), 0);

  // 4. Receipt with the Matched pill, owner view.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(harness("tab=receipts&receipts&orders"));
    await page.locator('button[aria-label="Preview USDC receipt 4RcptMatchedPurchaseFixture11111111111111"]').click();
    const card = page.locator(".receipt-preview-card .receipt-card");
    await card.locator('[data-pill="Matched"]').waitFor();
    const text = await card.innerText();
    assert.match(text, /Purchase order PO-1042 from Acme Data \(name not verified\)/);
    assert.match(text, /Invoice signed by seller/);
    assert.match(text, /Paid to the order’s payee/);
    assert.match(text, /Matched is a check by ChainPay/);
    assert.equal(await card.locator("[data-stamp]").count(), 3, "no fourth stamp");
    await noOverflow(`receipt ${width}`);
    await card.scrollIntoViewIfNeeded();
    await shoot("receipt-matched", width);
  }

  // Share with details carries the invoice and the order; /verify needs both to show the order.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  await page.addInitScript(() => { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); });
  await page.goto(harness("tab=receipts&receipts&orders"));
  await page.locator('button[aria-label="Preview USDC receipt 4RcptMatchedPurchaseFixture11111111111111"]').click();
  const shareCard = page.locator(".receipt-preview-card .receipt-card");
  await shareCard.locator('[data-pill="Matched"]').waitFor();
  await shareCard.getByRole("button", { name: /Share with details/ }).click();
  await page.getByText("Receipt link with invoice details copied.").waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /\/verify\/4RcptMatchedPurchaseFixture1+#purchase=[A-Za-z0-9_-]+&order=[A-Za-z0-9_-]+$/);
  const orderPart = copied.split("&order=")[1];
  assert.deepEqual(JSON.parse(Buffer.from(orderPart, "base64url").toString("utf8")), fixture.vendor.request);

  // CSV carries PO number and Order match.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  const csv = await readFile(await download.path(), "utf8");
  const lines = csv.trimEnd().split("\r\n");
  assert.match(lines[0], /,PO number,Order match$/);
  assert.ok(lines.some((line) => line.includes("4RcptMatchedPurchaseFixture") && line.endsWith(",PO-1042,Matched")));

  // 5. Statement in the mandate drawer, for the budget request's permission.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(harness("tab=mandates&receipts&orders"));
    await page.getByRole("row", { name: /Inspect spending permission MdT2/ }).click();
    const statement = page.locator(".mandate-statement");
    await statement.locator('[data-pill="Matched"]').waitFor();
    const text = await statement.innerText();
    assert.match(text, /Statement/);
    assert.match(text, /Budget 100 USDC · Spent 8\.25 USDC · Left 91\.75 USDC · 3 payments · expires at slot 400000000/);
    assert.match(text, /2 USDC/);
    await statement.scrollIntoViewIfNeeded();
    await noOverflow(`statement ${width}`);
    await shoot("statement", width);
  }
  const [statementCsv] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".mandate-statement").getByRole("button", { name: "Download CSV" }).click(),
  ]);
  assert.match(statementCsv.suggestedFilename(), /^chainpay-statement-MdT2bbbb-\d{4}-\d{2}-\d{2}\.csv$/);
  const statementLines = (await readFile(await statementCsv.path(), "utf8")).trimEnd().split("\r\n");
  assert.equal(statementLines.length, 2, "only this permission's receipt");
  assert.ok(statementLines[1].endsWith(",,Matched"));

  // 6. Creating from a request: a failed link keeps the permission and offers Retry link.
  // (The harness has no wallet signer, so the approval itself is not exercised here.)

  assert.deepEqual(errors, []);
  console.log(`PASS: permission request card, prefilled builder, Order match, audit link with order, CSV columns, statement. Screenshots in ${SHOTS}.`);
} finally {
  await browser.close();
}
