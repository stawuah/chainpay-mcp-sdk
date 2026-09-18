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

test("pending execute preserves operation, signature and exact max-u64 amount without a new approval", async () => {
  const fixture = paymentFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"payment_id":"payment_existing","status":"submitted","signature":"original-signature","amount":"18446744073709551615"}', {status:200,headers:{"Content-Type":"application/json"}});
  try {
    const result = await executePayment({backendUrl:"https://fixture.invalid",backendAuthToken:"fixture",client:{preparePayment:async()=>fixture.prepared}}, {...fixture.args,signedTransaction:"same-approved-transaction"});
    assert.equal(result.isError,undefined);
    assert.equal(result.structuredContent.action,"payment_pending");
    assert.equal(result.structuredContent.payment_id,"payment_existing");
    assert.equal(result.structuredContent.signature,"original-signature");
    assert.equal(typeof result.structuredContent.amount,"string");
    assert.equal(BigInt(JSON.parse(JSON.stringify(result.structuredContent)).amount),18446744073709551615n);
  } finally {globalThis.fetch=originalFetch;}
});

test("wait_for_payment reconciles the existing operation and keeps transport failures pending", async () => {
  const { waitForPayment } = await import("../dist/tools/wait_for_payment.js");
  const originalFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async (url,init)=>{requests.push([url,init]);return new Response(JSON.stringify({payment_id:"existing",status:requests.length===1?"submitted":"confirmed",signature:"same-signature",amount:"18446744073709551615"}),{status:200});};
  try {
    const context={backendUrl:"https://fixture.invalid",backendAuthToken:"fixture"};
    const result=await waitForPayment(context,{paymentId:"existing",timeoutMs:"1000",pollMs:"50"});
    assert.equal(result.structuredContent.status,"confirmed");
    assert.equal(result.structuredContent.signature,"same-signature");
    assert.equal(requests.length,2);
    assert.ok(requests.every(([url,init])=>url.endsWith("/v1/payments/existing") && !init.method));
    globalThis.fetch=async()=>{throw new Error("fixture timeout")};
    const pending=await waitForPayment(context,{paymentId:"existing",timeoutMs:"0"});
    assert.equal(pending.structuredContent.action,"payment_pending");assert.equal(pending.isError,undefined);
  } finally {globalThis.fetch=originalFetch;}
});

test("a lost Axum response reports an unknown outcome, never a submission",async()=>{
  const {submitSettlement}=await import("../dist/tools/settlement-submit.js");
  const {createHash}=await import("node:crypto");const old=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error("fixture lost response")};
  try {const response=await submitSettlement({principal:{wallet:"owner",scope:null}},"https://fixture.invalid/v1/payments",{body:JSON.stringify({idempotency_key:"invoice"})});const value=await response.json();assert.equal(value.payment_id,`payment_${createHash("sha256").update("owner:invoice").digest("hex")}`);// Claiming "submitted" for a request that may never have been sent leaves the
  // owner polling an id the relay has no record of, seeing only 404 forever.
  assert.equal(value.status,"unknown");
  assert.notEqual(value.status,"submitted");
  assert.equal(value.action,"payment_outcome_unknown");
  assert.match(value.error,/may have settled or may never have been sent/);assert.equal(value.continuation.arguments.paymentId,value.payment_id);}finally{globalThis.fetch=old;}
});

test("x402 resumes pending then delivers original resource without prepare, signing or submission",async()=>{
  const {executeX402Payment}=await import("../dist/tools/x402.js");
  const old=globalThis.fetch,origins=process.env.CHAINPAY_X402_ALLOWED_ORIGINS;
  process.env.CHAINPAY_X402_ALLOWED_ORIGINS="https://merchant.example";
  const id=`payment_${"a".repeat(64)}`,calls=[];let finalized=false;
  const challenge={resource:"https://merchant.example/original",amount:"18446744073709551615",invoiceHash:"11".repeat(32),mint:"mint",recipient:"recipient",network:"solana-devnet",scheme:"exact"};
  const payment={payment_id:id,status:"submitted",signature:"original-signature",receipt_address:"receipt",mandate:"mandate",agent:"agent"};
  globalThis.fetch=async(url,init={})=>{calls.push([String(url),init]);if(String(url).endsWith("/x402"))return Response.json({payment:{...payment,status:finalized?"confirmed":"submitted"},resource:challenge.resource,challenge,idempotency_key:"original-key"});if(String(url)===challenge.resource){assert.match(init.headers["X-PAYMENT"],/original-signature/);return Response.json({delivered:true});}if(String(url).endsWith("/proof")){assert.equal(JSON.parse(init.body).idempotency_key,"original-key");return Response.json({});}throw new Error(`unexpected ${url}`);};
  const context={backendUrl:"https://backend.example",backendAuthToken:"fixture",client:{getPayment:async()=>({status:"confirmed",address:"receipt",mandate:"mandate",agent:"agent",mint:"mint",recipient:"recipient",invoiceHash:Uint8Array.from({length:32},()=>17),amount:18446744073709551615n}),preparePayment:async()=>{throw new Error("must not prepare again")}}};
  try {const pending=await executeX402Payment(context,{paymentId:id});assert.equal(pending.structuredContent.action,"x402_payment_pending");assert.equal(calls.length,1);finalized=true;const result=await executeX402Payment(context,{paymentId:id});assert.equal(result.structuredContent.action,"x402_verified");assert.equal(calls.filter(([url])=>url===challenge.resource).length,1);assert.ok(calls.every(([url])=>!url.endsWith("/v1/payments")&&!url.endsWith("/managed-payments")));}finally{globalThis.fetch=old;if(origins===undefined)delete process.env.CHAINPAY_X402_ALLOWED_ORIGINS;else process.env.CHAINPAY_X402_ALLOWED_ORIGINS=origins;}
});
