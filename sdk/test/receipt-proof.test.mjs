import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATORS,
  ChainPayClient,
  DEFAULT_PROGRAM_ID,
  DUPLICATE_INVOICE_MESSAGE,
  DuplicateInvoiceError,
  RECEIPT_ACCOUNT_LENGTH,
  RECEIPT_ACCOUNT_LENGTH_V2,
  RECEIPT_CSV_HEADERS,
  buildOpsSnapshot,
  canonicalPaymentRequest,
  csvCell,
  decodePaymentReceipt,
  isDuplicateInvoiceError,
  readPaymentReceiptAccount,
  receiptPolicy,
  receiptsToCsv,
  relayObservedPolicy,
  verifyPaymentRequest,
  verifyReceiptPurchase,
} from "../dist/index.js";

const SNAPSHOT = {
  maxPerPayment: 5_000_000n,
  totalLimit: 50_000_000n,
  amountSpentAfter: 12_000_000n,
  paymentCountAfter: 3n,
  maxPaymentCount: 10n,
  expiresAtSlot: 9_000n,
  cooldownSlots: 25n,
};

function key(seed) {
  return new PublicKey(Buffer.alloc(32, seed)).toBase58();
}

/** Receipt bytes at either size. `snapshotVersion` writes the v2 tail. */
function receiptBytes({ length, invoiceHash, mandate = key(1), amount = 4_500_000n, snapshotVersion }) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), new PublicKey(mandate).toBytes(), invoiceHash],
    new PublicKey(DEFAULT_PROGRAM_ID),
  );
  const data = Buffer.alloc(length);
  data.set(ACCOUNT_DISCRIMINATORS.paymentReceipt);
  data.set(new PublicKey(mandate).toBytes(), 8);
  data.set(invoiceHash, 40);
  data.set(Buffer.alloc(32, 2), 72);
  data.set(new PublicKey(key(5)).toBytes(), 104);
  data.set(new PublicKey(key(6)).toBytes(), 136);
  data.set(new PublicKey(key(7)).toBytes(), 168);
  data.writeBigUInt64LE(amount, 200);
  data.set(new PublicKey(key(4)).toBytes(), 208);
  data.writeBigUInt64LE(77n, 240);
  data.set(Buffer.alloc(32, 3), 248);
  data[280] = 1;
  data[281] = bump;
  if (snapshotVersion !== undefined) {
    data[282] = snapshotVersion;
    Object.values(SNAPSHOT).forEach((value, index) => data.writeBigUInt64LE(value, 283 + index * 8));
  }
  return { address: address.toBase58(), data };
}

test("an original 282-byte receipt decodes with no policy snapshot", () => {
  const { address, data } = receiptBytes({ length: RECEIPT_ACCOUNT_LENGTH, invoiceHash: Buffer.alloc(32, 9) });
  const receipt = decodePaymentReceipt(data, address);
  assert.equal(receipt.policySnapshot, null);
  assert.equal(receipt.amount, 4_500_000n);
  assert.deepEqual(receiptPolicy(receipt), { source: "not-recorded" });
});

test("a 371-byte receipt decodes its policy snapshot at the documented offsets", () => {
  assert.equal(RECEIPT_ACCOUNT_LENGTH_V2, 371);
  const { address, data } = receiptBytes({
    length: RECEIPT_ACCOUNT_LENGTH_V2,
    invoiceHash: Buffer.alloc(32, 9),
    snapshotVersion: 1,
  });
  const read = readPaymentReceiptAccount({ address, owner: DEFAULT_PROGRAM_ID, data }, { requireSettled: true });
  assert.equal(read.valid, true);
  assert.deepEqual(read.receipt.policySnapshot, { version: 1, ...SNAPSHOT });
  // Original fields keep their offsets in the longer account.
  assert.equal(read.receipt.amount, 4_500_000n);
  assert.equal(read.receipt.executedAtSlot, 77n);
  assert.deepEqual(receiptPolicy(read.receipt), { source: "on-chain", limits: SNAPSHOT });
});

