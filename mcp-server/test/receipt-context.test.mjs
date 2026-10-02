import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATORS,
  DEFAULT_PROGRAM_ID,
  DuplicateInvoiceError,
  canonicalPaymentRequest,
  decodePaymentReceipt,
} from "@chainpay/sdk";
import { TOOL_DEFINITIONS, callTool } from "../dist/index.js";
import { executePayment } from "../dist/tools/execute_payment.js";

const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
const OWNER = key(50);
const MANDATE = key(1);
const AGENT = key(4);
const MINT = key(5);
const RECIPIENT = key(7);

const merchantKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 42)]),
  format: "der",
  type: "pkcs8",
});
const MERCHANT = Keypair.fromSeed(Buffer.alloc(32, 42)).publicKey.toBase58();

function signedRequest(overrides = {}) {
  const payload = {
    version: 1,
    cluster: "devnet",
    merchant: MERCHANT,
    invoice: "PO-1042",
    mint: MINT,
    tokenProgram: "spl-token",
    recipient: RECIPIENT,
    amount: "4500000",
    decimals: 6,
    nonce: "nonce-1",
    description: "Two widgets, boxed",
    ...overrides,
  };
  return { payload, signature: sign(null, Buffer.from(canonicalPaymentRequest(payload)), merchantKey).toString("base64") };
}

function invoiceHashOf(request) {
  return createHash("sha256").update(canonicalPaymentRequest(request.payload)).digest();
}

function receipt({ invoiceHash, length = 282, slot = 77n, snapshot = false }) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), new PublicKey(MANDATE).toBytes(), invoiceHash],
    new PublicKey(DEFAULT_PROGRAM_ID),
  );
  const data = Buffer.alloc(length);
  data.set(ACCOUNT_DISCRIMINATORS.paymentReceipt);
  data.set(new PublicKey(MANDATE).toBytes(), 8);
  data.set(invoiceHash, 40);
  data.set(new PublicKey(MINT).toBytes(), 104);
  data.set(new PublicKey(RECIPIENT).toBytes(), 168);
  data.writeBigUInt64LE(4_500_000n, 200);
  data.set(new PublicKey(AGENT).toBytes(), 208);
  data.writeBigUInt64LE(slot, 240);
  data[280] = 1;
  data[281] = bump;
  if (snapshot) {
    data[282] = 1;
    [5_000_000n, 50_000_000n, 9_000_000n, 2n, 0n, 9_000n, 0n].forEach((value, index) => data.writeBigUInt64LE(value, 283 + index * 8));
  }
  return decodePaymentReceipt(data, address.toBase58());
}

const purchase = signedRequest();
const original = receipt({ invoiceHash: invoiceHashOf(purchase), slot: 77n });
const upgraded = receipt({ invoiceHash: Buffer.alloc(32, 9), length: 371, slot: 88n, snapshot: true });

const RELAY_POLICY = {
  source: "relay-observed",
  max_per_payment: "5000000",
  total_limit: "50000000",
  amount_spent_after: "4500000",
  payment_count_after: "1",
  max_payment_count: "0",
  expires_at_slot: "9000",
  cooldown_slots: "0",
  observed_at_slot: "80",
  includes_later_payments: false,
};

function context(scope = null) {
  const mandate = {
    address: MANDATE,
    owner: OWNER,
    approvedAgent: AGENT,
    allowedMint: MINT,
    status: "active",
    maxPerPayment: 5_000_000n,
    totalLimit: 50_000_000n,
    amountSpent: 9_000_000n,
    paymentCount: 2n,
    maxPaymentCount: 0n,
    expiresAtSlot: 9_000n,
  };
  return {
    principal: { wallet: OWNER, scope },
    backendUrl: "https://relay.example",
    backendAuthToken: "session-token",
    client: {
      getMandate: async () => mandate,
      getMandatesByOwner: async (owner) => {
        assert.equal(owner, OWNER);
        return [mandate, { ...mandate, address: key(2) }];
      },
      getPaymentsByMandate: async (address) => (address === MANDATE ? [original, upgraded] : []),
      getMintDecimals: async () => 6,
      getCurrentSlot: async () => 100n,
      getPayment: async () => original,
      connection: { getBlockTime: async (slot) => (slot === 77 ? 1_790_000_000 : null) },
    },
  };
}

