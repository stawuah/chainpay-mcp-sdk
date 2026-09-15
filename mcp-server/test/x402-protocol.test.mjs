import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  CUSTOM_PROTOCOL,
  CUSTOM_X402_VERSION,
  SOLANA_DEVNET_CAIP2,
  STANDARD_V2_PROTOCOL,
  detectAndParsePaymentRequired,
  parsePaymentRequiredDocument,
  parsePaymentRequiredFromResponse,
  X402ProtocolError,
} from "../dist/tools/x402-protocol.js";
import { executeX402Payment, prepareX402Payment } from "../dist/tools/x402.js";

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RESOURCE = "https://merchant.example/data";

function address() {
  return Keypair.generate().publicKey.toBase58();
}

function customEnvelope({
  mint = address(),
  payTo = address(),
  amount = "100000",
  resource = RESOURCE,
  network = "solana-devnet",
} = {}) {
  return {
    version: CUSTOM_X402_VERSION,
    accepts: [{
      scheme: "exact",
      network,
      maxAmountRequired: amount,
      asset: mint,
      payTo,
      resource,
      tokenProgram: "spl-token",
    }],
  };
}

function standardV2Envelope({
  asset = address(),
  payTo = address(),
  amount = "100000",
  resource = RESOURCE,
  network = SOLANA_DEVNET_CAIP2,
  feePayer = address(),
} = {}) {
  return {
    x402Version: 2,
    resource: { url: resource, description: "fixture", mimeType: "application/json" },
    accepts: [{
      scheme: "exact",
      network,
      amount,
      asset,
      payTo,
      maxTimeoutSeconds: 60,
      extra: { feePayer },
    }],
  };
}

function preparedFixture() {
  const mandate = address();
  const agent = address();
  const receiptAddress = address();
  return {
    mandate,
    agent,
    receiptAddress,
    preflight: { valid: true, currentSlot: 100n, checks: [] },
    transaction: {
      feePayer: agent,
      requiredSigners: [agent],
      instructions: [{
        name: "test_instruction",
        programId: SystemProgram.programId.toBase58(),
        keys: [{ address: agent, isSigner: true, isWritable: true }],
        data: new Uint8Array(),
      }],
    },
  };
}

function allowOrigin(run) {
  const previous = process.env.CHAINPAY_X402_ALLOWED_ORIGINS;
  process.env.CHAINPAY_X402_ALLOWED_ORIGINS = "https://merchant.example";
  return run().finally(() => {
    if (previous === undefined) delete process.env.CHAINPAY_X402_ALLOWED_ORIGINS;
    else process.env.CHAINPAY_X402_ALLOWED_ORIGINS = previous;
  });
}

test("parses custom x402/1.0 receipt-proof challenges from shape, not header name", () => {
  const mint = address();
  const recipient = address();
  const envelope = customEnvelope({ mint, payTo: recipient, amount: "18446744073709551615" });
  const fromJson = parsePaymentRequiredDocument(envelope, RESOURCE);
  assert.equal(fromJson.kind, "custom");
  assert.equal(fromJson.option.protocol, CUSTOM_PROTOCOL);
  assert.equal(fromJson.option.proofKind, "settled-receipt-pda");
  assert.equal(fromJson.option.recipient, recipient);
  assert.equal(fromJson.option.amount, "18446744073709551615");
  assert.match(fromJson.option.protocolLabel, /receipt-proof/);

  const headers = new Headers({
    "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
  });
  const fromStandardHeaderName = parsePaymentRequiredFromResponse(headers, {}, RESOURCE);
  assert.equal(fromStandardHeaderName.kind, "custom");
  assert.equal(fromStandardHeaderName.option.recipient, recipient);
});