test("a 371-byte receipt with snapshot version 0 has no snapshot", () => {
  const { address, data } = receiptBytes({
    length: RECEIPT_ACCOUNT_LENGTH_V2,
    invoiceHash: Buffer.alloc(32, 9),
    snapshotVersion: 0,
  });
  assert.equal(decodePaymentReceipt(data, address).policySnapshot, null);
});

test("receipt history asks for both receipt sizes and keeps each receipt once", async () => {
  const client = new ChainPayClient({ rpcUrl: "http://127.0.0.1:1" });
  const mandate = key(1);
  const original = receiptBytes({ length: RECEIPT_ACCOUNT_LENGTH, invoiceHash: Buffer.alloc(32, 10), mandate });
  const upgraded = receiptBytes({
    length: RECEIPT_ACCOUNT_LENGTH_V2,
    invoiceHash: Buffer.alloc(32, 11),
    mandate,
    snapshotVersion: 1,
  });
  const asAccount = ({ address, data }) => ({
    pubkey: new PublicKey(address),
    account: { owner: new PublicKey(DEFAULT_PROGRAM_ID), data },
  });
  const sizes = [];
  client.connection.getProgramAccounts = async (_program, options) => {
    const size = options.filters.find((filter) => filter.dataSize)?.dataSize;
    assert.equal(options.filters.find((filter) => filter.memcmp).memcmp.bytes, mandate);
    sizes.push(size);
    // A node that ignores dataSize must not produce duplicate rows.
    return size === RECEIPT_ACCOUNT_LENGTH ? [asAccount(original), asAccount(upgraded)] : [asAccount(upgraded)];
  };
  client.connection.getSignaturesForAddress = async () => [];
  const receipts = await client.getPaymentsByMandate(mandate);
  assert.deepEqual(sizes.sort(), [RECEIPT_ACCOUNT_LENGTH, RECEIPT_ACCOUNT_LENGTH_V2]);
  assert.equal(receipts.length, 2);
  assert.equal(receipts.find((receipt) => receipt.address === upgraded.address).policySnapshot.version, 1);
  assert.equal(receipts.find((receipt) => receipt.address === original.address).policySnapshot, null);
});

const merchant = Keypair.fromSeed(Buffer.alloc(32, 42));
const merchantKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 42)]),
  format: "der",
  type: "pkcs8",
});

function signRequest(payload) {
  const signature = sign(null, Buffer.from(canonicalPaymentRequest(payload)), merchantKey).toString("base64");
  return { payload, signature };
}

const BASE_PAYLOAD = {
  version: 1,
  cluster: "devnet",
  merchant: merchant.publicKey.toBase58(),
  invoice: "PO-1042",
  mint: key(5),
  tokenProgram: "spl-token",
  recipient: key(7),
  amount: "4500000",
  decimals: 6,
  nonce: "nonce-1",
};

test("a request without description or line items hashes exactly as before", async () => {
  const canonical = canonicalPaymentRequest({ ...BASE_PAYLOAD, resource: "https://merchant.example/r" });
  // The pre-change canonical form, written out by hand.
  assert.equal(
    canonical,
    `{"version":1,"cluster":"devnet","merchant":"${BASE_PAYLOAD.merchant}","invoice":"PO-1042","mint":"${key(5)}",`
      + `"tokenProgram":"spl-token","recipient":"${key(7)}","amount":"4500000","decimals":6,"nonce":"nonce-1",`
      + `"resource":"https://merchant.example/r"}`,
  );
  const verification = await verifyPaymentRequest(signRequest({ ...BASE_PAYLOAD, resource: "https://merchant.example/r" }));
  assert.equal(verification.valid, true);
  assert.equal(
    Buffer.from(verification.invoiceHash).toString("hex"),
    createHash("sha256").update(canonical).digest("hex"),
  );
});

