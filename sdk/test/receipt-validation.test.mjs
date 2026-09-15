import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATORS,
  ChainPayClient,
  DEFAULT_PROGRAM_ID,
  RECEIPT_ACCOUNT_LENGTH,
  RECEIPT_STATUS_SETTLED,
  SPL_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  assemblePublicReceiptProof,
  decodeCurrentMandateFields,
  deriveReceiptAddress,
  formatExactTokenAmount,
  readCurrentMandateFields,
  readPaymentReceiptAccount,
  readPublicSettledReceipt,
  readVerifiedMintDecimals,
} from "../dist/index.js";

const RECEIPT_DISC = ACCOUNT_DISCRIMINATORS.paymentReceipt;
const MANDATE_DISC = ACCOUNT_DISCRIMINATORS.paymentMandate;

function encodeReceipt({
  mandate,
  invoiceHash,
  paymentId = Buffer.alloc(32, 2),
  mint,
  source,
  recipient,
  amount = 1_000_000n,
  agent,
  slot = 99n,
  signatureReference = Buffer.alloc(32, 3),
  status = RECEIPT_STATUS_SETTLED,
  bump,
}) {
  const data = Buffer.alloc(RECEIPT_ACCOUNT_LENGTH);
  data.set(RECEIPT_DISC);
  data.set(new PublicKey(mandate).toBytes(), 8);
  data.set(invoiceHash, 40);
  data.set(paymentId, 72);
  data.set(new PublicKey(mint).toBytes(), 104);
  data.set(new PublicKey(source).toBytes(), 136);
  data.set(new PublicKey(recipient).toBytes(), 168);
  data.writeBigUInt64LE(amount, 200);
  data.set(new PublicKey(agent).toBytes(), 208);
  data.writeBigUInt64LE(slot, 240);
  data.set(signatureReference, 248);
  data[280] = status;
  data[281] = bump;
  return data;
}

function settledFixture() {
  const mandate = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const source = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const agent = Keypair.generate().publicKey.toBase58();
  const invoiceHash = Buffer.alloc(32, 1);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), new PublicKey(mandate).toBytes(), invoiceHash],
    new PublicKey(DEFAULT_PROGRAM_ID),
  );
  const address = pda.toBase58();
  assert.equal(deriveReceiptAddress(mandate, invoiceHash, DEFAULT_PROGRAM_ID), address);
  const data = encodeReceipt({ mandate, invoiceHash, mint, source, recipient, agent, bump });
  return {
    mandate,
    mint,
    source,
    recipient,
    agent,
    invoiceHash,
    address,
    bump,
    data,
    account: { address, owner: DEFAULT_PROGRAM_ID, data },
  };
}

function encodeMandate({ owner, agent, source, mint, expiresAtSlot = 10_000n }) {
  const data = Buffer.alloc(235);
  data.set(MANDATE_DISC);
  data.set(new PublicKey(owner).toBytes(), 8);
  data.set(new PublicKey(agent).toBytes(), 40);
  data.set(new PublicKey(source).toBytes(), 72);
  data.set(new PublicKey(mint).toBytes(), 104);
  data.writeBigUInt64LE(10n, 168);
  data.writeBigUInt64LE(100n, 176);
  data.writeBigUInt64LE(expiresAtSlot, 200);
  return data;
}

test("validates a settled program-owned receipt PDA", () => {
  const fixture = settledFixture();
  const result = readPublicSettledReceipt(fixture.account);
  assert.equal(result.valid, true);
  assert.equal(result.settled, true);
  assert.equal(result.derivedAddress, fixture.address);
  assert.equal(result.receipt.mandate, fixture.mandate);
  assert.equal(result.receipt.amount, 1_000_000n);
  assert.equal(result.receipt.status, "confirmed");
  assert.equal(result.receipt.signatureReference.length, 32);
  assert.notEqual(result.receipt.signatureReference, undefined);
});

test("rejects a receipt owned by another program", () => {
  const fixture = settledFixture();
  const result = readPaymentReceiptAccount({
    ...fixture.account,
    owner: SYSTEM_PROGRAM_ID,
  }, { requireSettled: true });
  assert.equal(result.valid, false);
  assert.equal(result.code, "wrong_owner");
});

test("rejects a wrong receipt discriminator", () => {
  const fixture = settledFixture();
  const data = Buffer.from(fixture.data);
  data[0] ^= 1;
  const result = readPaymentReceiptAccount({ ...fixture.account, data });
  assert.equal(result.valid, false);
  assert.equal(result.code, "wrong_discriminator");
});

