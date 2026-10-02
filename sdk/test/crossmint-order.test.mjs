import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  CROSSMINT_CONNECTOR,
  CROSSMINT_ORDERS_PATH,
  CROSSMINT_STAGING_BASE_URL,
  CrossmintOrderError,
  crossmintOrderUrl,
  crossmintPaymentTerms,
  decodeCrossmintTransferTerms,
  deriveCrossmintPaymentReferences,
  parseCrossmintOrder,
  scaleDecimalString,
  validateCrossmintCheckoutOrder,
} from "../dist/crossmint-order.js";
import {
  crossmintFieldsToPreparePaymentInput,
  crossmintOrderToPreparePaymentInput,
  crossmintTermsToPrepareFields,
} from "../dist/crossmint-adapt.js";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../dist/constants.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function address() {
  return Keypair.generate().publicKey.toBase58();
}

function transferCheckedData(amount, decimals) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  data.writeUInt8(decimals, 9);
  return data;
}

function transferData(amount) {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return data;
}

function serializedTransaction(instructions, { version = 0 } = {}) {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    // A fixed blockhash keeps the fixture deterministic; nothing here is submitted.
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  });
  const compiled = version === 0 ? message.compileToV0Message() : message.compileToLegacyMessage();
  return Buffer.from(new VersionedTransaction(compiled).serialize()).toString("base64");
}