test("description and line items are signed in a fixed order after resource", async () => {
  const payload = {
    ...BASE_PAYLOAD,
    // Caller key order must not matter.
    lineItems: [{ quantity: "2", label: "Widget", amount: "2250000" }],
    description: "Two \"widgets\", boxed",
  };
  const canonical = canonicalPaymentRequest(payload);
  assert.ok(canonical.endsWith(
    `"nonce":"nonce-1","description":"Two \\"widgets\\", boxed","lineItems":[{"label":"Widget","amount":"2250000","quantity":"2"}]}`,
  ));
  assert.equal((await verifyPaymentRequest(signRequest(payload))).valid, true);
});

test("description and line item bounds are enforced", async () => {
  const cases = [
    [{ description: "x".repeat(281) }, /Description must be 1 to 280/],
    [{ description: "   " }, /Description must be 1 to 280/],
    [{ description: "two\nlines" }, /single line/],
    [{ lineItems: [] }, /1 to 20 items/],
    [{ lineItems: Array.from({ length: 21 }, () => ({ label: "x" })) }, /1 to 20 items/],
    [{ lineItems: [{ label: "x".repeat(121) }] }, /label/],
    [{ lineItems: [{ label: "x", amount: "4.50" }] }, /base units/],
    [{ lineItems: [{ label: "x", quantity: "1." }] }, /quantity/],
    [{ lineItems: "not a list" }, /1 to 20 items/],
  ];
  for (const [extra, reason] of cases) {
    const result = await verifyPaymentRequest(signRequest({ ...BASE_PAYLOAD, ...extra }));
    assert.equal(result.valid, false, JSON.stringify(extra));
    assert.match(result.reason, reason);
  }
  // Exactly at the bounds is fine. 280 code points, not UTF-16 units.
  const atBounds = {
    ...BASE_PAYLOAD,
    description: "€".repeat(280),
    lineItems: Array.from({ length: 20 }, () => ({ label: "y".repeat(120), quantity: "2.5" })),
  };
  assert.equal((await verifyPaymentRequest(signRequest(atBounds))).valid, true);
});

async function purchaseFixture(payloadOverrides = {}, receiptOverrides = {}) {
  const signed = signRequest({ ...BASE_PAYLOAD, description: "Two widgets", expiresAtSlot: "1", ...payloadOverrides });
  const invoiceHash = createHash("sha256").update(canonicalPaymentRequest(signed.payload)).digest();
  const { address, data } = receiptBytes({ length: RECEIPT_ACCOUNT_LENGTH, invoiceHash, ...receiptOverrides });
  return { signed, receipt: decodePaymentReceipt(data, address) };
}

test("verifyReceiptPurchase matches the request the receipt paid, even after expiry", async () => {
  const { signed, receipt } = await purchaseFixture();
  const result = await verifyReceiptPurchase(receipt, signed);
  assert.equal(result.valid, true);
  assert.equal(result.matched, true);
  assert.equal(result.hashMatches, true);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.payload.description, "Two widgets");
});

test("verifyReceiptPurchase rejects a different request, a forged one, and flags a different amount", async () => {
  const { receipt } = await purchaseFixture();
  const other = signRequest({ ...BASE_PAYLOAD, description: "Three widgets" });
  const different = await verifyReceiptPurchase(receipt, other);
  assert.equal(different.valid, false);
  assert.equal(different.signatureValid, true);
  assert.equal(different.hashMatches, false);

  const { signed } = await purchaseFixture();
  const forged = await verifyReceiptPurchase(receipt, {
    ...signed,
    payload: { ...signed.payload, description: "Free widgets" },
  });
  assert.equal(forged.valid, false);
  assert.equal(forged.signatureValid, false);

  const paidLess = await purchaseFixture({}, { amount: 1n });
  const short = await verifyReceiptPurchase(paidLess.receipt, paidLess.signed);
  assert.equal(short.valid, true);
  assert.equal(short.matched, false);
  assert.deepEqual(short.mismatches, ["amount"]);
});

