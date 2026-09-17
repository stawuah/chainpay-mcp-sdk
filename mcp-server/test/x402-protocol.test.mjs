import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID as SDK_SPL_TOKEN, standardV2RecipientTokenAccount } from "@chainpay/sdk";
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

function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** ChainPay may read this merchant. It says nothing about settling against it. */
function allowOrigin(run) {
  return withEnv({ CHAINPAY_X402_ALLOWED_ORIGINS: "https://merchant.example" }, run);
}

/** ChainPay may read this merchant AND it verifies a ChainPay receipt PDA. */
function allowReceiptMerchant(run) {
  return withEnv({
    CHAINPAY_X402_ALLOWED_ORIGINS: "https://merchant.example",
    CHAINPAY_X402_RECEIPT_MERCHANTS: "https://merchant.example",
  }, run);
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

test("never infers the ChainPay rail from the network name alone", () => {
  // An unversioned document claiming network "solana-devnet" used to be routed
  // to the custom rail and could reach settlement. Any 402 server can put that
  // string in a response; only a server actually on this rail sends the version.
  assert.throws(
    () => parsePaymentRequiredDocument({
      scheme: "exact",
      network: "solana-devnet",
      amount: "1000",
      asset: address(),
      payTo: address(),
      resource: RESOURCE,
    }, RESOURCE),
    (error) => error instanceof X402ProtocolError
      && error.code === "malformed"
      && /explicit version/.test(error.message),
  );

  // The same document with the version present is still accepted, so the real
  // merchant flow is untouched.
  const versioned = parsePaymentRequiredDocument(customEnvelope(), RESOURCE);
  assert.equal(versioned.kind, "custom");
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

test("standard v2 is quoted against mandate but does not settle without settleIfReceiptMerchant", async () => {
  await allowOrigin(async () => {
    const owner = address();
    const mint = address();
    const envelope = standardV2Envelope({ payTo: owner, asset: mint });
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
        getSupportedAsset: async () => ({ enabled: true, tokenProgram: SPL_TOKEN_PROGRAM_ID }),
        preparePayment: async () => ({
          receiptAddress: address(),
          preflight: { valid: true, currentSlot: 1n, checks: [] },
          transaction: preparedFixture().transaction,
        }),
        getCurrentSlot: async () => 1n,
        connection: {
          getLatestBlockhash: async () => {
            throw new Error("must not request a blockhash for quoted v2");
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
      assert.equal(executed.structuredContent.wouldSettle, false);
      assert.equal(executed.structuredContent.reason, "facilitator_required");
      assert.equal(typeof executed.structuredContent.derivedRecipientTokenAccount, "string");
      assert.equal(executed.structuredContent.mandateQuote?.preflightValid, true);
      assert.equal(calls.length, 1);
      assert.equal(calls.some(([url]) => url.endsWith("/v1/payments")), false);

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

test("allowlisted v2 with settleIfReceiptMerchant settles through mandate receipt proof", async () => {
  await allowReceiptMerchant(async () => {
    const owner = address();
    const mint = address();
    const derivedRecipient = standardV2RecipientTokenAccount(
      { merchantOwner: owner, asset: mint, amount: "100000", resource: RESOURCE, network: SOLANA_DEVNET_CAIP2 },
      SDK_SPL_TOKEN,
    );
    const fixture = preparedFixture();
    const envelope = standardV2Envelope({ payTo: owner, asset: mint });
    const calls = [];
    let preparedInput;
    const old = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push([String(url), init]);
      if (String(url) === RESOURCE && !init.headers?.["X-PAYMENT"]) {
        return new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
          },
        });
      }
      if (String(url).endsWith("/v1/payments")) {
        return Response.json({
          payment_id: `payment_${"c".repeat(64)}`,
          status: "confirmed",
          signature: "v2-settled-signature",
          receipt_address: fixture.receiptAddress,
        });
      }
      if (String(url) === RESOURCE && init.headers?.["X-PAYMENT"]) {
        const proof = JSON.parse(init.headers["X-PAYMENT"]);
        assert.equal(proof.version, CUSTOM_X402_VERSION);
        assert.equal(proof.payload.signature, "v2-settled-signature");
        assert.equal(proof.payload.receiptPDA, fixture.receiptAddress);
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
          recipient: derivedRecipient,
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
        settleIfReceiptMerchant: true,
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.action, "x402_verified");
      assert.equal(result.structuredContent.challenge.protocol, CUSTOM_PROTOCOL);
      assert.equal(result.structuredContent.proofKind, "settled-receipt-pda");
      assert.equal(preparedInput.recipient, derivedRecipient);
      assert.notEqual(preparedInput.recipient, owner);
      assert.equal(calls.filter(([url]) => url.endsWith("/v1/payments")).length, 1);
      assert.equal(calls.filter(([url]) => url === RESOURCE).length, 2);
    } finally {
      globalThis.fetch = old;
    }
  });
});

test("a readable merchant that is not a receipt merchant never settles, even with the flag", async () => {
  // The read allowlist says ChainPay may fetch this merchant. It does not say the merchant
  // verifies a ChainPay receipt PDA. Before CHAINPAY_X402_RECEIPT_MERCHANTS existed, the
  // settle gate re-checked the read allowlist, which resourceUrl had already enforced, so
  // the only real condition was the caller's own settleIfReceiptMerchant argument.
  await allowOrigin(async () => {
    const owner = address();
    const mint = address();
    const envelope = standardV2Envelope({ payTo: owner, asset: mint });
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
        // Read-only work is fine on the refusal path: it produces the mandate quote that
        // replaces the old dead end. What must not happen is a settlement.
        getSupportedAsset: async () => ({ enabled: true, tokenProgram: SPL_TOKEN_PROGRAM_ID }),
        getCurrentSlot: async () => 1n,
        preparePayment: async () => preparedFixture(),
        getPayment: async () => { throw new Error("must not read a settled payment"); },
        connection: {
          getLatestBlockhash: async () => { throw new Error("must not fetch a blockhash"); },
        },
      },
    };
    try {
      const result = await executeX402Payment(context, {
        resource: RESOURCE,
        mandate: address(),
        agent: address(),
        signingMode: "delegated",
        settleIfReceiptMerchant: true,
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.action, "x402_unsupported_sponsor");
      // One fetch: the challenge itself. Nothing was relayed and nothing settled.
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], RESOURCE);
      assert.equal(calls.filter(([url]) => url.endsWith("/v1/payments")).length, 0);
      assert.equal(calls.filter(([, init]) => init.headers?.["X-PAYMENT"]).length, 0);
    } finally {
      globalThis.fetch = old;
    }
  });
});

test("an empty receipt-merchant list fails closed", async () => {
  await withEnv({
    CHAINPAY_X402_ALLOWED_ORIGINS: "https://merchant.example",
    CHAINPAY_X402_RECEIPT_MERCHANTS: "   ",
  }, async () => {
    const envelope = standardV2Envelope({ payTo: address(), asset: address() });
    const old = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
      },
    });
    const context = {
      backendUrl: "https://backend.example",
      backendAuthToken: "fixture",
      client: {
        getSupportedAsset: async () => ({ enabled: true, tokenProgram: SPL_TOKEN_PROGRAM_ID }),
        getCurrentSlot: async () => 1n,
        preparePayment: async () => preparedFixture(),
        getPayment: async () => { throw new Error("must not read a settled payment"); },
      },
    };
    try {
      const result = await executeX402Payment(context, {
        resource: RESOURCE,
        mandate: address(),
        agent: address(),
        signingMode: "delegated",
        settleIfReceiptMerchant: true,
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.action, "x402_unsupported_sponsor");
    } finally {
      globalThis.fetch = old;
    }
  });
});

test("MPP WWW-Authenticate returns mpp_unsupported without settlement", async () => {
  await allowOrigin(async () => {
    const old = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", {
      status: 402,
      headers: { "WWW-Authenticate": 'Payment id="abc", method="tempo", intent="charge"' },
    });
    const context = {
      backendUrl: "https://backend.example",
      backendAuthToken: "fixture",
      client: {
        preparePayment: async () => {
          throw new Error("must not prepare payment for MPP");
        },
      },
    };
    try {
      const executed = await executeX402Payment(context, {
        resource: RESOURCE,
        mandate: address(),
        agent: address(),
        signingMode: "human",
      });
      assert.equal(executed.isError, true);
      assert.equal(executed.structuredContent.action, "mpp_unsupported");
      assert.equal(executed.structuredContent.intent, "charge");
    } finally {
      globalThis.fetch = old;
    }
  });
});
