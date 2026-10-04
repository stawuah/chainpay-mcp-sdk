import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DEVNET_TEE_URL,
  MAGICBLOCK_DEVNET_TEE_MEASUREMENTS,
  createTdxQuoteProvider,
  parseMeasurementAllowlist,
  parseTdxQuote,
  teeMeasurementAllowlist,
  verifyTee,
} from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/devnet-tee-quote.json", import.meta.url), "utf8"));
const shared = JSON.parse(readFileSync(new URL("../../shared/cards/tee-measurements.json", import.meta.url), "utf8"));
const rawQuote = Uint8Array.from(Buffer.from(fixture.quote, "base64"));
const challenge = Uint8Array.from(Buffer.from(fixture.challenge, "base64"));

/** A TEE double that serves the recorded Devnet quote for the recorded challenge. */
function quoteServer(quote = rawQuote) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ quote: Buffer.from(quote).toString("base64") }), { status: 200 });
    },
  };
}

test("pinned Devnet values carry MagicBlock's provenance and a rotation slot", () => {
  const pinned = MAGICBLOCK_DEVNET_TEE_MEASUREMENTS;
  assert.equal(pinned.provenance, "confirmed by MagicBlock to ChainPay, 2026-10-04 (direct, unsigned)");
  assert.equal(pinned.teeUrl, DEVNET_TEE_URL);
  assert.equal(pinned.previous, null);
  assert.deepEqual(teeMeasurementAllowlist().map((m) => m.label), ["current"]);
  const extra = { ...pinned.current, mrTd: "e".repeat(96), label: "previous" };
  assert.deepEqual(teeMeasurementAllowlist([extra]).map((m) => m.label), ["current", "previous"]);
});

test("shared/cards/tee-measurements.json (for Axum) mirrors the SDK pin", () => {
  assert.equal(shared.provenance, MAGICBLOCK_DEVNET_TEE_MEASUREMENTS.provenance);
  assert.equal(shared.validator, MAGICBLOCK_DEVNET_TEE_MEASUREMENTS.validator);
  assert.equal(shared.teeUrl, DEVNET_TEE_URL);
  // Axum parses the same list through CARDS_TEE_MEASUREMENTS; the SDK parser accepts both key styles.
  assert.deepEqual(parseMeasurementAllowlist(JSON.stringify(shared.allowlist)), teeMeasurementAllowlist());
});

test("a recorded Devnet quote parses to exactly the pinned measurements", () => {
  const { measurements, reportData } = parseTdxQuote(rawQuote);
  const { label, ...pinned } = MAGICBLOCK_DEVNET_TEE_MEASUREMENTS.current;
  assert.equal(label, "current");
  assert.deepEqual(measurements, pinned);
  assert.deepEqual(reportData, challenge);
  const sgx = rawQuote.slice();
  sgx[4] = 0;
  assert.throws(() => parseTdxQuote(sgx), /Not a TDX quote/);
  assert.throws(() => parseTdxQuote(rawQuote.subarray(0, 100)), /truncated/);
});

test("enforce passes only when the DCAP chain verifies and the build matches", async () => {
  const server = quoteServer();
  let verified = 0;
  const provider = createTdxQuoteProvider({ fetch: server.fetch, randomBytes: () => challenge.slice(), verifyQuote: async (raw) => { verified += 1; assert.deepEqual(raw, rawQuote); } });
  const result = await verifyTee({ mode: "enforce", provider });
  assert.deepEqual(
    { hardware: result.hardware, measurements: result.measurements, ok: result.ok, label: result.label, matchedLabel: result.matchedLabel },
    { hardware: "verified", measurements: "matched", ok: true, label: "Genuine TDX hardware and expected MagicBlock build verified (Devnet)", matchedLabel: "current" },
  );
  assert.equal(verified, 1, "one quote: the measured build is the one whose signature was checked");
  assert.equal(server.calls.length, 1);
  assert.ok(server.calls[0].startsWith(`${DEVNET_TEE_URL}/quote?challenge=`));
});

test("failing states stay honest", async () => {
  const fixedChallenge = () => challenge.slice();
  // Chain not checked: says so, never "hardware verified".
  const bound = await verifyTee({ mode: "enforce", provider: createTdxQuoteProvider({ fetch: quoteServer().fetch, randomBytes: fixedChallenge }) });
  assert.equal(bound.hardware, "challenge_bound");
  assert.equal(bound.measurements, "matched");
  assert.equal(bound.ok, false, "enforce needs the DCAP chain, not just an echoed challenge");
  assert.equal((await verifyTee({ mode: "report", provider: createTdxQuoteProvider({ fetch: quoteServer().fetch, randomBytes: fixedChallenge }) })).ok, true);
  assert.match(bound.label, /Intel's hardware signature wasn't checked/);
  assert.doesNotMatch(bound.label, /Genuine TDX hardware/);

  // Bad signature chain.
  const forged = await verifyTee({ mode: "enforce", provider: createTdxQuoteProvider({ fetch: quoteServer().fetch, randomBytes: fixedChallenge, verifyQuote: async () => { throw new Error("bad chain"); } }) });
  assert.deepEqual([forged.hardware, forged.ok], ["failed", false]);

  // Replayed quote: report data doesn't answer this challenge.
  const replay = await verifyTee({ mode: "enforce", provider: createTdxQuoteProvider({ fetch: quoteServer().fetch, verifyQuote: async () => {} }) });
  assert.deepEqual([replay.hardware, replay.ok], ["failed", false]);

  // Different build (one RTMR byte off): enforce pauses approvals.
  const other = rawQuote.slice();
  other[48 + 16 + 48 + 48 + 8 + 8 + 8 + 48 * 4 + 48] ^= 0xff; // first byte of RTMR1
  const mismatch = await verifyTee({ mode: "enforce", provider: createTdxQuoteProvider({ fetch: quoteServer(other).fetch, randomBytes: fixedChallenge, verifyQuote: async () => {} }) });
  assert.deepEqual([mismatch.hardware, mismatch.measurements, mismatch.ok], ["verified", "mismatch", false]);
  assert.match(mismatch.label, /isn't MagicBlock's confirmed Devnet build, so approvals are paused/);
  const reported = await verifyTee({ mode: "report", provider: createTdxQuoteProvider({ fetch: quoteServer(other).fetch, randomBytes: fixedChallenge, verifyQuote: async () => {} }) });
  assert.deepEqual([reported.measurements, reported.ok], ["mismatch", true]);

  // A pinned MROWNER must match even though Axum only compares MRTD/RTMR0-2.
  const owner = rawQuote.slice();
  owner[48 + 16 + 48 + 48 + 8 + 8 + 8 + 96] ^= 0x01;
  const ownerMismatch = await verifyTee({ mode: "enforce", provider: createTdxQuoteProvider({ fetch: quoteServer(owner).fetch, randomBytes: fixedChallenge, verifyQuote: async () => {} }) });
  assert.equal(ownerMismatch.measurements, "mismatch");

  // TEE down.
  const down = await verifyTee({ mode: "enforce", provider: createTdxQuoteProvider({ fetch: async () => new Response("nope", { status: 502 }) }) });
  assert.deepEqual([down.hardware, down.ok], ["failed", false]);
});

test("non-Devnet TEEs get no implicit allowlist", async () => {
  const provider = { verifyRpcIntegrity: async () => {} };
  const result = await verifyTee({ mode: "report", teeUrl: "https://mainnet-tee.example", provider });
  assert.equal(result.measurements, "pending");
  assert.equal((await verifyTee({ mode: "enforce", teeUrl: "https://mainnet-tee.example", provider })).ok, false);
});