test("preparePayment stops with a typed DuplicateInvoice error when the receipt exists", async () => {
  const client = new ChainPayClient({ rpcUrl: "http://127.0.0.1:1" });
  const mandate = key(1);
  client.getMandate = async () => ({ address: mandate, tokenProgram: "spl-token", sourceTokenAccount: key(6) });
  client.getPayment = async () => ({ address: "existing" });
  client.getSupportedAsset = async () => assert.fail("nothing is built after a duplicate is found");
  const invoiceHash = Buffer.alloc(32, 12);
  await assert.rejects(
    client.preparePayment({
      mandate,
      invoiceHash,
      paymentId: Buffer.alloc(32, 2),
      signatureReference: Buffer.alloc(32, 3),
      mint: key(5),
      recipient: key(7),
      amount: 1n,
    }, key(4)),
    (error) => {
      assert.ok(error instanceof DuplicateInvoiceError);
      assert.ok(isDuplicateInvoiceError(error));
      assert.equal(error.code, "DuplicateInvoice");
      assert.equal(error.message, "This invoice was already paid. Nothing new was submitted.");
      assert.equal(error.receiptAddress, receiptBytes({ length: 282, invoiceHash, mandate }).address);
      return true;
    },
  );
});

test("a simulation 'already in use' on the receipt reads as DuplicateInvoice", async () => {
  const client = new ChainPayClient({ rpcUrl: "http://127.0.0.1:1" });
  const receiptAddress = key(30);
  const prepared = { receiptAddress, transaction: { instructions: [], requiredSigners: [] } };
  const failing = (message) => ({ submit: async () => { throw new Error(message); } });
  const duplicate = await client.executePayment(
    prepared,
    failing(`Simulation failed. Logs: Allocate: account Address { address: ${receiptAddress}, base: None } already in use`),
  );
  assert.equal(duplicate.code, "DuplicateInvoice");
  assert.equal(duplicate.error, DUPLICATE_INVOICE_MESSAGE);
  const unrelated = await client.executePayment(
    prepared,
    failing(`Allocate: account Address { address: ${key(31)}, base: None } already in use`),
  );
  assert.equal(unrelated.code, undefined);
});

test("relay policy is accepted only as a well-formed relay observation", () => {
  const relay = {
    source: "relay-observed",
    max_per_payment: "5000000",
    total_limit: "50000000",
    amount_spent_after: "12000000",
    payment_count_after: "3",
    max_payment_count: "0",
    expires_at_slot: "18446744073709551615",
    cooldown_slots: "0",
    observed_at_slot: "80",
    includes_later_payments: false,
  };
  const parsed = relayObservedPolicy(relay);
  assert.equal(parsed.source, "relay-observed");
  assert.equal(parsed.limits.expiresAtSlot, 18_446_744_073_709_551_615n);
  assert.equal(relayObservedPolicy({ ...relay, total_limit: 5 }), null);
  assert.equal(relayObservedPolicy({ ...relay, source: "on-chain" }), null);
  // The receipt's own snapshot always wins over a relay observation.
  const withSnapshot = { policySnapshot: { version: 1, ...SNAPSHOT } };
  assert.equal(receiptPolicy(withSnapshot, parsed).source, "on-chain");
  assert.equal(receiptPolicy({ policySnapshot: null }, parsed).source, "relay-observed");
});

test("csv cells quote per RFC 4180 and neutralize formulas", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), "\"a,b\"");
  assert.equal(csvCell("say \"hi\""), "\"say \"\"hi\"\"\"");
  assert.equal(csvCell("two\nlines"), "\"two\nlines\"");
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell("=A1,\"x\""), "\"'=A1,\"\"x\"\"\"");
});

