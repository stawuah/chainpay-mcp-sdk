import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { callTool } from "../dist/index.js";
import { executePayment } from "../dist/tools/execute_payment.js";

function paymentFixture() {
  const mandate = Keypair.generate().publicKey.toBase58();
  const agent = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const receiptAddress = Keypair.generate().publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const preflight = {
    valid: true,
    currentSlot: 100n,
    checks: [
      { name: "mandate_status", ok: true, message: "Mandate is active" },
      { name: "approved_agent", ok: true, message: "Agent is approved" },
      { name: "mint", ok: true, message: "Mint matches" },
      { name: "recipient", ok: true, message: "Recipient is present" },
      { name: "amount_positive", ok: true, message: "Amount is positive" },
      { name: "per_payment_limit", ok: true, message: "Within per-payment limit" },
      { name: "total_limit", ok: true, message: "Within total limit" },
      { name: "payment_count_limit", ok: true, message: "Within payment-count limit" },
      { name: "cooldown", ok: true, message: "Cooldown elapsed" },
      { name: "expiry", ok: true, message: "Mandate has not expired" },
      { name: "invoice_hash", ok: true, message: "Invoice hash is valid" },
      { name: "payment_id", ok: true, message: "Payment id is valid" },
      { name: "signature_reference", ok: true, message: "Signature reference is valid" },
      { name: "duplicate_invoice", ok: true, message: "Invoice is new" },
      { name: "token_program", ok: true, message: "Token program matches" },
    ],
  };
  const transaction = {
    feePayer: agent,
    requiredSigners: [agent],
    instructions: [{
      name: "test_instruction",
      programId: SystemProgram.programId.toBase58(),
      keys: [{ address: agent, isSigner: true, isWritable: true }],
      data: new Uint8Array(),
    }],
  };
  return {
    args: {
      mandate,
      agent,
      invoiceHash: "11".repeat(32),
      paymentId: "22".repeat(32),
      signatureReference: "33".repeat(32),
      mint,
      recipient,
      amount: "10",
      tokenProgram: "spl-token",
    },
    prepared: { receiptAddress, preflight, transaction },
    blockhash,
  };
}

test("execute_payment returns an unsigned wire transaction for an external signer", async () => {
  const fixture = paymentFixture();
  const context = {
    client: {
      preparePayment: async () => fixture.prepared,
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: fixture.blockhash,
          lastValidBlockHeight: 1234,
        }),
      },
    },
  };

  const result = await executePayment(context, fixture.args);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.action, "agent_signature_required");
  assert.equal(result.structuredContent.unsignedTransaction.encoding, "base64");
  assert.equal(result.structuredContent.unsignedTransaction.recentBlockhash, fixture.blockhash);
  assert.equal(result.structuredContent.unsignedTransaction.lastValidBlockHeight, 1234);

  const transaction = Transaction.from(Buffer.from(
    result.structuredContent.unsignedTransaction.value,
    "base64",
  ));
  assert.equal(transaction.feePayer?.toBase58(), fixture.args.agent);
  assert.equal(transaction.recentBlockhash, fixture.blockhash);
  assert.equal(transaction.signatures[0]?.signature, null);
});

test("delegated execute_payment never accepts a caller-supplied signature", async () => {
  const fixture = paymentFixture();
  const context = {
    client: {
      preparePayment: async () => fixture.prepared,
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: fixture.blockhash,
          lastValidBlockHeight: 1234,
        }),
      },
    },
    backendUrl: "https://backend.example",
    backendAuthToken: "test-token",
  };

  const result = await executePayment(context, {
    ...fixture.args,
    signingMode: "delegated",
    signedTransaction: "caller-controlled-signature",
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action, "delegated_signature_rejected");
});

test("delegated execute_payment sends only an unsigned transaction to authenticated Axum", async () => {
  const fixture = paymentFixture();
  const context = {
    client: {
      preparePayment: async () => fixture.prepared,
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: fixture.blockhash,
          lastValidBlockHeight: 1234,
        }),
      },
    },
    backendUrl: "https://backend.example/",
    backendAuthToken: "test-token",
  };
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, ...init };
    return new Response(JSON.stringify({ status: "confirmed", signature: "provider-signature" }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await executePayment(context, { ...fixture.args, signingMode: "delegated" });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.action, "managed_payment_settled");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, "https://backend.example/v1/managed-payments");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer test-token");
  const payload = JSON.parse(request.body);
  assert.equal(payload.unsigned_transaction.includes("provider-signature"), false);
  assert.equal(payload.agent, fixture.args.agent);
  assert.equal(payload.receipt_address, fixture.prepared.receiptAddress);
  assert.equal(payload.signed_transaction, undefined);
});

test("MCP rejects private-key-shaped tool arguments before dispatch", async () => {
  await assert.rejects(
    callTool(
      { client: {} },
      "get_mandate",
      {
        address: "FmFHfuMx1U6sjKKsuD9SrFedspnAuTUki1KPKjWbehkU",
        delegatedKey: "must-not-enter-mcp",
      },
    ),
    /Private key material is not accepted by ChainPay MCP/,
  );
});
