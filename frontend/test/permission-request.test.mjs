// Permission requests (purchase orders and budget requests): link checks,
// the Requests inbox, builder prefill, review rows, linking, Order match,
// the audit link with an order, and the CSV columns.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, unlink } from "node:fs/promises";
import ts from "typescript";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");
const fixture = JSON.parse(await readFile(new URL("./fixtures/mandate-request.json", import.meta.url), "utf8"));

async function loadBundle(entry, name) {
  const outfile = join(frontendRoot, `test/.tmp-${name}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    loader: { ".css": "empty" },
    external: ["@chainpay/sdk", "react", "react-dom", "react/jsx-runtime"],
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

async function loadTs(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const requests = await loadBundle("src/requests/permissionRequest.ts", "permission-request");
const order = await loadBundle("src/receipts/order.ts", "receipt-order");
const purchase = await loadBundle("src/receipts/purchase.ts", "receipt-purchase-pr4");
const exporter = await loadBundle("src/receipts/export.ts", "receipt-export-pr4");
const model = await loadTs("../src/receipts/model.ts");
const paths = await loadTs("../src/routing/paths.ts");

const SLOT = BigInt(fixture.currentSlot);
const USDC = fixture.vendor.request.payload.mint;
const symbol = () => "USDC";

// --- Route -------------------------------------------------------------------

test("/app/requests/permission is a Requests route that keeps its own path", () => {
  const route = paths.parsePathname("/app/requests/permission");
  assert.deepEqual(route, { kind: "app", tab: "assistant", permissionRequest: true });
  assert.equal(paths.buildPath(route), "/app/requests/permission");
  assert.equal(paths.pathsDiffer("/app/requests/permission", route), false, "the router never rewrites the path, so the #req fragment stays");
  assert.equal(paths.buildPath({ kind: "app", tab: "assistant" }), "/app/requests");
});

// --- Link checks -------------------------------------------------------------

test("a valid link verifies, with the expiry checked against the current slot", async () => {
  assert.equal(requests.requestFragmentFromHash(`#req=${fixture.vendor.fragment}`), fixture.vendor.fragment);
  assert.equal(requests.requestFragmentFromHash("#other=1"), null);
  const check = await requests.checkPermissionRequestLink(fixture.vendor.fragment, SLOT);
  assert.equal(check.status, "valid");
  assert.equal(check.requestHash, fixture.vendor.requestHash);
  assert.equal(check.checkedAtSlot, fixture.currentSlot);
  assert.deepEqual(check.signed, fixture.vendor.request);
});

test("request acceptance fails closed when the expiry slot cannot be checked", async () => {
  const expired = await requests.checkPermissionRequestLink(fixture.expired.fragment, SLOT);
  assert.equal(expired.status, "invalid");
  assert.equal(expired.reason, "This request link has expired");
  const unchecked = await requests.checkPermissionRequestLink(fixture.expired.fragment, null);
  assert.equal(unchecked.status, "invalid");
  assert.match(unchecked.reason, /expiry could not be checked/);
  assert.equal(unchecked.checkedAtSlot, undefined, "the card says the expiry was not checked");
});

test("a tampered link is blocked and reveals none of its terms", async () => {
  const check = await requests.checkPermissionRequestLink(fixture.tampered.fragment, SLOT);
  assert.equal(check.status, "invalid");
  assert.equal(check.reason, "Mandate request signature is invalid");
  const item = requests.permissionRequestInboxItem(check);
  assert.equal(item.stage, "blocked");
  assert.equal(item.permissionRequest.signed, undefined);
  assert.equal(JSON.stringify(item).includes("500000000"), false);
  const view = requests.permissionRequestCard(item.permissionRequest, symbol);
  assert.equal(view.status, "invalid");
  assert.equal(view.rows, undefined);
});

