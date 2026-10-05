// Receipt surfaces for limits at payment, Order match, and export.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, unlink } from "node:fs/promises";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");
const purchaseFixture = JSON.parse(await readFile(new URL("./fixtures/receipt-purchase.json", import.meta.url), "utf8"));

async function loadModel() {
  const source = await readFile(new URL("../src/receipts/model.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

/** Bundle one module; the SDK and React stay external and load from node_modules. */
async function loadBundle(entry, name, { platform = "node", plugins = [] } = {}) {
  const outfile = join(frontendRoot, `test/.tmp-${name}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform,
    jsx: "automatic",
    outfile,
    loader: { ".css": "empty" },
    external: ["@chainpay/sdk", "react", "react-dom", "react/jsx-runtime"],
    plugins,
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

const model = await loadModel();
const purchase = await loadBundle("src/receipts/purchase.ts", "receipt-purchase");
const exporter = await loadBundle("src/receipts/export.ts", "receipt-export");

const LIMITS = {
  maxPerPayment: "5000000",
  totalLimit: "50000000",
  amountSpentAfter: "12000000",
  paymentCountAfter: "3",
  maxPaymentCount: "10",
  expiresAtSlot: "405000000",
  cooldownSlots: "0",
};

function currentFields(over = {}, baseOver = {}) {
  return {
    status: "active",
    paused: false,
    revoked: false,
    maxPerPayment: "5.000000",
    totalLimit: "50.000000",
    amountSpent: "12.000000",
    paymentCount: "3",
    maxPaymentCount: "10",
    cooldownSlots: "0",
    expiresAtSlot: "405000000",
    baseUnits: { maxPerPayment: "5000000", totalLimit: "50000000", amountSpent: "12000000", ...baseOver },
    ...over,
  };
}

function receipt(over = {}) {
  return {
    address: "3Rcpt2v2SnapshotFixture111111111111111111",
    mandate: "Mandate11111111111111111111111111111111111",
    invoiceHash: purchaseFixture.invoiceHash,
    paymentId: "bb".repeat(32),
    mint: purchaseFixture.request.payload.mint,
    sourceTokenAccount: "Source111111111111111111111111111111111111",
    recipientTokenAccount: purchaseFixture.request.payload.recipient,
    agent: "Agent111111111111111111111111111111111111",
    executedAtSlot: "399999200",
    signatureReference: "cc".repeat(32),
    bump: "255",
    onChainStatus: "1",
    amount: { baseUnits: "4500000", decimals: 6, display: "4.500000", displayKind: "ui-amount" },
    tokenLabel: "USDC",
    currentMandate: { status: "present", fields: currentFields() },
    seller: { status: "absent" },
    currentSlot: "399999500",
    ...over,
  };
}

// --- Spending permission at payment ---------------------------------------

test("token units keep every significant digit and drop only trailing zeros", () => {
  assert.equal(model.formatTokenUnits("4500000", 6, "USDC"), "4.50 USDC");
  assert.equal(model.formatTokenUnits("5000000", 6, "USDC"), "5 USDC");
  assert.equal(model.formatTokenUnits("4500001", 6, "USDC"), "4.500001 USDC");
  assert.equal(model.formatTokenUnits("18446744073709551615", 6, "USDC"), "18446744073709.551615 USDC");
  assert.equal(model.formatTokenUnits("4500000", null, "USDC"), "4500000 base units");
});

test("an on-chain snapshot shows the limits at payment in token units", () => {
  const display = model.policyAtPayment(receipt({ policy: { source: "on-chain", limits: LIMITS } }), Date.UTC(2026, 9, 2));
  assert.equal(display.caption, "Recorded on Solana at payment");
  assert.equal(display.heading, "Spending permission at payment");
  assert.equal(display.rows[0], "4.50 USDC ≤ 5 USDC per payment");
  assert.equal(display.rows[1], "12 of 50 USDC used after this payment");
  assert.equal(display.rows[2], "Payment 3 of 10");
  assert.match(display.rows[3], /^Paid before expiry \(≈ [A-Z][a-z]{2} \d{1,2}, 2026\)$/);
  assert.equal(display.rows.some((row) => /base units|5000000/.test(row)), false, "visible lines use token units");
});

test("no payment-count row without a cap, and no date without a reference slot", () => {
  const display = model.policyAtPayment(receipt({
    currentSlot: undefined,
    policy: { source: "on-chain", limits: { ...LIMITS, maxPaymentCount: "0" } },
  }));
  assert.equal(display.rows.some((row) => row.startsWith("Payment ")), false);
  assert.equal(display.rows.at(-1), "Paid before expiry");
});

test("Paid before expiry needs the snapshot's expiry to be after the payment slot", () => {
  const at = (executedAtSlot, expiresAtSlot) => model.policyAtPayment(receipt({
    executedAtSlot,
    currentSlot: undefined,
    policy: { source: "on-chain", limits: { ...LIMITS, expiresAtSlot } },
  })).rows.at(-1);
  assert.equal(at("399999200", "405000000"), "Paid before expiry");
  assert.equal(at("405000000", "405000000"), "Expires at slot 405000000", "the program needs expiry > slot");
  assert.equal(at("405000001", "405000000"), "Expires at slot 405000000");
  assert.equal(at("not-a-slot", "405000000"), "Expires at slot 405000000");
  assert.equal(model.paidBeforeExpiryProven(receipt({ policy: { source: "on-chain", limits: LIMITS } })), true);
  for (const policy of [undefined, { source: "not-recorded" }, { source: "relay-observed", limits: LIMITS, observedAtSlot: "399999300", includesLaterPayments: false }]) {
    assert.equal(model.paidBeforeExpiryProven(receipt({ policy })), false);
  }
});

test("a relay observation is labeled as read after payment and claims nothing about the payment", () => {
  const display = model.policyAtPayment(receipt({
    policy: { source: "relay-observed", limits: LIMITS, observedAtSlot: "399999300", includesLaterPayments: false },
  }), Date.UTC(2026, 9, 2));
  assert.equal(display.caption, "Seen by the ChainPay relay after payment, not stored on Solana. The limits may have changed since the payment.");
  assert.equal(display.heading, "Spending permission, read after payment");
  assert.equal(display.rows[0], "5 USDC per payment, read after this payment");
  assert.ok(display.rows.includes("12 of 50 USDC used after this payment"));
  assert.ok(display.rows.includes("Payment 3 of 10"));
  assert.match(display.rows.at(-1), /^Expires ≈ [A-Z][a-z]{2} \d{1,2}, 2026, read after this payment$/);
  assert.equal(display.rows.some((row) => /before expiry|≤|at payment/.test(row)), false);
  assert.match(model.allowedStampDetail({ source: "relay-observed", limits: LIMITS, observedAtSlot: "1", includesLaterPayments: false }), /not stored on Solana/);
});

test("a relay observation that includes later payments drops the running totals", () => {
  const display = model.policyAtPayment(receipt({
    policy: { source: "relay-observed", limits: { ...LIMITS, amountSpentAfter: "21000000", paymentCountAfter: "5" }, observedAtSlot: "399999300", includesLaterPayments: true },
  }), Date.UTC(2026, 9, 2));
  assert.equal(display.rows[0], "5 USDC per payment, read after this payment");
  assert.equal(display.rows.some((row) => row.includes("used after this payment")), false);
  assert.equal(display.rows.some((row) => row.startsWith("Payment ")), false);
  assert.equal(display.rows.some((row) => row.includes("21")), false);
});

test("not recorded shows no rows and says today's limits are shown instead", () => {
  for (const policy of [undefined, { source: "not-recorded" }]) {
    const display = model.policyAtPayment(receipt({ policy }));
    assert.equal(display.source, "not-recorded");
    assert.deepEqual(display.rows, []);
    assert.equal(display.caption, "Not recorded for this receipt. These are today’s limits, not the ones at payment.");
    assert.equal(display.heading, "Spending permission today");
  }
});

test("the Allowed stamp points at the section and stays a single stamp", () => {
  const recorded = model.receiptStamps(receipt({ policy: { source: "on-chain", limits: LIMITS } }));
  assert.deepEqual(recorded.map((stamp) => stamp.key), ["allowed", "paid", "seller"]);
  assert.match(recorded[0].detail, /Spending permission at payment/);
  assert.equal(recorded[0].detail.includes("mandate"), false);
  const unrecorded = model.receiptStamps(receipt({ policy: { source: "not-recorded" } }));
  assert.match(unrecorded[0].detail, /not recorded/);
});

// --- If paid today --------------------------------------------------------

test("today check: within limits", () => {
  assert.deepEqual(model.todayCheck(receipt()), { status: "within", line: "If paid today: within limits" });
});

test("today check names each plain blocking reason", () => {
  const cases = [
    [{ revoked: true, status: "revoked" }, {}, "If paid today: blocked — the spending permission was revoked"],
    [{ paused: true, status: "paused" }, {}, "If paid today: blocked — the spending permission is paused"],
    [{ status: "expired" }, {}, "If paid today: blocked — the spending permission has expired"],
    [{ expiresAtSlot: "399999000" }, {}, "If paid today: blocked — the spending permission has expired"],
    [{}, { maxPerPayment: "3000000" }, "If paid today: blocked — 4.50 USDC is over today’s 3 USDC per-payment limit"],
    [{ paymentCount: "10" }, {}, "If paid today: blocked — all 10 payments have been used"],
    [{}, { amountSpent: "48000000" }, "If paid today: blocked — only 2 USDC of the 50 USDC allowance is left"],
    [{}, { amountSpent: "50000000" }, "If paid today: blocked — only 0 USDC of the 50 USDC allowance is left"],
  ];
  for (const [over, baseOver, line] of cases) {
    const check = model.todayCheck(receipt({ currentMandate: { status: "present", fields: currentFields(over, baseOver) } }));
    assert.equal(check.status, "blocked");
    assert.equal(check.line, line);
  }
});

test("today check uses exact amounts at the boundary, never floating point", () => {
  const exact = model.todayCheck(receipt({
    amount: { baseUnits: "9007199254740993", decimals: 6, display: "x", displayKind: "ui-amount" },
    currentMandate: { status: "present", fields: currentFields({}, { maxPerPayment: "9007199254740993", totalLimit: "9007199254740993", amountSpent: "0" }) },
  }));
  assert.equal(exact.status, "within");
  const over = model.todayCheck(receipt({
    amount: { baseUnits: "9007199254740993", decimals: 6, display: "x", displayKind: "ui-amount" },
    currentMandate: { status: "present", fields: currentFields({}, { maxPerPayment: "9007199254740992", totalLimit: "99007199254740993", amountSpent: "0" }) },
  }));
  assert.equal(over.status, "blocked");
});

test("today check is not checked when today's limits cannot be read", () => {
  for (const currentMandate of [{ status: "absent" }, { status: "unavailable", reason: "RPC down" }, { status: "present", fields: currentFields({ baseUnits: undefined }) }]) {
    const check = model.todayCheck(receipt({ currentMandate }));
    assert.equal(check.status, "unknown");
    assert.equal(check.line, "If paid today: not checked. Today’s limits could not be read.");
  }
});

// --- Order match ----------------------------------------------------------

const VERIFIED = {
  status: "verified",
  via: "owner",
  merchant: purchaseFixture.request.payload.merchant,
  invoice: "INV-2026-0142",
  description: "Market data API, October usage",
  lineItems: [{ label: "API calls", amount: "4 USDC", quantity: "4000" }],
  mismatches: [],
  shareFragment: "abc",
};

test("nothing verifiable means no Order match section", () => {
  assert.equal(model.orderMatch(undefined, "public"), null);
  assert.equal(model.orderMatch({ status: "none" }, "owner"), null);
  assert.equal(model.orderMatch({ status: "failed", via: "owner", reason: "x" }, "public"), null);
});

test("the owner sees the signed invoice and can share it with details", () => {
  const match = model.orderMatch(VERIFIED, "owner");
  assert.equal(match.pill, "No order");
  assert.deepEqual(match.rows.map((row) => [row.key, row.tone, row.text]), [
    ["invoice", "yes", "Invoice signed by seller"],
    ["payment", "yes", "Paid on Solana"],
  ]);
  assert.equal(match.details.description, "Market data API, October usage");
  assert.equal(match.canShareDetails, true);
});

test("the public never sees request content, even if handed a verified state", () => {
  const match = model.orderMatch(VERIFIED, "public");
  assert.equal(match.rows[0].text, "Invoice signed by seller · details private");
  assert.equal(match.details, undefined);
  assert.equal(match.canShareDetails, false);
  assert.equal(JSON.stringify(match).includes("Market data"), false);
  assert.equal(JSON.stringify(match).includes("INV-2026-0142"), false);
  // An owner-sourced state on /verify is not an audit link either.
  assert.equal(model.orderMatch(VERIFIED, "link").details, undefined);
});

test("a verified audit link shows details but cannot be re-shared from /verify", () => {
  const match = model.orderMatch({ ...VERIFIED, via: "link", shareFragment: undefined }, "link");
  assert.equal(match.details.invoice, "INV-2026-0142");
  assert.equal(match.canShareDetails, false);
});

test("a payment to another payee than the invoice named reads Payee differs", () => {
  const match = model.orderMatch({ ...VERIFIED, mismatches: ["recipient"] }, "owner");
  assert.equal(match.pill, "Payee differs");
  assert.ok(match.rows.some((row) => row.tone === "no" && row.text === "This payment’s payee differs from the invoice"));
});

test("a failed invoice is a clear failed line and shows nothing from it", () => {
  const match = model.orderMatch({ status: "failed", via: "link", reason: "the seller signature does not check out" }, "link");
  assert.equal(match.rows[0].tone, "no");
  assert.equal(match.rows[0].text, "Invoice not verified: the seller signature does not check out. Nothing from it is shown.");
  assert.equal(match.details, undefined);
});

test("audit link paths keep the request in the fragment only", () => {
  assert.equal(model.purchaseAuditPath("3Rcpt", "eyJ"), "/verify/3Rcpt#purchase=eyJ");
  assert.equal(model.purchaseFragmentFromHash("#purchase=eyJ"), "eyJ");
  assert.equal(model.purchaseFragmentFromHash("#other=1&purchase=eyJ"), "eyJ");
  assert.equal(model.purchaseFragmentFromHash(""), null);
  assert.equal(model.purchaseFragmentFromHash("#purchase="), null);
});

// --- Audit link verification ----------------------------------------------

test("an audit link round-trips and verifies against the receipt's invoice hash", async () => {
  const fragment = purchase.encodePurchaseFragment(purchaseFixture.request);
  assert.match(fragment, /^[A-Za-z0-9_-]+$/);
  const decoded = purchase.decodePurchaseFragment(fragment);
  assert.deepEqual(decoded, purchaseFixture.request);
  const result = await purchase.verifyPurchaseForReceipt(receipt(), decoded, "link");
  assert.equal(result.status, "verified");
  assert.equal(result.via, "link");
  assert.equal(result.invoice, "INV-2026-0142");
  assert.equal(result.description, "Market data API, October usage");
  assert.deepEqual(result.lineItems, [
    { label: "API calls", amount: "4 USDC", quantity: "4000" },
    { label: "Priority support", amount: "0.50 USDC", quantity: "1" },
  ]);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.shareFragment, undefined, "a visitor's link is not re-shareable");
  const owner = await purchase.verifyPurchaseForReceipt(receipt(), purchaseFixture.request, "owner");
  assert.equal(owner.shareFragment, fragment);
});

test("an edited audit link fails and reveals nothing", async () => {
  const tampered = structuredClone(purchaseFixture.request);
  tampered.payload.description = "Something else entirely";
  const result = await purchase.verifyPurchaseForReceipt(receipt(), tampered, "link");
  assert.equal(result.status, "failed");
  assert.equal(JSON.stringify(result).includes("Something else"), false);
  assert.equal(JSON.stringify(result).includes("INV-2026"), false);
});

test("a genuine invoice for another receipt fails on the hash", async () => {
  const result = await purchase.verifyPurchaseForReceipt(receipt({ invoiceHash: "aa".repeat(32) }), purchaseFixture.request, "link");
  assert.deepEqual(result, { status: "failed", via: "link", reason: "it is not the invoice this receipt paid" });
});

test("a receipt that paid another account than the invoice named is flagged", async () => {
  const result = await purchase.verifyPurchaseForReceipt(receipt({ recipientTokenAccount: "Dest1111111111111111111111111111111111111" }), purchaseFixture.request, "owner");
  assert.equal(result.status, "verified");
  assert.deepEqual(result.mismatches, ["recipient"]);
  assert.equal(model.orderMatch(result, "owner").pill, "Payee differs");
});

test("malformed fragments decode to nothing", () => {
  assert.equal(purchase.decodePurchaseFragment(""), null);
  assert.equal(purchase.decodePurchaseFragment("not base64!"), null);
  assert.equal(purchase.decodePurchaseFragment(Buffer.from("[1,2]").toString("base64url")), null);
  assert.equal(purchase.decodePurchaseFragment(Buffer.from('{"payload":1,"signature":"x"}').toString("base64url")), null);
  assert.equal(purchase.decodePurchaseFragment("A".repeat(20_000)), null);
});

// --- Export ---------------------------------------------------------------

function sdkReceipt(over = {}) {
  return {
    address: "3Rcpt2v2SnapshotFixture111111111111111111",
    mandate: "Mandate11111111111111111111111111111111111",
    invoiceHash: new Uint8Array(32).fill(1),
    paymentId: new Uint8Array(32).fill(2),
    mint: purchaseFixture.request.payload.mint,
    recipient: "Dest1111111111111111111111111111111111111",
    sourceTokenAccount: "Source111111111111111111111111111111111111",
    recipientTokenAccount: "Dest1111111111111111111111111111111111111",
    amount: 4_500_000n,
    agent: "Agent111111111111111111111111111111111111",
    executedAtSlot: 399_999_200n,
    signatureReference: new Uint8Array(32),
    status: "confirmed",
    onChainStatus: 1,
    bump: 255,
    policySnapshot: null,
    ...over,
  };
}

test("export names the file by date and writes one row per receipt with its limits source", async () => {
  assert.equal(exporter.receiptsCsvFilename(new Date(2026, 9, 2, 23, 59)), "chainpay-receipts-2026-10-02.csv");
  const snapshot = { version: 1, maxPerPayment: 5_000_000n, totalLimit: 50_000_000n, amountSpentAfter: 12_000_000n, paymentCountAfter: 3n, maxPaymentCount: 10n, expiresAtSlot: 405_000_000n, cooldownSlots: 0n };
  const relayAsked = [];
  const csv = await exporter.buildReceiptsCsv({
    receipts: [
      sdkReceipt({ policySnapshot: snapshot }),
      sdkReceipt({ address: "4RelayObservedFixture11111111111111111111", executedAtSlot: 399_999_300n }),
      sdkReceipt({ address: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", amount: 4_500_001n, executedAtSlot: 399_999_000n }),
    ],
    decimalsByMint: new Map([[purchaseFixture.request.payload.mint, 6]]),
    tokenLabel: () => "USDC",
    origin: "https://chainpay.example",
    blockTime: async (slot) => (slot === 399_999_200n ? Date.UTC(2026, 9, 1) / 1000 : null),
    relayPolicy: async (address) => {
      relayAsked.push(address);
      return address.startsWith("4Relay")
        ? { source: "relay-observed", max_per_payment: "5000000", total_limit: "50000000", amount_spent_after: "21000000", payment_count_after: "5", max_payment_count: "10", expires_at_slot: "405000000", cooldown_slots: "0", observed_at_slot: "399999400", includes_later_payments: true }
        : null;
    },
  });
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Date,Description,Amount,Payee,Reference,Token,/);
  assert.match(lines[1], /^2026-10-01,,4\.5,Dest1+,/);
  assert.match(lines[1], /,5,50,12,on-chain,3Rcpt2v2SnapshotFixture1+,https:\/\/chainpay\.example\/verify\/3Rcpt2v2SnapshotFixture1+,/);
  assert.match(lines[2], /,5,50,,relay-observed,/, "spent-after left empty when later payments are counted");
  assert.match(lines[3], /^,,4\.500001,/);
  assert.match(lines[3], /,,,,not-recorded,/);
  assert.deepEqual(relayAsked, ["4RelayObservedFixture11111111111111111111", "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1"], "on-chain receipts never ask the relay");
});

test("export downloads the CSV as a file through a temporary link", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/receipts" });
  const created = [];
  const revoked = [];
  const clicks = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { created.push(blob); return "blob:fixture"; };
  URL.revokeObjectURL = (url) => revoked.push(url);
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    clicks.push({ href: this.href, download: this.download, attached: this.isConnected });
  };
  try {
    exporter.downloadTextFile("Date,Amount\r\n", "chainpay-receipts-2026-10-02.csv", undefined, dom.window.document);
    assert.deepEqual(clicks, [{ href: "blob:fixture", download: "chainpay-receipts-2026-10-02.csv", attached: true }]);
    assert.equal(created.length, 1);
    assert.equal(created[0].type, "text/csv;charset=utf-8");
    assert.equal(await created[0].text(), "Date,Amount\r\n");
    assert.equal(dom.window.document.querySelector("a"), null, "the link is removed after the click");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.deepEqual(revoked, ["blob:fixture"]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.close();
  }
});

// --- Rendered card --------------------------------------------------------

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/verify/x", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

async function renderCard(props) {
  const { ReceiptCard } = await loadBundle("src/receipts/ReceiptCard.tsx", "receipt-card", { platform: "browser" });
  const dom = installDom();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(ReceiptCard, props)));
  const text = host.textContent ?? "";
  const html = host.innerHTML;
  const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent.trim());
  await act(async () => root.unmount());
  dom.window.close();
  return { text, html, buttons };
}

test("public card with an owner-sourced invoice shows no purchase content", async () => {
  const { text, buttons } = await renderCard({
    receipt: receipt({ policy: { source: "on-chain", limits: LIMITS } }),
    purchase: VERIFIED,
  });
  assert.match(text, /Spending permission at payment/);
  assert.match(text, /4\.50 USDC ≤ 5 USDC per payment/);
  assert.match(text, /Recorded on Solana at payment/);
  assert.match(text, /If paid today: within limits/);
  assert.match(text, /Invoice signed by seller · details private/);
  assert.equal(text.includes("Market data API"), false);
  assert.equal(text.includes("INV-2026-0142"), false);
  assert.equal(buttons.some((label) => label.startsWith("Share with details")), false);
  assert.equal(text.includes("Current mandate"), false);
});

test("owner card shows the invoice, line items and Share with details", async () => {
  const { text, buttons, html } = await renderCard({
    receipt: receipt({ policy: { source: "on-chain", limits: LIMITS } }),
    purchase: VERIFIED,
    shareMode: "dashboard",
  });
  assert.match(text, /Order match/);
  assert.match(text, /order · invoice · payment/);
  assert.match(text, /No order/);
  assert.match(text, /Market data API, October usage/);
  assert.match(text, /API calls × 4000 · 4 USDC/);
  assert.ok(buttons.some((label) => label.startsWith("Share with details")));
  assert.match(text, /Anyone with that link can read what was bought/);
  assert.match(html, /Per-payment limit at payment \(base units\)/);
  assert.equal((html.match(/data-stamp=/g) ?? []).length, 3, "still exactly three stamps");
});

test("a not-recorded receipt keeps today's limits and the Paid caveat", async () => {
  const { text } = await renderCard({ receipt: receipt({ policy: { source: "not-recorded" } }) });
  assert.match(text, /Spending permission today/);
  assert.match(text, /Not recorded for this receipt\. These are today’s limits, not the ones at payment\./);
  assert.equal(/Paid before expiry|Spending permission at payment/.test(text), false, "an old receipt never claims limits at payment");
  assert.match(text, /Status today/);
  assert.match(text, /Per payment5 USDC/);
  assert.match(text, /Changing or pausing this permission does not undo Paid\./);
  assert.match(text, /If paid today: within limits/);
  assert.equal(text.includes("Order match"), false, "nothing verifiable, no section");
});
