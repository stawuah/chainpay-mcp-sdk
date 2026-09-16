import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolOutcome, receiptUrlForAddress } from "../dist/outcome.js";

test("receipt URL uses CHAINPAY_APP_URL when configured", () => {
  const previous = process.env.CHAINPAY_APP_URL;
  process.env.CHAINPAY_APP_URL = "https://chainpay.example/";
  try {
    assert.equal(
      receiptUrlForAddress("2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1"),
      "https://chainpay.example/verify/2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
    );
    assert.equal(receiptUrlForAddress(undefined), undefined);
  } finally {
    if (previous === undefined) delete process.env.CHAINPAY_APP_URL;
    else process.env.CHAINPAY_APP_URL = previous;
  }
});

test("managed_payment_settled maps to payment_settled with receipt URL", () => {
  const previous = process.env.CHAINPAY_APP_URL;
  process.env.CHAINPAY_APP_URL = "https://chainpay.example";
  try {
    const outcome = normalizeToolOutcome({
      structuredContent: {
        action: "managed_payment_settled",
        status: "confirmed",
        signature: "sig-1",
        receiptAddress: "Receipt1111111111111111111111111111111111111",
        payment_id: "payment_abc",
      },
    });
    assert.equal(outcome?.kind, "payment_settled");
    assert.equal(outcome?.paymentId, "payment_abc");
    assert.match(outcome?.receiptUrl, /\/verify\//);
  } finally {
    if (previous === undefined) delete process.env.CHAINPAY_APP_URL;
    else process.env.CHAINPAY_APP_URL = previous;
  }
});

test("payment_pending and payment_terminal map to shared pending and settled outcomes", () => {
  const pending = normalizeToolOutcome({
    structuredContent: {
      action: "payment_pending",
      paymentId: "payment_pending_1",
      payment: { status: "submitted", receipt_address: "Receipt2222222222222222222222222222222222222" },
    },
  });
  assert.equal(pending?.kind, "payment_pending");
  assert.equal(pending?.receiptAddress, "Receipt2222222222222222222222222222222222222");

  const terminalFailed = normalizeToolOutcome({
    isError: true,
    structuredContent: { action: "payment_terminal", status: "failed", receiptAddress: "Receipt3333333333333333333333333333333333333" },
  });
  assert.equal(terminalFailed?.kind, "payment_blocked");

  const terminalConfirmed = normalizeToolOutcome({
    structuredContent: {
      action: "payment_terminal",
      status: "confirmed",
      signature: "sig-2",
      receiptAddress: "Receipt4444444444444444444444444444444444444",
    },
  });
  assert.equal(terminalConfirmed?.kind, "payment_settled");
});

test("x402 actions map to blocked, pending, settled, and approval outcomes", () => {
  assert.equal(normalizeToolOutcome({ isError: true, structuredContent: { action: "x402_rejected_by_preflight" } })?.kind, "payment_blocked");
  assert.equal(normalizeToolOutcome({ structuredContent: { action: "x402_payment_pending", status: "submitted" } })?.kind, "payment_pending");
  assert.equal(normalizeToolOutcome({
    structuredContent: {
      action: "x402_verified",
      status: "confirmed",
      signature: "sig-3",
      receiptAddress: "Receipt5555555555555555555555555555555555555",
      httpStatus: 200,
    },
  })?.kind, "payment_settled");
  assert.equal(normalizeToolOutcome({
    structuredContent: { action: "x402_agent_signature_required", receiptAddress: "Receipt6666666666666666666666666666666666666" },
  })?.kind, "payment_approval_required");
  assert.equal(normalizeToolOutcome({
    isError: true,
    structuredContent: { action: "x402_agent_signature_required", receiptAddress: "Receipt6666666666666666666666666666666666666" },
  })?.kind, "payment_blocked");
});

test("rejected_by_preflight never maps to payment approval", () => {
  const outcome = normalizeToolOutcome({
    isError: true,
    structuredContent: {
      action: "rejected_by_preflight",
      receiptAddress: "Receipt7777777777777777777777777777777777777",
      requirements: { status: "blocked" },
    },
  });
  assert.equal(outcome?.kind, "payment_blocked");
});