test("a damaged link gets one stable blocked item", async () => {
  const first = await requests.checkPermissionRequestLink("not-a-request", SLOT);
  const second = await requests.checkPermissionRequestLink("not-a-request", SLOT);
  assert.equal(first.status, "invalid");
  assert.equal(first.reason, "This mandate request link is damaged");
  assert.equal(first.requestHash, second.requestHash);
  assert.match(first.requestHash, /^link-[0-9a-f]{64}$/);
});

// --- Inbox -------------------------------------------------------------------

test("opening the same request twice keeps one Needs attention item", async () => {
  const check = await requests.checkPermissionRequestLink(fixture.vendor.fragment, SLOT);
  const item = requests.permissionRequestInboxItem(check, new Date("2026-10-02T10:00:00Z"));
  assert.equal(item.source, "permission-request");
  assert.equal(item.stage, "waiting_for_approval");
  assert.equal(item.title, "Acme Data asks for a spending permission");
  const other = { id: "msg-1", createdAt: "x", source: "message", title: "t", prompt: "p", response: "r", stage: "received", toolCalls: [], attachments: [] };
  let inbox = requests.upsertPermissionRequest([other], item);
  inbox = requests.upsertPermissionRequest(inbox, requests.permissionRequestInboxItem(check));
  assert.equal(inbox.filter((entry) => entry.source === "permission-request").length, 1);
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].id, item.id);
});

test("decline archives locally; reopening the link brings it back; a created request stays put", async () => {
  const check = await requests.checkPermissionRequestLink(fixture.vendor.fragment, SLOT);
  const item = requests.permissionRequestInboxItem(check);
  let inbox = requests.declinePermissionRequest([item], item.id);
  assert.ok(inbox[0].archivedAt);
  inbox = requests.upsertPermissionRequest(inbox, requests.permissionRequestInboxItem(check));
  assert.equal(inbox[0].archivedAt, undefined);
  inbox = requests.completePermissionRequest(inbox, check.requestHash, "Mandate111", "linked");
  assert.equal(inbox[0].stage, "approved");
  assert.equal(inbox[0].response, "Permission created · linked to PO-1042");
  const again = requests.upsertPermissionRequest(inbox, requests.permissionRequestInboxItem(check));
  assert.equal(again, inbox, "a request that became a permission is not reopened");
});

// --- Card --------------------------------------------------------------------

test("a purchase order card shows the stated name as not verified, the key, and the terms in token units", async () => {
  const check = await requests.checkPermissionRequestLink(fixture.vendor.fragment, SLOT);
  const view = requests.permissionRequestCard(requests.permissionRequestInboxItem(check).permissionRequest, symbol);
  assert.equal(view.kicker, "PERMISSION REQUEST");
  assert.equal(view.title, "Acme Data asks for a spending permission");
  assert.equal(view.roleLabel, "Purchase order PO-1042");
  assert.equal(view.statedName, "Acme Data");
  assert.equal(view.requester, fixture.vendor.request.payload.requester);
  assert.deepEqual(view.rows.map((row) => [row.label, row.value]), [
    ["Token", "USDC"],
    ["Suggested per payment", "5 USDC"],
    ["Suggested total", "50 USDC"],
    ["Expiry", "≈ 30 days"],
    ["Expected payee", fixture.vendor.request.payload.recipient],
    ["Description", "Market data API, Q4 usage"],
    ["PO number", "PO-1042"],
  ]);
});

test("a budget request card names the agent that will sign instead of a payee", async () => {
  const check = await requests.checkPermissionRequestLink(fixture.grantee.fragment, SLOT);
  const view = requests.permissionRequestCard(requests.permissionRequestInboxItem(check).permissionRequest, symbol);
  assert.equal(view.roleLabel, "Budget request");
  const labels = view.rows.map((row) => row.label);
  assert.ok(labels.includes("Agent that will sign"));
  assert.equal(labels.includes("Expected payee"), false);
  assert.equal(labels.includes("PO number"), false);
  assert.equal(view.rows.find((row) => row.key === "agent").value, fixture.grantee.agent);
});

// --- Builder prefill ---------------------------------------------------------

