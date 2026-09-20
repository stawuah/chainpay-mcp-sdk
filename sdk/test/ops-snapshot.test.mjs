import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpsSnapshot,
  formatOpsAnsi,
  formatOpsMarkdown,
  formatPaymentLookupMarkdown,
  formatPreparePolicyMarkdown,
  formatReceiptListMarkdown,
  humanTokenAmount,
  receiptListFromSnapshot,
  receiptUrlForAddress,
  shortAddress,
} from "../dist/ops-snapshot.js";

const OWNER = "Owner111111111111111111111111111111111111111";
const MANDATE = "Mandate1111111111111111111111111111111111111";
const RECEIPT = "Receipt11111111111111111111111111111111111111";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const AGENT = "Agent111111111111111111111111111111111111111";

function mandate(overrides = {}) {
  return {
    address: MANDATE,
    owner: OWNER,
    approvedAgent: AGENT,
    sourceTokenAccount: "Source1111111111111111111111111111111111111",
    allowedMint: USDC,
    maxPerPayment: 10_000_000n,
    totalLimit: 100_000_000n,
    amountSpent: 4_500_000n,
    paymentCount: 1n,
    expiresAtSlot: 2_000_000n,
    maxPaymentCount: 0n,
    cooldownSlots: 0n,
    lastPaymentSlot: 100n,
    paused: false,
    revoked: false,
    status: "active",
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    address: RECEIPT,
    mandate: MANDATE,
    invoiceHash: new Uint8Array(32),
    paymentId: new Uint8Array(32),
    mint: USDC,
    recipient: "Recipient11111111111111111111111111111111111",
    sourceTokenAccount: "Source1111111111111111111111111111111111111",
    recipientTokenAccount: "Dest111111111111111111111111111111111111111",
    amount: 4_500_000n,
    agent: AGENT,
    executedAtSlot: 200n,
    signatureReference: new Uint8Array(32),
    status: "confirmed",
    onChainStatus: 1,
    bump: 255,
    ...overrides,
  };
}

test("humanTokenAmount keeps exact base units and strips trailing zeros", () => {
  const amount = humanTokenAmount(4_500_000n, 6);
  assert.equal(amount.display, "4.5");
  assert.equal(amount.base, "4500000");
  assert.equal(amount.decimals, 6);
});

test("buildOpsSnapshot matches dashboard spent and remaining totals", () => {
  const snapshot = buildOpsSnapshot({
    owner: OWNER,
    mandates: [mandate()],
    receipts: [receipt()],
    decimalsByMint: { [USDC]: 6 },
    currentSlot: 300_000n,
    appUrl: "https://chainpay.example",
  });
  assert.equal(snapshot.kind, "spend_overview");
  assert.equal(snapshot.totals[0].spent, "4.5");
  assert.equal(snapshot.totals[0].remaining, "95.5");
  assert.equal(snapshot.totals[0].symbol, "USDC");
  assert.equal(snapshot.receipts[0].receiptUrl, `https://chainpay.example/verify/${RECEIPT}`);
  assert.equal(snapshot.attention.length, 0);
});

test("attention flags paused, exhausted, and expiring mandates", () => {
  const paused = buildOpsSnapshot({
    owner: OWNER,
    mandates: [mandate({ status: "paused", paused: true })],
    receipts: [],
    decimalsByMint: { [USDC]: 6 },
  });
  assert.equal(paused.attention[0].kind, "paused");

  const exhausted = buildOpsSnapshot({
    owner: OWNER,
    mandates: [mandate({ amountSpent: 100_000_000n })],
    receipts: [],
    decimalsByMint: { [USDC]: 6 },
  });
  assert.equal(exhausted.attention[0].kind, "exhausted");
  assert.equal(exhausted.totals[0].remaining, "0");

  const expiring = buildOpsSnapshot({
    owner: OWNER,
    mandates: [mandate({ expiresAtSlot: 300_100n })],
    receipts: [],
    decimalsByMint: { [USDC]: 6 },
    currentSlot: 300_000n,
    expiringSoonSlots: 216_000n,
  });
  assert.equal(expiring.attention[0].kind, "expiring_soon");
});

test("formatters render cards instead of raw JSON", () => {
  const snapshot = buildOpsSnapshot({
    owner: OWNER,
    mandates: [mandate()],
    receipts: [receipt()],
    decimalsByMint: { [USDC]: 6 },
    appUrl: "https://chainpay.example",
  });
  const markdown = formatOpsMarkdown(snapshot);
  assert.match(markdown, /Spending overview/);
  assert.match(markdown, /4\.5 USDC/);
  assert.match(markdown, /95\.5 USDC/);
  assert.match(markdown, /verify/);
  assert.doesNotMatch(markdown, /^\{/);

  const ansi = formatOpsAnsi(snapshot);
  assert.match(ansi, /Spending overview/);
  assert.doesNotMatch(ansi, /\*\*/);

  const list = formatReceiptListMarkdown(receiptListFromSnapshot(snapshot));
  assert.match(list, /1 receipt/);
  assert.match(list, /4\.5 USDC/);

  const lookup = formatPaymentLookupMarkdown({
    kind: "payment_lookup",
    found: true,
    receiptAddress: RECEIPT,
    amount: "4.5",
    symbol: "USDC",
    status: "confirmed",
    receiptUrl: receiptUrlForAddress(RECEIPT, "https://chainpay.example"),
  });
  assert.match(lookup, /Payment receipt/);
  assert.match(lookup, /4\.5 USDC/);
  assert.match(lookup, /verify/);

  const pause = formatPreparePolicyMarkdown("pause", MANDATE);
  assert.match(pause, /Owner wallet signature required/);
  assert.match(pause, /dashboard/);
  assert.match(pause, /does not sign/);
  assert.ok(pause.includes(shortAddress(MANDATE)));
});

test("empty snapshot and missing receipt stay honest", () => {
  const empty = buildOpsSnapshot({
    owner: OWNER,
    mandates: [],
    receipts: [],
    decimalsByMint: {},
  });
  assert.match(formatOpsMarkdown(empty), /No spending permissions found/);
  assert.match(formatReceiptListMarkdown(receiptListFromSnapshot(empty)), /No receipts yet/);
  assert.match(formatPaymentLookupMarkdown({ kind: "payment_lookup", found: false, receiptAddress: RECEIPT }), /Receipt not found/);
});