test("recognizes standard v2 PAYMENT-REQUIRED and never maps owner payTo to recipient", () => {
  const owner = address();
  const envelope = standardV2Envelope({ payTo: owner });
  const parsed = parsePaymentRequiredDocument(envelope, RESOURCE);
  assert.equal(parsed.kind, "standard-v2");
  assert.equal(parsed.option.protocol, STANDARD_V2_PROTOCOL);
  assert.equal(parsed.option.proofKind, "partially-signed-sponsored-transaction");
  assert.equal(parsed.option.network, SOLANA_DEVNET_CAIP2);
  assert.equal(parsed.option.merchantOwner, owner);
  assert.equal("recipient" in parsed.option, false);

  const headers = new Headers({ "X-Payment-Required": JSON.stringify(envelope) });
  const fromCustomHeaderName = parsePaymentRequiredFromResponse(headers, {}, RESOURCE);
  assert.equal(fromCustomHeaderName.kind, "standard-v2");
  assert.equal(fromCustomHeaderName.option.merchantOwner, owner);
});

test("rejects mixed versions, numeric amounts, leading zeros, and missing discriminants", () => {
  assert.throws(() => parsePaymentRequiredDocument({
    x402Version: 2,
    version: CUSTOM_X402_VERSION,
    accepts: [],
  }), /must not mix/);
  assert.throws(() => parsePaymentRequiredDocument(customEnvelope({ amount: 100000 })), /canonical decimal u64/);
  assert.throws(() => parsePaymentRequiredDocument(customEnvelope({ amount: "0100000" })), /canonical decimal u64/);
  assert.throws(() => parsePaymentRequiredDocument({
    scheme: "exact",
    asset: address(),
    payTo: address(),
    amount: "100000",
    resource: RESOURCE,
  }), /explicit protocol version or network/);
  assert.throws(() => parsePaymentRequiredDocument({
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [{
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      amount: 1000,
      asset: address(),
      payTo: address(),
    }],
  }), /canonical decimal u64/);
});

test("rejects unsupported networks and resource mismatches", () => {
  assert.throws(
    () => parsePaymentRequiredDocument(standardV2Envelope({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })),
    (error) => error instanceof X402ProtocolError && error.code === "unsupported_network",
  );
  assert.throws(
    () => parsePaymentRequiredDocument(standardV2Envelope({ network: "eip155:84532" })),
    (error) => error instanceof X402ProtocolError && error.code === "unsupported_network",
  );
  assert.throws(
    () => parsePaymentRequiredDocument(customEnvelope({ network: "devnet" })),
    (error) => error instanceof X402ProtocolError && error.code === "unsupported_network",
  );
  assert.throws(
    () => parsePaymentRequiredDocument(customEnvelope({ resource: "https://other.example/data" }), RESOURCE),
    (error) => error instanceof X402ProtocolError && error.code === "resource_mismatch",
  );
  assert.throws(
    () => detectAndParsePaymentRequired([customEnvelope(), standardV2Envelope()]),
    /disagree on custom vs standard v2/,
  );
});