const DEFAULTS = { approvedAgent: "Owner1111", sourceTokenAccount: "", allowedMint: "OtherMint", maxPerPayment: "10", totalLimit: "11", expiresInDays: "7", expiresAtSlot: "", maxPaymentCount: "0", cooldownSlots: "0", tokenProgram: "spl-token" };
const DRAFT = { form: { ...DEFAULTS, maxPerPayment: "3", totalLimit: "9" }, signingMode: "delegated", slotEdited: false };

test("a request prefill wins over the saved draft, which wins over the defaults", () => {
  const prefill = requests.prefillFromRequest(fixture.vendor.request, fixture.vendor.requestHash);
  const fromRequest = requests.seedMandateBuilder({ wallet: "Owner1111", defaults: DEFAULTS, draft: DRAFT, prefill, currentSlot: fixture.currentSlot });
  assert.equal(fromRequest.source, "request");
  assert.equal(fromRequest.form.maxPerPayment, "5");
  assert.equal(fromRequest.form.totalLimit, "50");
  assert.equal(fromRequest.form.allowedMint, USDC);
  assert.equal(fromRequest.form.expiresAtSlot, fixture.vendor.request.payload.suggestedExpirySlot);
  assert.equal(fromRequest.form.expiresInDays, "30");
  assert.equal(fromRequest.slotEdited, true, "the exact requested slot is kept");
  assert.equal(fromRequest.signingMode, "human", "a purchase order leaves the owner's normal choice");
  assert.equal(fromRequest.form.approvedAgent, "Owner1111");
  assert.equal(requests.seedMandateBuilder({ wallet: "Owner1111", defaults: DEFAULTS, draft: DRAFT }).source, "draft");
  assert.equal(requests.seedMandateBuilder({ wallet: "Owner1111", defaults: DEFAULTS }).source, "defaults");
});

test("the prefill is held in memory once and cleared", () => {
  const prefill = requests.prefillFromRequest(fixture.vendor.request, fixture.vendor.requestHash);
  requests.setMandatePrefill(prefill);
  assert.equal(requests.peekMandatePrefill(), prefill);
  requests.clearMandatePrefill();
  assert.equal(requests.peekMandatePrefill(), null);
});

test("Requester's agent signs appears only for a budget request, preselected and fixed", () => {
  assert.deepEqual(requests.approvalOptions(null).map((option) => option.value), ["human", "delegated"]);
  const vendor = requests.approvalOptions(requests.prefillFromRequest(fixture.vendor.request, fixture.vendor.requestHash));
  assert.deepEqual(vendor.map((option) => [option.value, option.disabled]), [["human", false], ["delegated", false]]);
  const granteePrefill = requests.prefillFromRequest(fixture.grantee.request, fixture.grantee.requestHash);
  const grantee = requests.approvalOptions(granteePrefill);
  assert.deepEqual(grantee.map((option) => [option.value, option.disabled]), [["human", true], ["delegated", true], ["requester", false]]);
  assert.equal(grantee[2].label, "Requester’s agent signs");
  const seed = requests.seedMandateBuilder({ wallet: "Owner1111", defaults: DEFAULTS, draft: DRAFT, prefill: granteePrefill });
  assert.equal(seed.signingMode, "requester");
  assert.equal(seed.form.approvedAgent, fixture.grantee.agent, "approvedAgent is the request's agent, not the owner or a managed signer");
});

test("limits show the requested amount and a neutral note above it", () => {
  assert.equal(requests.requestedHelper("50000000", 6, "USDC"), "Requested: 50 USDC");
  assert.equal(requests.isAboveRequested("50", "50000000", 6), false);
  assert.equal(requests.isAboveRequested("49.999999", "50000000", 6), false);
  assert.equal(requests.isAboveRequested("50.000001", "50000000", 6), true);
  assert.equal(requests.isAboveRequested("not a number", "50000000", 6), false);
});