test("rejects a receipt whose address is not the derived PDA", () => {
  const fixture = settledFixture();
  const result = readPaymentReceiptAccount({
    ...fixture.account,
    address: Keypair.generate().publicKey.toBase58(),
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, "pda_mismatch");
});

test("rejects an unsettled receipt on the public reader", () => {
  const fixture = settledFixture();
  const data = encodeReceipt({
    mandate: fixture.mandate,
    invoiceHash: fixture.invoiceHash,
    mint: fixture.mint,
    source: fixture.source,
    recipient: fixture.recipient,
    agent: fixture.agent,
    bump: fixture.bump,
    status: 0,
  });
  const lookup = readPaymentReceiptAccount({ ...fixture.account, data });
  assert.equal(lookup.valid, true);
  assert.equal(lookup.settled, false);
  assert.equal(lookup.receipt.status, "failed");
  const publicRead = readPublicSettledReceipt({ ...fixture.account, data });
  assert.equal(publicRead.valid, false);
  assert.equal(publicRead.code, "unsettled");
});

test("rejects truncated receipt account data", () => {
  const fixture = settledFixture();
  const truncated = fixture.data.subarray(0, 80);
  const result = readPaymentReceiptAccount({ ...fixture.account, data: truncated });
  assert.equal(result.valid, false);
  assert.equal(result.code, "truncated");
});

test("does not treat signature_reference as seller delivery", () => {
  const fixture = settledFixture();
  const result = readPublicSettledReceipt(fixture.account);
  assert.equal(result.valid, true);
  assert.equal(Object.hasOwn(result, "delivered"), false);
  assert.equal(Object.hasOwn(result.receipt, "sellerAttestation"), false);
  assert.ok(result.receipt.signatureReference.every((byte) => byte === 3));
});

test("formats exact amounts and withholds UI decimals until mint owner is verified", () => {
  const max = 18_446_744_073_709_551_615n;
  assert.equal(formatExactTokenAmount(max, null).display, max.toString());
  assert.equal(formatExactTokenAmount(max, null).displayKind, "base-units");
  assert.equal(formatExactTokenAmount(1_000_000n, 6).display, "1.000000");
  assert.equal(formatExactTokenAmount(123n, 2).display, "1.23");
  assert.equal(formatExactTokenAmount(100n, 0).display, "100");

  const owned = Buffer.alloc(45, 9);
  owned[44] = 6;
  assert.deepEqual(readVerifiedMintDecimals({ owner: SPL_TOKEN_PROGRAM_ID, data: owned }), {
    ok: true,
    decimals: 6,
  });

  const impostor = Buffer.alloc(45, 6);
  impostor[44] = 6;
  assert.deepEqual(readVerifiedMintDecimals({ owner: SYSTEM_PROGRAM_ID, data: impostor }), {
    ok: false,
    reason: "unsupported_owner",
  });
  assert.equal(formatExactTokenAmount(1_000_000n, null).display, "1000000");
});

test("optional mandate enrichment does not require history or source metadata", () => {
  const fixture = settledFixture();
  const owner = Keypair.generate().publicKey.toBase58();
  const mandateData = encodeMandate({
    owner,
    agent: fixture.agent,
    source: fixture.source,
    mint: fixture.mint,
  });
  const decoded = decodeCurrentMandateFields(mandateData, fixture.mandate, 50n);
  assert.equal(decoded.owner, owner);
  assert.equal(decoded.maxPerPayment, 10n);
  assert.equal(decoded.createdAt, undefined);
  assert.equal(decoded.createdAtSlot, undefined);
  assert.equal(decoded.tokenProgram, undefined);

  const proof = assemblePublicReceiptProof({
    receiptAccount: fixture.account,
    mandateAccount: { address: fixture.mandate, owner: DEFAULT_PROGRAM_ID, data: mandateData },
    mintAccount: { owner: SYSTEM_PROGRAM_ID, data: Buffer.alloc(45, 6) },
    currentSlot: 50n,
  });
  assert.equal(proof.receipt.valid, true);
  assert.equal(proof.currentMandate.status, "present");
  assert.equal(proof.currentMandate.mandate.tokenProgram, undefined);
  assert.equal(proof.amount.displayKind, "base-units");
  assert.equal(proof.amount.display, "1000000");

  const missing = assemblePublicReceiptProof({
    receiptAccount: fixture.account,
    mandateAccount: null,
  });
  assert.equal(missing.receipt.valid, true);
  assert.equal(missing.currentMandate.status, "absent");

  const unavailable = readCurrentMandateFields({
    address: fixture.mandate,
    owner: SYSTEM_PROGRAM_ID,
    data: mandateData,
  });
  assert.equal(unavailable.status, "unavailable");
});

test("client current-mandate helper never pages creation history", async () => {
  const client = new ChainPayClient({ rpcUrl: "http://127.0.0.1:1" });
  const mandate = Keypair.generate().publicKey.toBase58();
  const data = encodeMandate({
    owner: Keypair.generate().publicKey.toBase58(),
    agent: Keypair.generate().publicKey.toBase58(),
    source: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
  });
  client.getCurrentSlot = async () => 1_000n;
  client.getProgramAccount = async () => ({ address: mandate, data });
  client.connection.getSignaturesForAddress = async () => {
    throw new Error("creation history must not be requested for public mandate enrichment");
  };
  client.connection.getAccountInfo = async () => {
    throw new Error("source token metadata must not be requested for public mandate enrichment");
  };
  const result = await client.getCurrentMandateFields(mandate);
  assert.equal(result.status, "present");
  assert.equal(result.mandate.createdAt, undefined);
  assert.equal(result.mandate.tokenProgram, undefined);
});