test("custom 402-to-proof flow settles once and labels the receipt-proof protocol", async () => {
  await allowOrigin(async () => {
    const mint = address();
    const recipient = address();
    const fixture = preparedFixture();
    const envelope = customEnvelope({ mint, payTo: recipient });
    const calls = [];
    let preparedInput;
    const old = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push([String(url), init]);
      if (String(url) === RESOURCE && !init.headers?.["X-PAYMENT"]) {
        return new Response(JSON.stringify(envelope), {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "X-Payment-Required": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
          },
        });
      }
      if (String(url).endsWith("/v1/payments")) {
        return Response.json({
          payment_id: `payment_${"b".repeat(64)}`,
          status: "confirmed",
          signature: "settled-signature",
          receipt_address: fixture.receiptAddress,
        });
      }
      if (String(url) === RESOURCE && init.headers?.["X-PAYMENT"]) {
        const proof = JSON.parse(init.headers["X-PAYMENT"]);
        assert.equal(proof.version, CUSTOM_X402_VERSION);
        assert.equal(proof.payload.signature, "settled-signature");
        assert.equal(proof.payload.receiptPDA, fixture.receiptAddress);
        assert.equal(proof.payload.transaction, undefined);
        return Response.json({ delivered: true });
      }
      if (String(url).endsWith("/proof")) return Response.json({});
      throw new Error(`unexpected ${url}`);
    };
    const context = {
      backendUrl: "https://backend.example",
      backendAuthToken: "fixture",
      client: {
        getSupportedAsset: async () => ({ enabled: true, tokenProgram: SPL_TOKEN_PROGRAM_ID }),
        getCurrentSlot: async () => 1n,
        preparePayment: async (input) => {
          preparedInput = input;
          return {
            receiptAddress: fixture.receiptAddress,
            preflight: fixture.preflight,
            transaction: fixture.transaction,
          };
        },
        getPayment: async () => ({
          status: "confirmed",
          address: fixture.receiptAddress,
          mandate: fixture.mandate,
          agent: fixture.agent,
          mint,
          recipient,
          invoiceHash: preparedInput.invoiceHash,
          amount: 100000n,
        }),
        connection: {
          getLatestBlockhash: async () => {
            throw new Error("must not fetch a blockhash after a supplied signature");
          },
        },
      },
    };
    try {
      const result = await executeX402Payment(context, {
        resource: RESOURCE,
        mandate: fixture.mandate,
        agent: fixture.agent,
        signingMode: "human",
        signedTransaction: "signed-wire",
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.action, "x402_verified");
      assert.equal(result.structuredContent.challenge.protocol, CUSTOM_PROTOCOL);
      assert.equal(result.structuredContent.proofKind, "settled-receipt-pda");
      assert.equal(result.structuredContent.proof.version, CUSTOM_X402_VERSION);
      assert.equal(result.structuredContent.challenge.recipient, recipient);
      assert.equal(preparedInput.recipient, recipient);
      assert.equal(calls.filter(([url]) => url.endsWith("/v1/payments")).length, 1);
      assert.equal(calls.filter(([url]) => url === RESOURCE).length, 2);
    } finally {
      globalThis.fetch = old;
    }
  });
});

test("standard v2 is recognized but unavailable before wallet, signing, or settlement", async () => {
  await allowOrigin(async () => {
    const owner = address();
    const envelope = standardV2Envelope({ payTo: owner });
    const calls = [];
    const old = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push([String(url), init]);
      if (String(url) === RESOURCE) {
        return new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const context = {
      backendUrl: "https://backend.example",
      backendAuthToken: "fixture",
      client: {
        getSupportedAsset: async () => {
          throw new Error("must not inspect the asset registry for unsupported v2");
        },
        preparePayment: async () => {
          throw new Error("must not prepare a custom settlement for standard v2");
        },
        getCurrentSlot: async () => {
          throw new Error("must not read slot for standard v2");
        },
        connection: {
          getLatestBlockhash: async () => {
            throw new Error("must not request a blockhash for standard v2");
          },
        },
      },
    };
    try {
      const executed = await executeX402Payment(context, {
        resource: RESOURCE,
        mandate: address(),
        agent: address(),
        signingMode: "human",
        signedTransaction: "must-not-be-used",
      });
      assert.equal(executed.isError, true);
      assert.equal(executed.structuredContent.action, "x402_unsupported_sponsor");
      assert.equal(executed.structuredContent.mode, "unsupported-sponsor");
      assert.equal(executed.structuredContent.protocol, STANDARD_V2_PROTOCOL);
      assert.equal(executed.structuredContent.merchantOwner, owner);
      assert.equal(executed.structuredContent.recipient, undefined);
      assert.equal(executed.structuredContent.sponsorAvailable, false);
      assert.equal(calls.length, 1);

      const prepared = await prepareX402Payment(context, {
        challenge: envelope,
        mandate: address(),
        agent: address(),
      });
      assert.equal(prepared.structuredContent.action, "x402_unsupported_sponsor");
      assert.equal(prepared.structuredContent.merchantOwner, owner);
    } finally {
      globalThis.fetch = old;
    }
  });
});
