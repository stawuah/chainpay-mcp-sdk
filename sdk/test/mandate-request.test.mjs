import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  NOMINAL_SLOTS_PER_DAY,
  buildMandateRequestPayload,
  canonicalMandateRequest,
  decodeMandateRequestLink,
  encodeMandateRequestLink,
  formatHumanTokenAmount,
  mandateRequestSummary,
  parseHumanTokenAmount,
  signMandateRequest,
  verifyMandateRequest,
} from "../dist/index.js";
import { runChainPayCli } from "../dist/cli.js";

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SLOT = 400_000_000n;
const vendorKey = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 9));
const builderKey = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 11));
const payee = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 12)).publicKey.toBase58();
const agent = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 13)).publicKey.toBase58();
const otherKey = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 14)).publicKey.toBase58();

function vendorPayload(overrides = {}) {
  return buildMandateRequestPayload({
    role: "vendor",
    requester: vendorKey.publicKey.toBase58(),
    requesterName: "Acme Data Co",
    recipient: payee,
    mint: USDC_DEVNET,
    tokenProgram: "spl-token",
    maxPerPayment: "5000000",
    total: "50000000",
    decimals: 6,
    currentSlot: SLOT,
    days: 30,
    description: "Market data API, billed per call",
    poNumber: "PO-1042",
    nonce: "n-1",
    ...overrides,
  });
}

function granteePayload(overrides = {}) {
  return buildMandateRequestPayload({
    role: "grantee",
    requester: builderKey.publicKey.toBase58(),
    agent,
    mint: USDC_DEVNET,
    tokenProgram: "spl-token",
    total: "50000000",
    decimals: 6,
    currentSlot: SLOT,
    days: 14,
    description: "Hackathon API credits",
    nonce: "n-2",
    ...overrides,
  });
}

test("a signed vendor request verifies and hashes its canonical bytes", async () => {
  const signed = await signMandateRequest(vendorPayload(), vendorKey.secretKey);
  assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
  const result = await verifyMandateRequest(signed, SLOT);
  assert.equal(result.valid, true, result.reason);
  assert.match(result.requestHash, /^[0-9a-f]{64}$/);
  assert.equal(result.payload.suggestedExpirySlot, (SLOT + 30n * NOMINAL_SLOTS_PER_DAY).toString());
  assert.equal(result.payload.validUntilSlot, (SLOT + 7n * NOMINAL_SLOTS_PER_DAY).toString());
  const canonical = canonicalMandateRequest(signed.payload);
  assert.equal(
    canonical,
    JSON.stringify({
      version: 1,
      cluster: "devnet",
      role: "vendor",
      requester: vendorKey.publicKey.toBase58(),
      requesterName: "Acme Data Co",
      mint: USDC_DEVNET,
      tokenProgram: "spl-token",
      recipient: payee,
      suggestedMaxPerPayment: "5000000",
      suggestedTotal: "50000000",
      decimals: 6,
      suggestedExpirySlot: signed.payload.suggestedExpirySlot,
      validUntilSlot: signed.payload.validUntilSlot,
      description: "Market data API, billed per call",
      poNumber: "PO-1042",
      nonce: "n-1",
    }),
  );
  // Key order in the received object does not change the canonical bytes.
  const shuffled = Object.fromEntries(Object.entries(signed.payload).reverse());
  assert.equal(canonicalMandateRequest(shuffled), canonical);
  assert.equal((await verifyMandateRequest({ payload: shuffled, signature: signed.signature })).valid, true);
});

test("changing any signed field invalidates the request", async () => {
  const signed = await signMandateRequest(vendorPayload(), vendorKey.secretKey);
  const changes = {
    cluster: "mainnet-beta",
    requesterName: "Acme Data Co.",
    mint: otherKey,
    tokenProgram: "token-2022",
    recipient: otherKey,
    suggestedMaxPerPayment: "5000001",
    suggestedTotal: "50000001",
    decimals: 9,
    suggestedExpirySlot: "999999999999",
    validUntilSlot: "999999999999",
    description: "Market data API, billed per call!",
    poNumber: "PO-1043",
    nonce: "n-9",
  };
  for (const [key, value] of Object.entries(changes)) {
    const tampered = { ...signed, payload: { ...signed.payload, [key]: value } };
    const result = await verifyMandateRequest(tampered, SLOT);
    assert.equal(result.valid, false, `${key} change must invalidate`);
    assert.match(result.reason, /signature is invalid/, key);
  }
  for (const key of ["requesterName", "poNumber", "suggestedExpirySlot", "validUntilSlot"]) {
    const payload = { ...signed.payload };
    delete payload[key];
    assert.equal((await verifyMandateRequest({ ...signed, payload })).valid, false, `removing ${key}`);
  }
  const swappedRequester = { ...signed, payload: { ...signed.payload, requester: otherKey } };
  assert.equal((await verifyMandateRequest(swappedRequester)).valid, false);
  const extra = { ...signed, payload: { ...signed.payload, memo: "unsigned" } };
  assert.match((await verifyMandateRequest(extra)).reason, /Unknown mandate request field: memo/);
  const flipped = signed.signature.startsWith("A") ? `B${signed.signature.slice(1)}` : `A${signed.signature.slice(1)}`;
  assert.equal((await verifyMandateRequest({ ...signed, signature: flipped })).valid, false);
  assert.match((await verifyMandateRequest({ ...signed, signature: "a+b/" })).reason, /base64url/);
});

