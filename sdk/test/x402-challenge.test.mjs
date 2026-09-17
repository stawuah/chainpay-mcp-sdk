import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  CUSTOM_PROTOCOL,
  CUSTOM_X402_VERSION,
  SOLANA_DEVNET_CAIP2,
  STANDARD_V2_PROTOCOL,
  detectPaymentChallenge,
  parsePaymentRequiredDocument,
  parseMppWwwAuthenticate,
  unsupportedSponsorResult,
} from "../dist/x402-challenge.js";
import {
  detectedChallengeToPrepareFields,
  standardV2RecipientTokenAccount,
} from "../dist/x402-adapt.js";

function address() {
  return Keypair.generate().publicKey.toBase58();
}

test("SDK challenge parsers match custom and v2 discriminants", () => {
  const mint = address();
  const recipient = address();
  const custom = parsePaymentRequiredDocument({
    version: CUSTOM_X402_VERSION,
    accepts: [{
      scheme: "exact",
      network: "solana-devnet",
      maxAmountRequired: "1000",
      asset: mint,
      payTo: recipient,
      resource: "https://merchant.example/data",
      tokenProgram: "spl-token",
    }],
  });
  assert.equal(custom.kind, "custom");
  assert.equal(custom.option.protocol, CUSTOM_PROTOCOL);

  const owner = address();
  const v2 = parsePaymentRequiredDocument({
    x402Version: 2,
    resource: { url: "https://merchant.example/data" },
    accepts: [{
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      amount: "1000",
      asset: mint,
      payTo: owner,
      maxTimeoutSeconds: 60,
    }],
  });
  assert.equal(v2.kind, "standard-v2");
  assert.equal(v2.option.merchantOwner, owner);
});

test("detectPaymentChallenge reads PAYMENT-REQUIRED header", () => {
  const envelope = {
    x402Version: 2,
    resource: { url: "https://merchant.example/data" },
    accepts: [{
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      amount: "1000",
      asset: address(),
      payTo: address(),
      maxTimeoutSeconds: 60,
    }],
  };
  const headers = new Headers({
    "payment-required": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
  });
  const detected = detectPaymentChallenge(headers, {}, "https://merchant.example/data");
  assert.equal(detected.kind, "standard-v2");
});

test("standard v2 maps merchant owner to derived recipient ATA", async () => {
  const owner = address();
  const mint = address();
  const option = {
    protocol: STANDARD_V2_PROTOCOL,
    protocolLabel: "label",
    proofKind: "partially-signed-sponsored-transaction",
    network: SOLANA_DEVNET_CAIP2,
    scheme: "exact",
    amount: "1000",
    asset: mint,
    merchantOwner: owner,
    resource: "https://merchant.example/data",
  };
  const ata = standardV2RecipientTokenAccount(option, "spl-token");
  const fields = await detectedChallengeToPrepareFields({ kind: "standard-v2", option, envelope: {} }, "spl-token");
  assert.equal(fields.recipient, ata);
  assert.equal(fields.mint, mint);
});

test("parseMppWwwAuthenticate labels MPP without settling", () => {
  const parsed = parseMppWwwAuthenticate('Payment id="abc", method="tempo", intent="charge"');
  assert.equal(parsed?.action, "mpp_unsupported");
  assert.equal(parsed?.intent, "charge");
  assert.equal(parseMppWwwAuthenticate(null), null);
});

test("unsupportedSponsorResult includes mandate quote extras", () => {
  const owner = address();
  const result = unsupportedSponsorResult({
    protocol: STANDARD_V2_PROTOCOL,
    protocolLabel: "label",
    proofKind: "partially-signed-sponsored-transaction",
    network: SOLANA_DEVNET_CAIP2,
    scheme: "exact",
    amount: "1000",
    asset: address(),
    merchantOwner: owner,
    resource: "https://merchant.example/data",
  }, {
    derivedRecipientTokenAccount: address(),
    mandateQuote: { status: "ready", preflightValid: true, checks: [] },
  });
  assert.equal(result.wouldSettle, false);
  assert.equal(result.reason, "facilitator_required");
  assert.equal(result.mandateQuote?.status, "ready");
});