test("review shows (requested X) only where the owner changed a value, plus the payee rule for a purchase order", () => {
  const prefill = requests.prefillFromRequest(fixture.vendor.request, fixture.vendor.requestHash);
  const expiryLabel = (slot) => `slot ${slot}`;
  const same = requests.requestReviewRows({ prefill, chosen: { maxPerPayment: "5", totalLimit: "50", expiresAtSlot: prefill.expiresAtSlot }, symbol: "USDC", expiryLabel });
  assert.equal(same.from.label, "From request");
  assert.match(same.from.value, /^PO-1042 · [1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}$/);
  assert.equal(same.maxPerPayment.value, "5 USDC");
  assert.equal(same.totalLimit.value, "50 USDC");
  assert.equal(same.expires.value.includes("requested"), false);
  assert.equal(same.payee.label, "Expected payee");
  assert.equal(same.payee.value, fixture.vendor.request.payload.recipient);
  assert.equal(same.payee.helper, "Payments to anyone else are flagged on the receipt, not blocked by Solana.");
  const changed = requests.requestReviewRows({ prefill, chosen: { maxPerPayment: "2.5", totalLimit: "75", expiresAtSlot: "400000000" }, symbol: "USDC", expiryLabel });
  assert.equal(changed.maxPerPayment.value, "2.50 USDC (requested 5 USDC)");
  assert.equal(changed.totalLimit.value, "75 USDC (requested 50 USDC)");
  assert.equal(changed.expires.value, `slot 400000000 (requested slot ${prefill.expiresAtSlot})`);
  const grantee = requests.requestReviewRows({ prefill: requests.prefillFromRequest(fixture.grantee.request, fixture.grantee.requestHash), chosen: { maxPerPayment: "25", totalLimit: "25", expiresAtSlot: "" }, symbol: "USDC", expiryLabel });
  assert.equal(grantee.payee, undefined);
  assert.match(grantee.from.value, /^Hackathon API credits · /);
});

// --- Linking -----------------------------------------------------------------

test("the request is PUT against the new mandate; a failure leaves the mandate and offers a retry", async () => {
  const calls = [];
  const ok = await requests.linkMandateRequest(async (path, init) => {
    calls.push([path, init.method, JSON.parse(init.body)]);
    return new Response("{}", { status: 200 });
  }, "Mandate111", fixture.vendor.request);
  assert.deepEqual(ok, { status: "linked" });
  assert.deepEqual(calls, [["/v1/mandates/Mandate111/request", "PUT", fixture.vendor.request]]);

  const refused = await requests.linkMandateRequest(async () => new Response(JSON.stringify({ error: "This mandate uses a different token than the request" }), { status: 400 }), "Mandate111", fixture.vendor.request);
  assert.deepEqual(refused, { status: "failed", reason: "This mandate uses a different token than the request" });
  const offline = await requests.linkMandateRequest(async () => { throw new Error("Failed to fetch"); }, "Mandate111", fixture.vendor.request);
  assert.deepEqual(offline, { status: "failed", reason: "Failed to fetch" });

  assert.equal(requests.linkStatusCopy("PO-1042", { status: "linked" }), "Permission created · linked to PO-1042");
  assert.equal(requests.linkStatusCopy("PO-1042", offline), "The permission exists. Linking it to PO-1042 failed: Failed to fetch.");
  assert.equal(/mandate failed|not created/i.test(requests.linkStatusCopy("PO-1042", offline)), false, "never implies the mandate failed");

  const check = await requests.checkPermissionRequestLink(fixture.vendor.fragment, SLOT);
  let inbox = [requests.permissionRequestInboxItem(check)];
  inbox = requests.completePermissionRequest(inbox, check.requestHash, "Mandate111", "failed", "Failed to fetch");
  assert.equal(inbox[0].stage, "approved");
  assert.equal(inbox[0].permissionRequest.mandateAddress, "Mandate111");
  assert.equal(inbox[0].permissionRequest.link, "failed");
  assert.equal(inbox[0].permissionRequest.linkError, "Failed to fetch");
  inbox = requests.completePermissionRequest(inbox, check.requestHash, "Mandate111", "linked");
  assert.equal(inbox[0].permissionRequest.link, "linked");
  assert.equal(inbox[0].permissionRequest.linkError, undefined);
});