/** Relay fixture: policy for the original receipt, the signed request for its owner. */
async function withRelay(run) {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(init.headers.Authorization, "Bearer session-token");
    if (String(url).endsWith(`/v1/receipts/${original.address}`)) {
      return Response.json({ receipt_address: original.address, mandate: MANDATE, policy: RELAY_POLICY });
    }
    if (String(url).endsWith(`/v1/receipts/${original.address}/request`)) {
      return Response.json({ receipt_address: original.address, request: purchase });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = previous;
  }
}

test("export_receipts is a registered owner-scoped tool", async () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "export_receipts");
  assert.ok(definition);
  assert.equal(definition.inputSchema.additionalProperties, false);
  await assert.rejects(callTool(context(), "export_receipts", { owner: key(51) }), /Wallet differs/);
  await assert.rejects(callTool({ client: context().client }, "export_receipts", {}), /Sign in/);
});

test("export_receipts returns one CSV with labeled limit sources and verified purpose", async () => {
  const previousApp = process.env.CHAINPAY_APP_URL;
  process.env.CHAINPAY_APP_URL = "https://app.example";
  try {
    await withRelay(async () => {
      const result = await callTool(context(), "export_receipts", {});
      assert.equal(result.isError, undefined);
      const data = result.structuredContent;
      assert.equal(data.kind, "receipt_export");
      assert.equal(data.owner, OWNER);
      assert.equal(data.rowCount, 2);
      assert.deepEqual(data.limitsSources, { "on-chain": 1, "relay-observed": 1, "not-recorded": 0 });
      const lines = data.csv.split("\r\n");
      assert.match(lines[0], /^Date,Description,Amount,Payee,Reference,/);
      // Newest first: the v2 receipt at slot 88, then the original at 77.
      assert.match(lines[1], new RegExp(`^,,4\\.5,${RECIPIENT},[0-9a-f]{64},${MINT},${AGENT},${MANDATE},5,50,9,on-chain,${upgraded.address},https://app\\.example/verify/`));
      assert.equal(
        lines[2],
        `2026-09-21,"Two widgets, boxed",4.5,${RECIPIENT},PO-1042,${MINT},${AGENT},${MANDATE},5,50,4.5,relay-observed,${original.address},https://app.example/verify/${original.address},https://explorer.solana.com/address/${original.address}?cluster=devnet,,`,
      );
      // PO number and Order match are appended last and left empty here.
      assert.match(lines[0], /,Explorer URL,PO number,Order match$/);
      assert.match(result.content[0].text, /Limits seen by the ChainPay relay after payment, not stored on Solana: 1/);
      assert.match(result.content[0].text, /```csv/);
    });
  } finally {
    if (previousApp === undefined) delete process.env.CHAINPAY_APP_URL;
    else process.env.CHAINPAY_APP_URL = previousApp;
  }
});

test("a scoped connection exports only its mandates and never asks for signed requests", async () => {
  const scope = { version: 1, mandates: [MANDATE], tools: ["export_receipts"], agents: { [MANDATE]: AGENT } };
  await withRelay(async (requests) => {
    const result = await callTool(context(scope), "export_receipts", {});
    assert.equal(result.structuredContent.rowCount, 2);
    assert.equal(requests.some((url) => url.endsWith("/request")), false);
    assert.doesNotMatch(result.structuredContent.csv, /Two widgets/);
  });
});

test("list_receipts rows carry the policy source and the verified purpose", async () => {
  await withRelay(async () => {
    const result = await callTool(context(), "list_receipts", {});
    const rows = Object.fromEntries(result.structuredContent.receipts.map((row) => [row.address, row]));
    assert.equal(rows[upgraded.address].policy.source, "on-chain");
    assert.equal(rows[upgraded.address].policy.spentAfter, "9");
    assert.equal(rows[original.address].policy.source, "relay-observed");
    assert.equal(rows[original.address].policy.observedAtSlot, "80");
    assert.equal(rows[original.address].purpose.description, "Two widgets, boxed");
    assert.equal(rows[original.address].purpose.matched, true);
    assert.match(result.content[0].text, /For: Two widgets, boxed/);
    assert.match(result.content[0].text, /seen by the ChainPay relay after payment, not stored on Solana/);
    assert.match(result.content[0].text, /recorded on Solana at payment/);
  });
});

test("get_payment reports limits with their source and what was bought", async () => {
  await withRelay(async () => {
    const result = await callTool(context(), "get_payment", { receiptAddress: original.address });
    const data = result.structuredContent;
    assert.equal(data.policy.source, "relay-observed");
    assert.equal(data.policy.totalLimit, "50");
    assert.equal(data.purpose.invoice, "PO-1042");
    // The relay never relayed this payment, so there is no off-chain record.
    assert.equal(data.offChain, null);
    assert.equal(data.onChain.policySnapshot, null);
    assert.match(result.content[0].text, /For: Two widgets, boxed/);
  });
});

test("a request that does not match the receipt is never shown as its purpose", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith("/request")
    ? Response.json({ request: signedRequest({ description: "Something else" }) })
    : new Response("{}", { status: 404 }));
  try {
    const result = await callTool(context(), "get_payment", { receiptAddress: original.address });
    assert.equal(result.structuredContent.purpose, undefined);
    assert.equal(result.structuredContent.policy.source, "not-recorded");
  } finally {
    globalThis.fetch = previous;
  }
});

function paymentArgs(request) {
  return {
    mandate: MANDATE,
    agent: AGENT,
    invoiceHash: invoiceHashOf(request).toString("hex"),
    paymentId: "22".repeat(32),
    signatureReference: "33".repeat(32),
    mint: MINT,
    recipient: RECIPIENT,
    amount: "4500000",
    tokenProgram: "spl-token",
    signingMode: "human",
    signedTransaction: "signed-bytes",
    request,
  };
}

function executeContext() {
  return {
    backendUrl: "https://relay.example",
    backendAuthToken: "session-token",
    client: {
      getCurrentSlot: async () => 100n,
      preparePayment: async () => ({
        receiptAddress: original.address,
        preflight: { valid: true, currentSlot: 100n, checks: [] },
        transaction: {
          feePayer: AGENT,
          requiredSigners: [AGENT],
          instructions: [{ name: "fixture", programId: SystemProgram.programId.toBase58(), keys: [], data: new Uint8Array() }],
        },
      }),
    },
  };
}

test("execute_payment hands the verified signed request to the relay", async () => {
  const previous = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ status: "confirmed", signature: "sig" });
  };
  try {
    const result = await executePayment(executeContext(), paymentArgs(purchase));
    assert.equal(result.structuredContent.action, "backend_relayed");
    assert.deepEqual(body.payment_request.payload, purchase.payload);
    assert.equal(body.payment_request.signature, purchase.signature);
  } finally {
    globalThis.fetch = previous;
  }
});

test("execute_payment refuses a request that is not this payment's invoice", async () => {
  const other = signedRequest({ description: "Three widgets" });
  const args = { ...paymentArgs(purchase), request: other };
  const result = await executePayment(executeContext(), args);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action, "payment_request_mismatch");

  const pricier = signedRequest({ amount: "9000000" });
  const mismatch = await executePayment(executeContext(), { ...paymentArgs(pricier), amount: "4500000" });
  assert.equal(mismatch.structuredContent.action, "payment_request_mismatch");
  assert.match(mismatch.structuredContent.message, /different mint, recipient, or amount/);

  const expired = signedRequest({ expiresAtSlot: "50" });
  const late = await executePayment(executeContext(), paymentArgs(expired));
  assert.match(late.structuredContent.message, /expired/);
});

test("a relay DuplicateInvoice refusal comes back typed and plain", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json(
    { error: "This invoice was already paid. Nothing new was submitted.", code: "DuplicateInvoice", receipt_address: original.address },
    { status: 422 },
  );
  try {
    const result = await executePayment(executeContext(), paymentArgs(purchase));
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.action, "duplicate_invoice");
    assert.equal(result.structuredContent.code, "DuplicateInvoice");
    assert.match(result.content[0].text, /This invoice was already paid. Nothing new was submitted./);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a DuplicateInvoice from preparation is a typed tool result, not a crash", async () => {
  const ctx = context();
  ctx.client.preparePayment = async () => {
    throw new DuplicateInvoiceError(original.address);
  };
  const { request: _request, signedTransaction: _signed, ...args } = paymentArgs(purchase);
  const result = await callTool(ctx, "prepare_payment", args);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action, "duplicate_invoice");
  assert.equal(result.structuredContent.receiptAddress, original.address);
  assert.equal(result.structuredContent.message, "This invoice was already paid. Nothing new was submitted.");
});
