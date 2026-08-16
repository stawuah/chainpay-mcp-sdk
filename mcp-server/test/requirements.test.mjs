import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID } from "@chainpay/sdk";
import { checkPaymentRequirements } from "../dist/tools/check_payment_requirements.js";

test("requirements check returns the exact missing payment details", async () => {
  const result = await checkPaymentRequirements({ client: {} }, {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action, "details_required");
  assert.equal(result.structuredContent.requirements.status, "needs_details");
  assert.deepEqual(
    result.structuredContent.requirements.checks.map((check) => [check.key, check.status]),
    [
      ["limits", "missing"],
      ["token", "missing"],
      ["recipient", "missing"],
      ["expiry", "missing"],
      ["policy", "missing"],
    ],
  );
  assert.ok(result.structuredContent.requirements.missing.some((item) => item.includes("payment amount")));
});

test("requirements check groups a passing preflight into the five AI gates", async () => {
  const mandate = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const agent = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const checks = [
    "mandate_status", "approved_agent", "mint", "recipient", "amount_positive",
    "per_payment_limit", "total_limit", "payment_count_limit", "cooldown", "expiry",
    "invoice_hash", "payment_id", "signature_reference", "duplicate_invoice", "token_program",
  ].map((name) => ({ name, ok: true, message: `${name} passed` }));
  const result = await checkPaymentRequirements({
    client: {
      getSupportedAsset: async () => ({ tokenProgram: SPL_TOKEN_PROGRAM_ID, enabled: true }),
      preparePayment: async () => ({
        receiptAddress: Keypair.generate().publicKey.toBase58(),
        preflight: { valid: true, currentSlot: 100n, checks },
      }),
    },
  }, {
    mandate,
    agent,
    invoiceHash: "11".repeat(32),
    paymentId: "22".repeat(32),
    signatureReference: "33".repeat(32),
    mint,
    tokenProgram: "spl-token",
    recipient,
    amount: "10",
  });
  assert.equal(result.structuredContent.requirements.status, "ready");
  assert.deepEqual(result.structuredContent.requirements.checks.map((check) => check.key), [
    "limits", "token", "recipient", "expiry", "policy",
  ]);
  assert.ok(result.structuredContent.requirements.checks.every((check) => check.status === "pass"));
  assert.equal(result.structuredContent.requirements.missing.length, 0);
  assert.equal(result.structuredContent.request.amount, "10");
});