test("role rules: vendor names a payee, grantee names an agent", async () => {
  const grantee = await signMandateRequest(granteePayload(), builderKey.secretKey);
  const verified = await verifyMandateRequest(grantee, SLOT);
  assert.equal(verified.valid, true, verified.reason);
  assert.equal(verified.payload.agent, agent);
  assert.equal(verified.payload.recipient, undefined);
  assert.equal(verified.payload.suggestedMaxPerPayment, "50000000");

  assert.throws(() => vendorPayload({ recipient: undefined }), /recipient must be a Solana address/);
  assert.throws(() => granteePayload({ agent: undefined }), /agent must be a Solana address/);
  const vendorWithAgent = { ...vendorPayload(), agent };
  assert.match((await verifyMandateRequest({ payload: vendorWithAgent, signature: "" })).reason, /must not name an agent/);
  const granteeWithRecipient = { ...granteePayload(), recipient: payee };
  assert.match(
    (await verifyMandateRequest({ payload: granteeWithRecipient, signature: "" })).reason,
    /must not name a recipient/,
  );
});

test("field validation: bounds, lengths, and expiry", async () => {
  assert.throws(() => vendorPayload({ maxPerPayment: "60000000" }), /at least suggestedMaxPerPayment/);
  assert.throws(() => vendorPayload({ total: "18446744073709551616" }), /fit in u64/);
  assert.throws(() => vendorPayload({ total: "050" }), /unsigned integer string/);
  assert.throws(() => vendorPayload({ maxPerPayment: "0" }), /greater than zero/);
  assert.throws(() => vendorPayload({ description: "x".repeat(281) }), /at most 280/);
  assert.doesNotThrow(() => vendorPayload({ description: "é".repeat(280) }));
  assert.throws(() => vendorPayload({ description: "  " }), /must not be empty/);
  assert.throws(() => vendorPayload({ requesterName: "n".repeat(65) }), /at most 64/);
  assert.throws(() => vendorPayload({ poNumber: "p".repeat(65) }), /at most 64/);
  assert.throws(() => vendorPayload({ description: "line\nbreak" }), /control characters/);
  assert.throws(() => vendorPayload({ mint: "not-an-address" }), /mint must be a Solana address/);
  assert.throws(() => vendorPayload({ decimals: 256 }), /decimals/);
  assert.throws(() => vendorPayload({ days: 0 }), /days/);

  const signed = await signMandateRequest(vendorPayload(), vendorKey.secretKey);
  const atLinkExpiry = await verifyMandateRequest(signed, BigInt(signed.payload.validUntilSlot));
  assert.equal(atLinkExpiry.valid, false);
  assert.match(atLinkExpiry.reason, /link has expired/);
  assert.match(atLinkExpiry.requestHash, /^[0-9a-f]{64}$/);
  assert.equal((await verifyMandateRequest(signed)).valid, true, "no clock, no expiry check");
});

test("signing refuses a key that is not the requester", async () => {
  await assert.rejects(signMandateRequest(vendorPayload(), builderKey.secretKey), /does not match the requester/);
  // A 32-byte seed works too.
  const fromSeed = await signMandateRequest(vendorPayload(), vendorKey.secretKey.slice(0, 32));
  assert.equal((await verifyMandateRequest(fromSeed)).valid, true);
});

