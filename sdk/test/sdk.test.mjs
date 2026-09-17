import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildCreateMandateInstruction,
  buildExecutePaymentInstruction,
  buildInitializeConfigInstruction,
  deriveAssociatedTokenAddress,
  deriveLegacyMandateAddress,
  deriveMandateAddress,
  deriveMintMandateAddress,
  deriveVersionedMandateAddress,
  deriveReceiptAddress,
  deriveX402PaymentReferences,
  preflightPayment,
  preflightPaymentBatch,
  preparePayment,
} from "../dist/index.js";

const owner = Keypair.generate().publicKey.toBase58();
const agent = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const source = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const nonceBytes = new Uint8Array(32);
nonceBytes.set([67, 80, 78, 79, 78, 67, 69, 33]);
nonceBytes[8] = 1;
const versionedNonce = new PublicKey(nonceBytes).toBase58();
const mandateAddress = deriveVersionedMandateAddress(owner, mint, versionedNonce);

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
    mandateNonce: versionedNonce,
  }, owner);
  assert.equal(mandate.name, "create_mandate");
  assert.equal(mandate.keys.length, 8);
  assert.equal(mandate.data.length, 176);
  assert.equal(mandate.keys[2].address, mandateAddress);
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
  // A base58-encoded 32-byte address is 43 or 44 characters. Assert the property
  // that matters: it decodes back to 32 bytes and round-trips through base58.
  const receiptAddress = deriveReceiptAddress(mandateAddress, request.invoiceHash);
  assert.equal(new PublicKey(receiptAddress).toBytes().length, 32);
  assert.equal(new PublicKey(receiptAddress).toBase58(), receiptAddress);
});

test("keeps legacy mandate derivation available while scoping new mandates by mint", () => {
  assert.equal(deriveMandateAddress(owner), deriveLegacyMandateAddress(owner));
  assert.equal(deriveMandateAddress(owner, undefined, mint), deriveMintMandateAddress(owner, mint));
  assert.notEqual(deriveLegacyMandateAddress(owner), deriveMintMandateAddress(owner, mint));
  assert.notEqual(deriveVersionedMandateAddress(owner, mint, versionedNonce), deriveMintMandateAddress(owner, mint));
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

test("derives the canonical Token-2022 associated token account", () => {
  const wallet = "FmFHfuMx1U6sjKKsuD9SrFedspnAuTUki1KPKjWbehkU";
  const pyusd = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
  assert.equal(
    deriveAssociatedTokenAddress(wallet, pyusd, "token-2022"),
    "HC7kZ6CXs5JQS2CDmGh9ADjkyNdibX5HDe3pcspvs65g",
  );
});

test("keeps x402 client and merchant references on one canonical hash", async () => {
  const references = await deriveX402PaymentReferences({
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    recipient: "EA8QyhmtjjBhEwdzPCwmjLcN9SqU7LwR2eFfcN7p23Jm",
    amount: "100000",
    resource: "http://127.0.0.1:3402/data",
    tokenProgram: "spl-token",
  });
  assert.deepEqual(references, {
    nonce: "9f3279a23a50a08337257f7f6aa1a991",
    invoiceHash: "899cb334272fed4cb80a9afeafb180134bbe1a394669107c10b998a6383b3803",
    paymentId: "6cd07625b56e30e3a54afe12675d72a3b225b6c7e2ace0bdc4b0fadc64669a29",
    signatureReference: "cd5285b2bd499abd120849a99ebe9ca55685eddc75e49ca2541179cb1e2960e7",
  });
});

test("rejects caller-supplied Token-2022 extension accounts", () => {
  const extensionAccount = Keypair.generate().publicKey.toBase58();
  assert.throws(() => preparePayment({
      mandate: mandateAddress,
      invoiceHash: Uint8Array.of(...Array(32).fill(4)),
      paymentId: Uint8Array.of(...Array(32).fill(5)),
      signatureReference: Uint8Array.of(...Array(32).fill(6)),
      mint,
      recipient,
      amount: 10n,
      tokenProgram: "token-2022",
      remainingAccounts: [{ address: extensionAccount, isSigner: false, isWritable: true }],
    }), /Caller-supplied remainingAccounts are not accepted/);
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

test("preflight adds source-account checks only when context is supplied", () => {
  const request = preparePayment({
    mandate: mandateAddress,
    invoiceHash: Uint8Array.of(...Array(32).fill(1)),
    paymentId: Uint8Array.of(...Array(32).fill(2)),
    signatureReference: Uint8Array.of(...Array(32).fill(3)),
    mint,
    recipient,
    amount: 10n,
  });
  const mandate = {
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
  };
  const withoutContext = preflightPayment(request, mandate, 100n, agent);
  assert.equal(withoutContext.checks.some((item) => item.name === "source_balance"), false);
  assert.equal(withoutContext.checks.some((item) => item.name === "delegate_identity"), false);

  const withContext = preflightPayment(request, mandate, 100n, agent, false, {
    sourceBalance: 100n,
    sourceOwner: owner,
    delegate: mandateAddress,
    delegatedAmount: 50n,
  });
  assert.equal(withContext.valid, true);
  assert.equal(withContext.checks.find((item) => item.name === "source_balance")?.ok, true);
  assert.equal(withContext.checks.find((item) => item.name === "delegate_identity")?.ok, true);
  assert.equal(withContext.checks.find((item) => item.name === "delegated_amount")?.ok, true);

  const insufficient = preflightPayment(request, mandate, 100n, agent, false, {
    sourceBalance: 5n,
    sourceOwner: owner,
    delegate: mandateAddress,
    delegatedAmount: 50n,
  });
  assert.equal(insufficient.valid, false);
  assert.equal(insufficient.checks.find((item) => item.name === "source_balance")?.ok, false);
});

test("preflightPaymentBatch rejects individually valid rows that exceed cumulative limits", () => {
  const mandate = {
    address: mandateAddress,
    owner,
    approvedAgent: agent,
    sourceTokenAccount: source,
    allowedMint: mint,
    maxPerPayment: 50n,
    totalLimit: 100n,
    amountSpent: 90n,
    paymentCount: 0n,
    expiresAtSlot: 10_000n,
    maxPaymentCount: 0n,
    cooldownSlots: 0n,
    lastPaymentSlot: 0n,
    paused: false,
    revoked: false,
    status: "active",
  };
  const makeRequest = (invoiceByte) => preparePayment({
    mandate: mandateAddress,
    invoiceHash: Uint8Array.of(...Array(31).fill(1), invoiceByte),
    paymentId: Uint8Array.of(...Array(32).fill(2)),
    signatureReference: Uint8Array.of(...Array(32).fill(3)),
    mint,
    recipient,
    amount: 10n,
  });
  const sourceContext = {
    sourceBalance: 100n,
    sourceOwner: owner,
    delegate: mandateAddress,
    delegatedAmount: 100n,
  };
  const batch = preflightPaymentBatch([
    { request: makeRequest(4), mandate, agent, sourceContext },
    { request: makeRequest(5), mandate, agent, sourceContext },
  ], 100n);
  assert.equal(batch.entries.every((entry) => entry.preflight.valid), true);
  assert.equal(batch.valid, false);
  assert.equal(batch.batchChecks.find((item) => item.name === "batch_total_limit")?.ok, false);
});
