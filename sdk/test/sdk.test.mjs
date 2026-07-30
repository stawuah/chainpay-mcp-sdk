import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  buildCreateMandateInstruction,
  buildExecutePaymentInstruction,
  deriveMandateAddress,
  deriveReceiptAddress,
  preflightPayment,
  preparePayment,
} from "../dist/index.js";

const owner = Keypair.generate().publicKey.toBase58();
const agent = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const source = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const mandateAddress = deriveMandateAddress(owner);

test("builds Anchor-compatible mandate and payment instruction shapes", () => {
  const mandate = buildCreateMandateInstruction({
    approvedAgent: agent,
    sourceTokenAccount: source,
    allowedMint: mint,
    allowedRecipient: recipient,
    maxPerPayment: 10n,
    totalLimit: 100n,
    expiresAtSlot: 10_000n,
    tokenProgram: "spl-token",
  }, owner);
  assert.equal(mandate.name, "create_mandate");
  assert.equal(mandate.keys.length, 8);
  assert.equal(mandate.data.length, 160);
  assert.equal(mandate.keys[2].isSigner, true);

  const request = preparePayment({
    mandate: mandateAddress,
    invoiceHash: Uint8Array.of(...Array(32).fill(1)),
    paymentId: Uint8Array.of(...Array(32).fill(2)),
    signatureReference: Uint8Array.of(...Array(32).fill(3)),
    mint,
    recipient,
    amount: 10n,
    tokenProgram: "spl-token",
  });
  const loadedMandate = {
    address: mandateAddress,
    owner,
    approvedAgent: agent,
    sourceTokenAccount: source,
    allowedMint: mint,
    allowedRecipient: recipient,
    maxPerPayment: 10n,
    totalLimit: 100n,
    amountSpent: 0n,
    paymentCount: 0n,
    expiresAtSlot: 10_000n,
    paused: false,
    revoked: false,
    status: "active",
    tokenProgram: "spl-token",
  };
  const payment = buildExecutePaymentInstruction(request, agent, loadedMandate);
  assert.equal(payment.name, "execute_payment");
  assert.equal(payment.keys.length, 9);
  assert.equal(payment.data.length, 112);
  assert.equal(deriveReceiptAddress(mandateAddress, request.invoiceHash).length, 44);
});

test("preflight rejects an agent or recipient outside the mandate", () => {
  const request = preparePayment({
    mandate: mandateAddress,
    invoiceHash: Uint8Array.of(...Array(32).fill(1)),
    paymentId: Uint8Array.of(...Array(32).fill(2)),
    signatureReference: Uint8Array.of(...Array(32).fill(3)),
    mint,
    recipient,
    amount: 10n,
  });
  const checks = preflightPayment(request, {
    address: mandateAddress,
    owner,
    approvedAgent: agent,
    sourceTokenAccount: source,
    allowedMint: mint,
    allowedRecipient: recipient,
    maxPerPayment: 10n,
    totalLimit: 100n,
    amountSpent: 0n,
    paymentCount: 0n,
    expiresAtSlot: 10_000n,
    paused: false,
    revoked: false,
    status: "active",
  }, 100n, owner);
  assert.equal(checks.valid, false);
  assert.equal(checks.checks.find((item) => item.name === "approved_agent")?.ok, false);
});