// --- Order match -------------------------------------------------------------

function receiptView(over = {}) {
  return {
    address: "3RcptOrderFixture1111111111111111111111111",
    mandate: "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    invoiceHash: fixture.invoice.invoiceHash,
    paymentId: "bb".repeat(32),
    mint: USDC,
    sourceTokenAccount: "Source111111111111111111111111111111111111",
    recipientTokenAccount: fixture.vendor.ata,
    agent: fixture.grantee.agent,
    executedAtSlot: "399999300",
    signatureReference: "cc".repeat(32),
    bump: "255",
    onChainStatus: "1",
    amount: { baseUnits: "4500000", decimals: 6, display: "4.500000", displayKind: "ui-amount" },
    tokenLabel: "USDC",
    currentMandate: { status: "absent" },
    seller: { status: "absent" },
    ...over,
  };
}

test("order + verified invoice + payment to the order's payee reads Matched", async () => {
  const receipt = receiptView();
  const invoice = await purchase.verifyPurchaseForReceipt(receipt, fixture.invoice.request, "owner");
  assert.equal(invoice.status, "verified");
  const linked = await order.verifyOrderForReceipt(receipt, fixture.vendor.request, "owner");
  assert.equal(linked.status, "linked");
  assert.equal(linked.payeeMatches, true);
  const match = model.orderMatch(invoice, "owner", linked);
  assert.equal(match.pill, "Matched");
  assert.deepEqual(match.rows.map((row) => [row.key, row.tone, row.text]), [
    ["order", "yes", "Purchase order PO-1042 from Acme Data (name not verified)"],
    ["invoice", "yes", "Invoice signed by seller"],
    ["payee", "yes", "Paid to the order’s payee"],
    ["payment", "yes", "Paid on Solana"],
  ]);
  assert.equal(match.details.poNumber, "PO-1042");
  assert.equal(match.canShareDetails, true);
});

test("a payment to another account than the order's payee reads Payee differs", async () => {
  const receipt = receiptView({ recipientTokenAccount: "Dest1111111111111111111111111111111111111" });
  const linked = await order.verifyOrderForReceipt(receipt, fixture.vendor.request, "owner");
  assert.equal(linked.payeeMatches, false);
  const match = model.orderMatch({ status: "none" }, "owner", linked);
  assert.equal(match.pill, "Payee differs");
  assert.ok(match.rows.some((row) => row.key === "payee" && row.tone === "no"));
});

test("an order without a verified invoice is not Matched", async () => {
  const linked = await order.verifyOrderForReceipt(receiptView(), fixture.vendor.request, "owner");
  assert.equal(model.orderMatch({ status: "none" }, "owner", linked).pill, "No invoice");
});

test("no linked order reads No order", async () => {
  const receipt = receiptView();
  const invoice = await purchase.verifyPurchaseForReceipt(receipt, fixture.invoice.request, "owner");
  assert.equal(model.orderMatch(invoice, "owner", { status: "none" }).pill, "No order");
  assert.equal(model.orderMatch(invoice, "owner").pill, "No order");
});

test("a budget request plus the payment reads Matched; the payee is open", async () => {
  const linked = await order.verifyOrderForReceipt(receiptView({ recipientTokenAccount: "Dest1111111111111111111111111111111111111" }), fixture.grantee.request, "owner");
  assert.equal(linked.status, "linked");
  assert.equal(linked.payeeMatches, null);
  const match = model.orderMatch({ status: "none" }, "owner", linked);
  assert.equal(match.pill, "Matched");
  assert.equal(match.rows[0].text, "Budget request from Team Lumen (name not verified)");
  assert.equal(match.rows.some((row) => row.key === "payee"), false);
});

