import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  buildCreateMandateInstruction,
  buildExecutePaymentInstruction,
  buildInitializeConfigInstruction,
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
    maxPerPayment: 10n,
    totalLimit: 100n,
    expiresAtSlot: 10_000n,
    maxPaymentCount: 0n,
    cooldownSlots: 0n,
    tokenProgram: "spl-token",
  }, owner);
  assert.equal(mandate.name, "create_mandate");
  assert.equal(mandate.keys.length, 8);
  assert.equal(mandate.data.length, 144);
  assert.equal(mandate.keys[3].isSigner, true);

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
    maxPerPayment: 10n,
    totalLimit: 100n,
    amountSpent: 0n,
    paymentCount: 0n,
    expiresAtSlot: 10_000n,
    maxPaymentCount: 0n,
    cooldownSlots: 0n,
    lastPaymentSlot: 0n,
    paused: false,
    revoked: false,
    status: "active",
    tokenProgram: "spl-token",
  };
  const payment = buildExecutePaymentInstruction(request, agent, loadedMandate);
  assert.equal(payment.name, "execute_payment");
  assert.equal(payment.keys.length, 10);
  assert.equal(payment.data.length, 112);
  assert.equal(deriveReceiptAddress(mandateAddress, request.invoiceHash).length, 44);
});

test("builds the one-time protocol config initializer", () => {
  const supportedMints = [mint, Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  const initialize = buildInitializeConfigInstruction(supportedMints, owner);
  assert.equal(initialize.name, "initialize_config");
  assert.equal(initialize.keys.length, 3);
  assert.equal(initialize.keys[0].isWritable, true);
  assert.equal(initialize.keys[1].isSigner, true);
  assert.equal(initialize.data.length, 104);
});

test("carries Token-2022 extension accounts through settlement", () => {
  const extensionAccount = Keypair.generate().publicKey.toBase58();
  const request = preparePayment({
    mandate: mandateAddress,
    invoiceHash: Uint8Array.of(...Array(32).fill(4)),
    paymentId: Uint8Array.of(...Array(32).fill(5)),
    signatureReference: Uint8Array.of(...Array(32).fill(6)),
    mint,
    recipient,
    amount: 10n,
    tokenProgram: "token-2022",
    remainingAccounts: [{ address: extensionAccount, isSigner: false, isWritable: true }],
  });
  const instruction = buildExecutePaymentInstruction(request, agent, {
    address: mandateAddress,
    owner,
    approvedAgent: agent,
    sourceTokenAccount: source,
    allowedMint: mint,
    maxPerPayment: 10n,
    totalLimit: 100n,
    amountSpent: 0n,
    paymentCount: 0n,
    expiresAtSlot: 10_000n,
    maxPaymentCount: 0n,
    cooldownSlots: 0n,
    lastPaymentSlot: 0n,
    paused: false,
    revoked: false,
    status: "active",
    tokenProgram: "token-2022",
  });
  assert.equal(instruction.keys.length, 11);
  assert.equal(instruction.keys.at(-1)?.address, extensionAccount);
});

test("preflight rejects an unapproved agent while accepting a per-payment recipient", () => {
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
    maxPerPayment: 10n,
    totalLimit: 100n,
    amountSpent: 0n,
    paymentCount: 0n,
    expiresAtSlot: 10_000n,
    maxPaymentCount: 0n,
    cooldownSlots: 0n,
    lastPaymentSlot: 0n,
    paused: false,
    revoked: false,
    status: "active",
  }, 100n, owner);
  assert.equal(checks.valid, false);
  assert.equal(checks.checks.find((item) => item.name === "approved_agent")?.ok, false);
  assert.equal(checks.checks.find((item) => item.name === "recipient")?.ok, true);
});
