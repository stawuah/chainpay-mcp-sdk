import assert from "node:assert/strict";
import test from "node:test";
import { formatToolPresentation } from "../dist/tools/presentation.js";
import { toolResult } from "../dist/tools/common.js";

test("formatToolPresentation renders mandate list as markdown card", () => {
  const text = formatToolPresentation({
    owner: "Owner111111111111111111111111111111111111111",
    count: 1,
    mandates: [{
      mandate: {
        address: "Mandate1111111111111111111111111111111111111",
        status: "active",
        allowedMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      },
      display: {
        symbol: "USDC",
        amounts: { maxPerPayment: "10", totalLimit: "100", amountSpent: "4.5" },
      },
    }],
  });
  assert.match(text, /\*\*1 spending permission\*\*/);
  assert.match(text, /USDC/);
  assert.match(text, /active/);
  assert.doesNotMatch(text, /^\{/);
});

test("formatToolPresentation renders requirements checklist", () => {
  const text = formatToolPresentation({
    action: "details_required",
    status: "needs_details",
    missing: ["payment amount", "recipient token account"],
    checks: [
      { key: "limits", label: "Limits", status: "missing", detail: "Provide the payment amount." },
      { key: "recipient", label: "Recipient", status: "missing", detail: "Provide the recipient token account." },
    ],
  }, true);
  assert.match(text, /More details needed/);
  assert.match(text, /Please provide:/);
  assert.match(text, /1\. payment amount/);
  assert.doesNotMatch(text, /"action"/);
});

test("formatToolPresentation renders settled payment card", () => {
  process.env.CHAINPAY_APP_URL = "https://chainpay.example";
  const text = formatToolPresentation({
    action: "backend_relayed",
    status: "confirmed",
    signature: "Sig1111111111111111111111111111111111111111111111111111111111111111",
    receiptAddress: "Receipt111111111111111111111111111111111111111",
  });
  assert.match(text, /Payment settled/);
  assert.match(text, /verify\/Receipt/);
});

test("formatToolPresentation renders blocked x402 sponsor", () => {
  const text = formatToolPresentation({
    action: "x402_unsupported_sponsor",
    reason: "facilitator_required",
  }, true);
  assert.match(text, /unsupported sponsor/i);
  assert.match(text, /pay\.sh/);
});

test("toolResult content is formatted while structuredContent stays machine-readable", () => {
  const payload = {
    action: "requirements_ready",
    status: "ready",
    checks: [{ key: "limits", label: "Limits", status: "pass", detail: "Within per-payment limit." }],
  };
  const result = toolResult(payload);
  assert.deepEqual(result.structuredContent, payload);
  assert.notEqual(result.content[0].text, JSON.stringify(payload));
  assert.match(result.content[0].text, /Payment checks passed/);
});

// The fixtures above are flat objects. The tools do not emit flat objects: prepare_payment
// nests the amount and recipient under `payment` and emits no `display`, and
// execute_x402_payment nests the receipt and signature under `receipt` and `settlement`.
// A card that formats a hand-written fixture correctly and the real payload emptily is
// how the approval card shipped with no amount and no destination.

const MANDATE = "Mandate1111111111111111111111111111111111111";
const AGENT = "Agent111111111111111111111111111111111111111";
const RECIPIENT = "Recipient11111111111111111111111111111111111";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RECEIPT = "Receipt11111111111111111111111111111111111111";

/** The exact shape mcp-server/src/tools/prepare_payment.ts returns. */
const preparePaymentPayload = {
  action: "agent_signature_required",
  payment: {
    mandate: MANDATE,
    agent: AGENT,
    invoiceHash: "aa".repeat(32),
    paymentId: "bb".repeat(32),
    signatureReference: "cc".repeat(32),
    mint: MINT,
    recipient: RECIPIENT,
    amount: "100000",
  },
  receiptAddress: RECEIPT,
  preflight: { valid: true },
  requirements: { checks: [] },
  transaction: "base64-wire",
  unsignedTransaction: "base64-unsigned",
};

test("the approval card states the amount and destination from a real prepare_payment payload", () => {
  const text = formatToolPresentation(preparePaymentPayload);
  assert.match(text, /Approval required/);
  assert.match(text, /100000/, "the card must state the amount it is asking the owner to approve");
  assert.match(text, /Destination/);
  // Addresses are shortened to first4…last4, which is the point of the card.
  assert.match(text, new RegExp(`${RECIPIENT.slice(0, 4)}\u2026${RECIPIENT.slice(-4)}`), "the card must state where the money goes");
  assert.match(text, /Permission/);
  // Only base units are available here. Say so rather than passing one off as a human amount.
  assert.match(text, /base units/);
  assert.doesNotMatch(text, /base64/, "never surface wire transactions in the card");
});

/** The exact shape mcp-server/src/tools/x402.ts returns on a verified settlement. */
const x402SettledPayload = {
  action: "x402_verified",
  status: "confirmed",
  signingMode: "human",
  resource: "https://merchant.example/report.pdf",
  challenge: { protocol: "custom", invoiceHash: "dd".repeat(32) },
  settlement: { payment_id: "payment_1", status: "confirmed", signature: "SettledSignature1111111111111111111111111111" },
  receipt: { address: RECEIPT, mandate: MANDATE, agent: AGENT },
  proof: {},
  proofKind: "settled-receipt-pda",
  httpStatus: 200,
  resourceResponse: { delivered: true },
};

test("the settled card keeps the receipt, the signature and the verify link on a real x402 payload", () => {
  const text = formatToolPresentation(x402SettledPayload);
  assert.match(text, /Payment settled/);
  assert.match(text, /Receipt/, "the receipt address is nested under `receipt`, not top level");
  assert.match(text, /Signature/, "the signature is nested under `settlement`, not top level");
  assert.match(text, /verify/i, "a settled payment must hand back the public verify link");
  assert.match(text, /resource/i, "say that the merchant delivered");
});

test("a blocked result keeps the reason the preflight gave", () => {
  const text = formatToolPresentation({
    action: "x402_rejected_by_preflight",
    challenge: { protocol: "custom" },
    receiptAddress: RECEIPT,
    preflight: {
      valid: false,
      checks: [
        { key: "limits", label: "Per-payment limit", status: "fail", detail: "10 USDC requested against a 5 USDC cap." },
      ],
    },
  }, true);
  assert.match(text, /Stopped/);
  assert.match(text, /Per-payment limit/, "the owner must be told which check failed");
  assert.match(text, /5 USDC cap/);
});

test("formatToolPresentation renders spend overview and receipt list cards", () => {
  process.env.CHAINPAY_APP_URL = "https://chainpay.example";
  const overview = formatToolPresentation({
    kind: "spend_overview",
    owner: "Owner111111111111111111111111111111111111111",
    totals: [{ mint: MINT, symbol: "USDC", decimals: 6, spent: "4.5", remaining: "95.5", spentBase: "4500000", remainingBase: "95500000" }],
    mandates: [{
      address: MANDATE,
      status: "active",
      mint: MINT,
      symbol: "USDC",
      decimals: 6,
      spent: "4.5",
      remaining: "95.5",
      totalLimit: "100",
      maxPerPayment: "10",
      spentBase: "4500000",
      remainingBase: "95500000",
      totalLimitBase: "100000000",
      maxPerPaymentBase: "10000000",
      expiresAtSlot: "500000",
      approvedAgent: AGENT,
    }],
    receipts: [{
      address: RECEIPT,
      mandate: MANDATE,
      amount: "4.5",
      amountBase: "4500000",
      symbol: "USDC",
      decimals: 6,
      status: "confirmed",
      executedAtSlot: "200",
      recipientTokenAccount: RECIPIENT,
      receiptUrl: `https://chainpay.example/verify/${RECEIPT}`,
    }],
    attention: [],
    note: "Totals are mandate allowances, not wallet balance.",
  });
  assert.match(overview, /Spending overview/);
  assert.match(overview, /4\.5 USDC/);
  assert.match(overview, /verify/);
  assert.doesNotMatch(overview, /^\{/);

  const list = formatToolPresentation({
    kind: "receipt_list",
    owner: "Owner111111111111111111111111111111111111111",
    count: 1,
    receipts: [{
      address: RECEIPT,
      mandate: MANDATE,
      amount: "4.5",
      amountBase: "4500000",
      symbol: "USDC",
      decimals: 6,
      status: "confirmed",
      executedAtSlot: "200",
      recipientTokenAccount: RECIPIENT,
      receiptUrl: `https://chainpay.example/verify/${RECEIPT}`,
    }],
  });
  assert.match(list, /1 receipt/);
  assert.match(list, /4\.5 USDC/);
});

test("get_payment lookup renders the receipt card instead of fenced JSON", () => {
  process.env.CHAINPAY_APP_URL = "https://chainpay.example";
  const text = formatToolPresentation({
    found: true,
    receiptAddress: RECEIPT,
    onChain: { address: RECEIPT, mandate: MANDATE, status: "confirmed", transactionSignature: "Sig1111111111111111111111111111111111111111" },
    offChain: { transactionSignature: "Sig1111111111111111111111111111111111111111" },
    display: { symbol: "USDC", amounts: { amount: "4.5" } },
  });
  assert.match(text, /Payment receipt/);
  assert.match(text, /4\.5 USDC/);
  assert.match(text, /verify/);
  assert.doesNotMatch(text, /```json/);
});

test("an unsupported sponsor card does not promise a tool this server does not have", () => {
  const text = formatToolPresentation({
    action: "x402_unsupported_sponsor",
    message: "This challenge is recognized but unavailable.",
  }, true);
  assert.match(text, /pay\.sh panel/, "hand the owner to the dashboard panel that exists");
  assert.match(text, /do not retry/i);
  assert.doesNotMatch(text, /Use pay\.sh for/, "there is no pay.sh tool on this server to use");
});