test("links round-trip from a URL, a fragment, or the bare value, and stay short", async () => {
  const signed = await signMandateRequest(vendorPayload(), vendorKey.secretKey);
  const link = encodeMandateRequestLink(signed, "https://chainpay-frontend.onrender.com/");
  assert.match(link, /^https:\/\/chainpay-frontend\.onrender\.com\/app\/requests\/permission#req=[A-Za-z0-9_-]+$/);
  assert.ok(link.length < 2000, `link is ${link.length} characters`);
  const fragment = link.slice(link.indexOf("#"));
  for (const input of [link, fragment, fragment.slice(1), fragment.slice(5)]) {
    const decoded = decodeMandateRequestLink(input);
    assert.deepEqual(decoded, signed);
    assert.equal((await verifyMandateRequest(decoded, SLOT)).valid, true);
  }
  assert.throws(() => decodeMandateRequestLink("https://x.example/app/requests/permission#req="), /No mandate request/);
  assert.throws(() => decodeMandateRequestLink("#req=@@@"), /damaged/);

  const longest = await signMandateRequest(
    vendorPayload({
      requesterName: "N".repeat(64),
      description: "D".repeat(280),
      poNumber: "P".repeat(64),
      nonce: "x".repeat(22),
    }),
    vendorKey.secretKey,
  );
  const longLink = encodeMandateRequestLink(longest, "https://chainpay-frontend.onrender.com");
  assert.ok(longLink.length < 2000, `longest typical link is ${longLink.length} characters`);
});

test("human amounts convert exactly and the summary reads plainly", async () => {
  assert.equal(parseHumanTokenAmount("5", 6), "5000000");
  assert.equal(parseHumanTokenAmount("0.000001", 6), "1");
  assert.equal(parseHumanTokenAmount("18446744073709.551615", 6), "18446744073709551615");
  assert.throws(() => parseHumanTokenAmount("18446744073709.551616", 6), /too large/);
  assert.throws(() => parseHumanTokenAmount("0.0000001", 6), /6 decimal places/);
  assert.throws(() => parseHumanTokenAmount("1e3", 6), /Not a token amount/);
  assert.throws(() => parseHumanTokenAmount("-1", 6), /Not a token amount/);
  assert.equal(formatHumanTokenAmount("4500000", 6), "4.5");
  assert.equal(formatHumanTokenAmount("50000000", 6), "50");

  const vendor = vendorPayload();
  assert.equal(
    mandateRequestSummary(vendor, SLOT),
    `Asks for up to 5 USDC per payment, 50 USDC total, 30 days. Payee ${payee.slice(0, 4)}…${payee.slice(-4)}. Link valid 7 days.`,
  );
  assert.equal(
    mandateRequestSummary(granteePayload(), SLOT),
    `Asks for up to 50 USDC total, 14 days. Agent ${agent.slice(0, 4)}…${agent.slice(-4)} signs the payments. Link valid 7 days.`,
  );
});

function captureStdout() {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    // node --test shares stdout with its reporter; keep only what the CLI wrote.
    if (typeof chunk === "string") chunks.push(chunk);
    return true;
  };
  return { text: () => chunks.join(""), restore: () => { process.stdout.write = original; } };
}

const offlineDeps = {
  getCurrentSlot: async () => SLOT,
  getMintDecimals: async () => 6,
  getTokenProgram: async () => "spl-token",
};

test("chainpay request-mandate prints a verifiable link and summary, never the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chainpay-request-"));
  const keypairPath = join(dir, "vendor.json");
  writeFileSync(keypairPath, JSON.stringify(Array.from(vendorKey.secretKey)));
  const out = captureStdout();
  let code;
  try {
    code = await runChainPayCli([
      "request-mandate",
      "--keypair", keypairPath,
      "--mint", USDC_DEVNET,
      "--recipient", payee,
      "--per-payment", "5",
      "--total", "50",
      "--days", "30",
      "--description", "Market data API",
      "--po", "PO-1042",
      "--name", "Acme Data Co",
      "--app-url", "http://localhost:5173",
    ], {}, offlineDeps);
  } finally {
    out.restore();
  }
  assert.equal(code, 0);
  const text = out.text();
  assert.match(text, /^http:\/\/localhost:5173\/app\/requests\/permission#req=/);
  assert.match(text, /Asks for up to 5 USDC per payment, 50 USDC total, 30 days\. Payee .+\. Link valid 7 days\./);
  const secretJson = JSON.stringify(Array.from(vendorKey.secretKey));
  assert.ok(!text.includes(secretJson.slice(1, 40)));
  const decoded = decodeMandateRequestLink(text.split("\n")[0]);
  assert.equal(decoded.payload.requester, vendorKey.publicKey.toBase58());
  assert.equal(decoded.payload.poNumber, "PO-1042");
  assert.equal((await verifyMandateRequest(decoded, SLOT)).valid, true);
});

test("chainpay request-budget uses the default app URL and the agent key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chainpay-request-"));
  const keypairPath = join(dir, "builder.json");
  writeFileSync(keypairPath, JSON.stringify(Array.from(builderKey.secretKey)));
  const out = captureStdout();
  try {
    assert.equal(await runChainPayCli([
      "request-budget",
      "--keypair", keypairPath,
      "--agent", agent,
      "--mint", USDC_DEVNET,
      "--total", "50",
      "--days", "14",
      "--description", "Hackathon API credits",
      "--decimals", "6",
      "--token-program", "spl-token",
      "--json",
    ], {}, { ...offlineDeps, getMintDecimals: async () => { throw new Error("must not call RPC"); } }), 0);
  } finally {
    out.restore();
  }
  const card = JSON.parse(out.text());
  assert.match(card.link, /^https:\/\/chainpay-frontend\.onrender\.com\/app\/requests\/permission#req=/);
  assert.equal(card.request.payload.role, "grantee");
  assert.equal(card.request.payload.agent, agent);
  assert.equal(card.request.payload.suggestedTotal, "50000000");
  assert.match(card.summary, /^Asks for up to 50 USDC total, 14 days\. Agent /);
  await assert.rejects(
    runChainPayCli(["request-budget", "--keypair", keypairPath, "--mint", USDC_DEVNET, "--total", "5", "--days", "1", "--description", "x"], {}, offlineDeps),
    /--agent/,
  );
  await assert.rejects(
    runChainPayCli(["request-mandate", "--keypair", keypairPath, "--mint", USDC_DEVNET, "--recipient", payee, "--per-payment", "5.0000001", "--total", "5", "--days", "1", "--description", "x"], {}, offlineDeps),
    /6 decimal places/,
  );
});