function transferCheckedInstruction({
  programId = SPL_TOKEN_PROGRAM_ID,
  source = address(),
  mint = address(),
  destination = address(),
  authority = address(),
  amount = "1000000",
  decimals = 6,
} = {}) {
  return {
    instruction: new TransactionInstruction({
      programId: new PublicKey(programId),
      keys: [
        { pubkey: new PublicKey(source), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(destination), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      ],
      data: transferCheckedData(amount, decimals),
    }),
    source,
    mint,
    destination,
    amount,
    decimals,
  };
}

function crossmintOrder({
  orderId = "order_test_1",
  phase = "payment",
  serialized,
  quoteAmount,
  currency = "usdc",
  locator = "solana:token-address",
} = {}) {
  return {
    clientSecret: "cs_test",
    order: {
      orderId,
      phase,
      lineItems: [{ tokenLocator: locator }],
      quote: quoteAmount === undefined ? undefined : { totalPrice: { amount: quoteAmount, currency } },
      payment: {
        method: "solana",
        currency,
        status: "awaiting-payment",
        preparation: {
          payerAddress: address(),
          serializedTransaction: serialized,
        },
      },
    },
  };
}

test("reads terms from a Crossmint TransferChecked in both transaction versions", () => {
  for (const version of [0, "legacy"]) {
    const transfer = transferCheckedInstruction({ amount: "2500000", decimals: 6 });
    const terms = decodeCrossmintTransferTerms(
      serializedTransaction([transfer.instruction], { version }),
    );
    assert.equal(terms.mint, transfer.mint);
    assert.equal(terms.recipient, transfer.destination);
    assert.equal(terms.source, transfer.source);
    assert.equal(terms.amount, "2500000");
    assert.equal(terms.decimals, 6);
    assert.equal(terms.tokenProgram, "spl-token");
  }
});

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

test("reads Crossmint's documented wire format: a base58 legacy Transaction", () => {
  // Crossmint's Solana guide decodes serializedTransaction with
  // Transaction.from(bs58.decode(...)); a base64-only reader fails every real order.
  const transfer = transferCheckedInstruction({ amount: "1234567", decimals: 6 });
  const transaction = new Transaction({
    feePayer: Keypair.generate().publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
  }).add(transfer.instruction);
  const wire = base58Encode(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const terms = decodeCrossmintTransferTerms(wire);
  assert.equal(terms.amount, "1234567");
  assert.equal(terms.mint, transfer.mint);
  assert.equal(terms.recipient, transfer.destination);
});

test("reads a Token-2022 transfer and keeps the token program distinct", () => {
  const transfer = transferCheckedInstruction({ programId: TOKEN_2022_PROGRAM_ID });
  const terms = decodeCrossmintTransferTerms(serializedTransaction([transfer.instruction]));
  assert.equal(terms.tokenProgram, "token-2022");
});

test("ignores unrelated instructions around the transfer", () => {
  const transfer = transferCheckedInstruction({ amount: "77" });
  const memo = new TransactionInstruction({
    programId: new PublicKey(SYSTEM_PROGRAM),
    keys: [],
    data: Buffer.from([1, 2, 3]),
  });
  const terms = decodeCrossmintTransferTerms(serializedTransaction([memo, transfer.instruction]));
  assert.equal(terms.amount, "77");
  assert.equal(terms.recipient, transfer.destination);
});

test("rejects a transaction carrying more than one token transfer", () => {
  const first = transferCheckedInstruction();
  const second = transferCheckedInstruction();
  assert.throws(
    () => decodeCrossmintTransferTerms(serializedTransaction([first.instruction, second.instruction])),
    (error) => error instanceof CrossmintOrderError && error.code === "terms_unavailable",
  );
});

test("rejects a transaction with no token transfer at all", () => {
  const memo = new TransactionInstruction({
    programId: new PublicKey(SYSTEM_PROGRAM),
    keys: [],
    data: Buffer.from([9]),
  });
  assert.throws(
    () => decodeCrossmintTransferTerms(serializedTransaction([memo])),
    (error) => error instanceof CrossmintOrderError && error.code === "terms_unavailable",
  );
});

test("an unchecked SPL transfer needs an explicit mint and then agrees with it", () => {
  const source = address();
  const destination = address();
  const authority = address();
  const mint = address();
  const instruction = new TransactionInstruction({
    programId: new PublicKey(SPL_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(source), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(destination), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
    ],
    data: transferData("4321"),
  });
  const wire = serializedTransaction([instruction]);
  assert.throws(
    () => decodeCrossmintTransferTerms(wire),
    (error) => error instanceof CrossmintOrderError && error.code === "terms_unavailable",
  );
  const terms = decodeCrossmintTransferTerms(wire, { mint });
  assert.equal(terms.mint, mint);
  assert.equal(terms.recipient, destination);
  assert.equal(terms.amount, "4321");
  assert.equal(terms.decimals, undefined);
});

test("a mint or token program that disagrees with the expectation fails closed", () => {
  const transfer = transferCheckedInstruction();
  const wire = serializedTransaction([transfer.instruction]);
  assert.throws(
    () => decodeCrossmintTransferTerms(wire, { mint: address() }),
    (error) => error instanceof CrossmintOrderError && error.code === "terms_mismatch",
  );
  assert.throws(
    () => decodeCrossmintTransferTerms(wire, { tokenProgram: "token-2022" }),
    (error) => error instanceof CrossmintOrderError && error.code === "terms_mismatch",
  );
});

test("malformed wire bytes are reported as malformed, not as missing terms", () => {
  assert.throws(
    () => decodeCrossmintTransferTerms("not-base64-$$$"),
    (error) => error instanceof CrossmintOrderError && error.code === "malformed",
  );
  assert.throws(
    () => decodeCrossmintTransferTerms(""),
    (error) => error instanceof CrossmintOrderError && error.code === "malformed",
  );
});

test("parses the documented order envelope and a bare order alike", () => {
  const transfer = transferCheckedInstruction();
  const wire = serializedTransaction([transfer.instruction]);
  const envelope = crossmintOrder({ serialized: wire, quoteAmount: "1.00" });
  const fromEnvelope = parseCrossmintOrder(envelope);
  const fromBare = parseCrossmintOrder(envelope.order);
  assert.deepEqual(fromEnvelope, fromBare);
  assert.equal(fromEnvelope.orderId, "order_test_1");
  assert.equal(fromEnvelope.phase, "payment");
  assert.equal(fromEnvelope.currency, "usdc");
  assert.deepEqual(fromEnvelope.lineItemLocators, ["solana:token-address"]);
  assert.equal(fromEnvelope.serializedTransaction, wire);
});

test("an order without an id or phase is malformed", () => {
  assert.throws(
    () => parseCrossmintOrder({ order: { phase: "payment" } }),
    (error) => error instanceof CrossmintOrderError && error.code === "malformed",
  );
  assert.throws(
    () => parseCrossmintOrder({ order: { orderId: "order_1" } }),
    (error) => error instanceof CrossmintOrderError && error.code === "malformed",
  );
  assert.throws(
    () => parseCrossmintOrder("order_1"),
    (error) => error instanceof CrossmintOrderError && error.code === "malformed",
  );
});

test("payment terms agree with a matching quote and flag one that does not", () => {
  const transfer = transferCheckedInstruction({ amount: "1000000", decimals: 6 });
  const wire = serializedTransaction([transfer.instruction]);
  const matching = crossmintPaymentTerms(
    parseCrossmintOrder(crossmintOrder({ serialized: wire, quoteAmount: "1.00" })),
  );
  assert.equal(matching.quoteCheck, "match");
  assert.equal(matching.amount, "1000000");
  assert.equal(matching.connector, CROSSMINT_CONNECTOR);
  assert.equal(matching.termsSource, "serialized-transaction");
  assert.equal(matching.crossmintSourceTokenAccount, transfer.source);

  const mismatched = crossmintPaymentTerms(
    parseCrossmintOrder(crossmintOrder({ serialized: wire, quoteAmount: "2.00" })),
  );
  assert.equal(mismatched.quoteCheck, "mismatch");

  const unquoted = crossmintPaymentTerms(parseCrossmintOrder(crossmintOrder({ serialized: wire })));
  assert.equal(unquoted.quoteCheck, "unavailable");
});

test("an order that no longer owes money cannot be turned into terms", () => {
  const transfer = transferCheckedInstruction();
  const wire = serializedTransaction([transfer.instruction]);
  for (const phase of ["completed", "delivery", "quote"]) {
    assert.throws(
      () => crossmintPaymentTerms(parseCrossmintOrder(crossmintOrder({ phase, serialized: wire }))),
      (error) => error instanceof CrossmintOrderError && error.code === "order_not_payable",
    );
  }
});

test("an order with no prepared transaction reports unavailable terms", () => {
  assert.throws(
    () => crossmintPaymentTerms(parseCrossmintOrder(crossmintOrder({}))),
    (error) => error instanceof CrossmintOrderError && error.code === "terms_unavailable",
  );
});

test("references commit to the order id alone, so a repriced order keeps one receipt", async () => {
  const first = await deriveCrossmintPaymentReferences("order_abc");
  const again = await deriveCrossmintPaymentReferences("order_abc");
  const other = await deriveCrossmintPaymentReferences("order_xyz");
  assert.deepEqual(first, again);
  assert.notEqual(first.invoiceHash, other.invoiceHash);
  for (const value of Object.values(first)) assert.match(value, /^[0-9a-f]{64}$/);
  assert.notEqual(first.invoiceHash, first.paymentId);
  assert.notEqual(first.paymentId, first.signatureReference);
});

test("the same order at two different prices derives the same receipt reference", async () => {
  const cheap = transferCheckedInstruction({ amount: "1000000" });
  const dear = transferCheckedInstruction({ amount: "9000000" });
  const mandate = address();
  const first = await crossmintOrderToPreparePaymentInput(
    mandate,
    crossmintOrder({ orderId: "order_same", serialized: serializedTransaction([cheap.instruction]) }),
  );
  const second = await crossmintOrderToPreparePaymentInput(
    mandate,
    crossmintOrder({ orderId: "order_same", serialized: serializedTransaction([dear.instruction]) }),
  );
  assert.deepEqual(first.input.invoiceHash, second.input.invoiceHash);
  assert.notEqual(first.input.amount, second.input.amount);
});

test("prepare fields carry the connector and convert into a payment input", async () => {
  const transfer = transferCheckedInstruction({ amount: "500000", decimals: 6 });
  const mandate = address();
  const terms = crossmintPaymentTerms(
    parseCrossmintOrder(crossmintOrder({ serialized: serializedTransaction([transfer.instruction]) })),
  );
  const fields = await crossmintTermsToPrepareFields(terms);
  assert.equal(fields.connector, CROSSMINT_CONNECTOR);
  assert.equal(fields.orderId, "order_test_1");
  const input = crossmintFieldsToPreparePaymentInput(mandate, fields);
  assert.equal(input.mandate, mandate);
  assert.equal(input.mint, transfer.mint);
  assert.equal(input.recipient, transfer.destination);
  assert.equal(input.amount, 500000n);
  assert.equal(input.tokenProgram, "spl-token");
  assert.equal(input.invoiceHash.length, 32);
  assert.equal(input.paymentId.length, 32);
  assert.equal(input.signatureReference.length, 32);
});

test("decimal quote scaling stays exact and refuses to round a real price", () => {
  assert.equal(scaleDecimalString("1.5", 6), 1_500_000n);
  assert.equal(scaleDecimalString("0.000001", 6), 1n);
  assert.equal(scaleDecimalString("12", 0), 12n);
  assert.equal(scaleDecimalString("1.1000", 2), 110n);
  assert.equal(scaleDecimalString("1.005", 2), undefined);
  assert.equal(scaleDecimalString("1,5", 6), undefined);
  assert.equal(scaleDecimalString("-1.5", 6), undefined);
});

test("order URLs are built against the documented orders path over HTTPS", () => {
  assert.equal(
    crossmintOrderUrl(CROSSMINT_STAGING_BASE_URL, "order_1"),
    `${CROSSMINT_STAGING_BASE_URL}${CROSSMINT_ORDERS_PATH}/order_1`,
  );
  assert.equal(
    crossmintOrderUrl(`${CROSSMINT_STAGING_BASE_URL}/`, "order/../other"),
    `${CROSSMINT_STAGING_BASE_URL}${CROSSMINT_ORDERS_PATH}/order%2F..%2Fother`,
  );
  assert.throws(
    () => crossmintOrderUrl("http://staging.crossmint.com", "order_1"),
    (error) => error instanceof CrossmintOrderError && error.code === "malformed",
  );
});

test("checkout rejects unsafe preparation while generic decoding remains descriptive", () => {
  const owner = address();
  const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const transfer = transferCheckedInstruction({ mint, amount: "1234567" });
  const raw = crossmintOrder({ serialized: serializedTransaction([transfer.instruction]), quoteAmount: "1.234567" });
  raw.order.payment.preparation.payerAddress = owner;
  raw.order.payment.preparation.chain = "solana";
  raw.order.quote.status = "valid";
  raw.order.quote.expiresAt = "2030-01-01T00:00:00Z";
  const order = parseCrossmintOrder(raw);
  const expected = { orderId: order.orderId, owner, source: transfer.source, mint, now: 1 };
  assert.equal(validateCrossmintCheckoutOrder(order, expected).amount, "1234567");
  for (const patch of [
    { preparationChain: "ethereum" }, { payerAddress: address() }, { orderId: "other" },
    { quoteStatus: "expired" }, { quoteExpiresAt: "not-a-date" }, { quoteExpiresAt: "1970-01-01T00:00:00Z" },
    { paymentStatus: "completed" }, { currency: "eth" },
    { quotedTotal: { amount: "1.234567", currency: "usd" } },
    { quotedTotal: { amount: "1.234568", currency: "usdc" } },
  ]) assert.throws(() => validateCrossmintCheckoutOrder({ ...order, ...patch }, expected), CrossmintOrderError);
  assert.throws(() => validateCrossmintCheckoutOrder(order, { ...expected, source: address() }), /source/);
  const extra = new TransactionInstruction({ programId: new PublicKey(SYSTEM_PROGRAM), keys: [], data: Buffer.from([1]) });
  assert.throws(() => validateCrossmintCheckoutOrder({ ...order, serializedTransaction: serializedTransaction([extra, transfer.instruction]) }, expected), /cannot preserve/);
});
