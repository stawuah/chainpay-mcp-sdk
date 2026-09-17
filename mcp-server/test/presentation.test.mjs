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