test("receiptsToCsv writes the golden QuickBooks-first export", () => {
  const onChain = receiptBytes({
    length: RECEIPT_ACCOUNT_LENGTH_V2,
    invoiceHash: Buffer.alloc(32, 21),
    snapshotVersion: 1,
  });
  const relay = receiptBytes({ length: RECEIPT_ACCOUNT_LENGTH, invoiceHash: Buffer.alloc(32, 22), amount: 18_446_744_073_709_551_615n });
  const unknown = receiptBytes({ length: RECEIPT_ACCOUNT_LENGTH, invoiceHash: Buffer.alloc(32, 23), amount: 1_000_001n });
  const rows = [
    {
      receipt: { ...decodePaymentReceipt(onChain.data, onChain.address), transactionSignature: "sig1" },
      decimals: 6,
      symbol: "USDC",
      blockTime: 1_790_000_000,
      purpose: { invoice: "PO-1042", description: "=HYPERLINK(\"http://evil\"), \"boxed\"" },
      verifyUrl: "https://app.example/verify/r1",
    },
    {
      receipt: decodePaymentReceipt(relay.data, relay.address),
      decimals: 6,
      symbol: "USDC",
      blockTime: null,
      policy: {
        source: "relay-observed",
        limits: { ...SNAPSHOT, maxPerPayment: 18_446_744_073_709_551_615n },
        observedAtSlot: 80n,
        includesLaterPayments: true,
      },
      purpose: { invoice: "+1 555", lineItems: [{ label: "Widget" }, { label: "Shipping" }] },
    },
    {
      receipt: decodePaymentReceipt(unknown.data, unknown.address),
      decimals: null,
    },
  ];
  const csv = receiptsToCsv(rows);
  const lines = csv.split("\r\n");
  assert.equal(lines.at(-1), "", "every record ends with CRLF");
  assert.equal(lines[0], RECEIPT_CSV_HEADERS.join(","));
  assert.equal(
    lines[0],
    "Date,Description,Amount,Payee,Reference,Token,Agent,Spending permission,Per-payment limit,Total limit,Spent after,Limits source,Receipt,Verify URL,Explorer URL",
  );
  assert.equal(
    lines[1],
    [
      "2026-09-21",
      "\"'=HYPERLINK(\"\"http://evil\"\"), \"\"boxed\"\"\"",
      "4.5",
      key(7),
      "PO-1042",
      "USDC",
      key(4),
      key(1),
      "5",
      "50",
      "12",
      "on-chain",
      onChain.address,
      "https://app.example/verify/r1",
      "https://explorer.solana.com/tx/sig1?cluster=devnet",
    ].join(","),
  );
  assert.equal(
    lines[2],
    [
      "",
      "Widget; Shipping",
      "18446744073709.551615",
      key(7),
      "'+1 555",
      "USDC",
      key(4),
      key(1),
      "18446744073709.551615",
      "50",
      "",
      "relay-observed",
      relay.address,
      "",
      `https://explorer.solana.com/address/${relay.address}?cluster=devnet`,
    ].join(","),
  );
  assert.equal(
    lines[3],
    [
      "",
      "",
      "1000001 base units",
      key(7),
      Buffer.alloc(32, 23).toString("hex"),
      key(5),
      key(4),
      key(1),
      "",
      "",
      "",
      "not-recorded",
      unknown.address,
      "",
      `https://explorer.solana.com/address/${unknown.address}?cluster=devnet`,
    ].join(","),
  );
  assert.equal(lines.length, 5);
  assert.equal(receiptsToCsv([]), `${RECEIPT_CSV_HEADERS.join(",")}\r\n`);
});

test("ops snapshot receipt rows carry the policy source", () => {
  const onChain = receiptBytes({ length: RECEIPT_ACCOUNT_LENGTH_V2, invoiceHash: Buffer.alloc(32, 24), snapshotVersion: 1 });
  const original = receiptBytes({ length: RECEIPT_ACCOUNT_LENGTH, invoiceHash: Buffer.alloc(32, 25) });
  const snapshot = buildOpsSnapshot({
    owner: key(9),
    mandates: [],
    receipts: [decodePaymentReceipt(onChain.data, onChain.address), decodePaymentReceipt(original.data, original.address)],
    decimalsByMint: { [key(5)]: 6 },
  });
  const byAddress = Object.fromEntries(snapshot.receipts.map((row) => [row.address, row]));
  assert.deepEqual(byAddress[onChain.address].policy, {
    source: "on-chain",
    maxPerPayment: "5",
    totalLimit: "50",
    spentAfter: "12",
    paymentCountAfter: "3",
    maxPaymentCount: "10",
    expiresAtSlot: "9000",
  });
  assert.deepEqual(byAddress[original.address].policy, { source: "not-recorded" });
});