test("an order for another agent or token does not attach to the receipt", async () => {
  const wrongAgent = await order.verifyOrderForReceipt(receiptView({ agent: "Agent111111111111111111111111111111111111" }), fixture.grantee.request, "owner");
  assert.deepEqual(wrongAgent, { status: "failed", via: "owner", reason: "it names a different agent than the one that paid" });
  const wrongMint = await order.verifyOrderForReceipt(receiptView({ mint: "So11111111111111111111111111111111111111112" }), fixture.vendor.request, "owner");
  assert.equal(wrongMint.status, "failed");
  const tampered = await order.verifyOrderForReceipt(receiptView(), JSON.parse(Buffer.from(fixture.tampered.fragment, "base64url").toString("utf8")), "link");
  assert.deepEqual(tampered, { status: "failed", via: "link", reason: "the requester signature does not check out" });
});

test("public order fragments show the proposal without claiming verified acceptance", async () => {
  const receipt = receiptView();
  const ownerOrder = await order.verifyOrderForReceipt(receipt, fixture.vendor.request, "owner");
  const ownerInvoice = await purchase.verifyPurchaseForReceipt(receipt, fixture.invoice.request, "owner");
  const publicView = model.orderMatch(ownerInvoice, "public", ownerOrder);
  assert.equal(publicView.pill, "No order", "without the link, public shows nothing new");
  assert.equal(JSON.stringify(publicView).includes("PO-1042"), false);
  assert.equal(JSON.stringify(publicView).includes("Acme"), false);

  const path = model.purchaseAuditPath(receipt.address, ownerInvoice.shareFragment, ownerOrder.shareFragment);
  assert.match(path, /^\/verify\/3RcptOrderFixture1+#purchase=[A-Za-z0-9_-]+&order=[A-Za-z0-9_-]+$/);
  assert.ok(path.length < 4_000, `audit link stays a reasonable size (${path.length} chars)`);
  const hash = path.slice(path.indexOf("#"));
  const linkOrder = await order.verifyOrderForReceipt(receipt, order.decodeOrderFragment(model.orderFragmentFromHash(hash)), "link");
  const linkInvoice = await purchase.verifyPurchaseForReceipt(receipt, purchase.decodePurchaseFragment(model.purchaseFragmentFromHash(hash)), "link");
  const linkView = model.orderMatch(linkInvoice, "link", linkOrder);
  assert.equal(linkView.pill, "Acceptance unverified");
  assert.equal(linkView.details.poNumber, "PO-1042");
  assert.equal(linkView.canShareDetails, false);
  assert.equal(model.purchaseAuditPath("R", undefined, "abc"), "/verify/R#order=abc");
  assert.equal(order.decodeOrderFragment("A".repeat(9_000)), null);
});

// --- CSV ---------------------------------------------------------------------

test("CSV appends PO number and Order match after the existing columns", async () => {
  const receipt = {
    address: "3RcptOrderFixture1111111111111111111111111", mandate: "MdT1", invoiceHash: new Uint8Array(32).fill(1), paymentId: new Uint8Array(32),
    mint: USDC, recipient: fixture.vendor.ata, sourceTokenAccount: "Src", recipientTokenAccount: fixture.vendor.ata, amount: 4_500_000n,
    agent: "Agent", executedAtSlot: 1n, signatureReference: new Uint8Array(32), status: "confirmed", onChainStatus: 1, bump: 255, policySnapshot: null,
  };
  const csv = await exporter.buildReceiptsCsv({
    receipts: [receipt, { ...receipt, address: "4Other" }],
    decimalsByMint: new Map([[USDC, 6]]),
    tokenLabel: () => "USDC",
    origin: "https://chainpay.example",
    blockTime: async () => null,
    order: async (row) => (row.address === "4Other" ? null : { poNumber: "PO-1042", orderMatch: "Matched" }),
  });
  const lines = csv.trimEnd().split("\r\n");
  assert.match(lines[0], /,Receipt,Verify URL,Explorer URL,PO number,Order match$/);
  assert.match(lines[0], /^Date,Description,Amount,Payee,Reference,/, "existing column order is unchanged");
  assert.match(lines[1], /,PO-1042,Matched$/);
  assert.match(lines[2], /,,$/);
  assert.equal(exporter.statementCsvFilename("MdT1aaaaaaaaaaaa", new Date(2026, 9, 2)), "chainpay-statement-MdT1aaaa-2026-10-02.csv");
});


test("an imported request is rechecked at the acceptance deadline", async () => {
  const checked = await requests.checkPermissionRequestLink(fixture.vendor.fragment, SLOT);
  assert.equal(checked.status, "valid");
  await requests.validatePermissionRequestForApproval(checked.signed, SLOT);
  await assert.rejects(requests.validatePermissionRequestForApproval(checked.signed, BigInt(checked.signed.payload.validUntilSlot)), /expired/);
  await assert.rejects(requests.validatePermissionRequestForApproval(checked.signed, null), /expiry could not be checked/);
});

test("a correctly signed request for another cluster is refused before approval", async () => {
  const { Keypair } = require("@solana/web3.js");
  const { signMandateRequest, encodeMandateRequestLink } = await import("@chainpay/sdk");
  const key = Keypair.fromSeed(new Uint8Array(32).fill(43));
  const signed = await signMandateRequest({ ...fixture.vendor.request.payload, cluster: "mainnet-beta", requester: key.publicKey.toBase58() }, key.secretKey);
  await assert.rejects(requests.validatePermissionRequestForApproval(signed, SLOT), /different Solana cluster/);
  const fragment = encodeMandateRequestLink(signed, "https://example.test").split("#req=")[1];
  const checked = await requests.checkPermissionRequestLink(fragment, SLOT);
  assert.equal(checked.status, "invalid");
  assert.match(checked.reason, /different Solana cluster/);
});

test("a budget proposal in a public fragment never proves owner acceptance", async () => {
  const linked = await order.verifyOrderForReceipt(receiptView(), fixture.grantee.request, "link");
  assert.equal(linked.status, "linked");
  assert.equal(model.orderMatch({ status: "none" }, "link", linked).pill, "Acceptance unverified");
});

test("invoice amount and mint mismatches propagate through order matching to CSV", async () => {
  for (const field of ["amount", "mint"]) {
    const receipt = receiptView(field === "amount" ? { amount: { baseUnits: "1", decimals: 6 } } : { mint: "So11111111111111111111111111111111111111112" });
    const invoice = await purchase.verifyPurchaseForReceipt(receipt, fixture.invoice.request, "owner");
    assert.equal(invoice.status, "verified");
    assert.ok(invoice.mismatches.includes(field));
    const vendor = await order.verifyOrderForReceipt(receiptView(), fixture.vendor.request, "owner");
    const budget = await order.verifyOrderForReceipt(receiptView(), fixture.grantee.request, "owner");
    for (const linked of [vendor, budget, undefined]) {
      assert.equal(model.orderMatch(invoice, "owner", linked).pill, "Invoice differs");
    }
    const summary = model.orderMatch(invoice, "owner", vendor);
    const row = {
      address: receipt.address, mandate: receipt.mandate, invoiceHash: new Uint8Array(32), paymentId: new Uint8Array(32),
      mint: receipt.mint, recipient: receipt.recipientTokenAccount, sourceTokenAccount: "Src", recipientTokenAccount: receipt.recipientTokenAccount,
      amount: BigInt(receipt.amount.baseUnits), agent: receipt.agent, executedAtSlot: 1n, signatureReference: new Uint8Array(32),
      status: "confirmed", onChainStatus: 1, bump: 255, policySnapshot: null,
    };
    const csv = await exporter.buildReceiptsCsv({ receipts: [row], decimalsByMint: new Map([[row.mint, 6]]), tokenLabel: () => "tokens", origin: "https://example.test", blockTime: async () => null,
      order: async () => ({ poNumber: "PO-1042", orderMatch: summary.pill }) });
    assert.match(csv.trimEnd(), /,PO-1042,Invoice differs$/);
  }
});
