import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { settlementKey, normalizeInvoiceHash } = await load("../src/owner/settlementKey.ts");

const WALLET = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const MANDATE = "6Hq9bPm1S9aibcrjhhw5d4uTQ2FG4VavKosvZ3EwtVd1";
const HASH = "e8a21464866270d217d60fac82e2a0874f97ae453ad42363bb7b5bc6c7d751a6";

/**
 * What the relay stores the payment under: MCP re-encodes the invoice hash as
 * bare lower-case hex before the relay derives the id from it.
 * See mcp-server/src/tools/execute_payment.ts and settlement-submit.ts.
 */
function relayPaymentId(mandate, invoiceHashAsSentToMcp) {
  const bytes = Buffer.from(invoiceHashAsSentToMcp.replace(/^0x/i, ""), "hex");
  const canonical = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const idempotencyKey = `${mandate}:${canonical}`;
  return `payment_${createHash("sha256").update(`${WALLET}:${idempotencyKey}`).digest("hex")}`;
}

/** What the browser polls: see beginSettlement in src/settlement.tsx. */
function browserPaymentId(key) {
  return `payment_${createHash("sha256").update(`${WALLET}:${key}`).digest("hex")}`;
}

test("a bare lower-case hash already agreed, and still does", () => {
  assert.equal(browserPaymentId(settlementKey(MANDATE, HASH)), relayPaymentId(MANDATE, HASH));
});

test("an upper-case invoice hash polls the id the relay actually wrote", () => {
  const upper = HASH.toUpperCase();
  assert.equal(browserPaymentId(settlementKey(MANDATE, upper)), relayPaymentId(MANDATE, upper));
});

test("an 0x-prefixed invoice hash polls the id the relay actually wrote", () => {
  const prefixed = `0x${HASH}`;
  assert.equal(browserPaymentId(settlementKey(MANDATE, prefixed)), relayPaymentId(MANDATE, prefixed));
});

test("every accepted spelling of one hash settles under a single id", () => {
  const ids = new Set([HASH, HASH.toUpperCase(), `0x${HASH}`, `0X${HASH.toUpperCase()}`, ` ${HASH} `]
    .map((spelling) => browserPaymentId(settlementKey(MANDATE, spelling))));
  assert.equal(ids.size, 1);
});

test("keying on the raw spelling is what stranded the payment", () => {
  // The behaviour before the fix, kept as the reason the fix exists: the browser
  // polled one id while the relay wrote another, so the payment 404s forever.
  const raw = browserPaymentId(`${MANDATE}:${HASH.toUpperCase()}`);
  assert.notEqual(raw, relayPaymentId(MANDATE, HASH.toUpperCase()));
});

test("a hash MCP would reject is passed through so the error names the hash", () => {
  assert.equal(normalizeInvoiceHash("not-a-hash"), "not-a-hash");
  assert.equal(normalizeInvoiceHash(""), "");
});
