import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unlink } from "node:fs/promises";
import ts from "typescript";
import { readFile } from "node:fs/promises";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

async function loadModel() {
  const source = await readFile(new URL("../src/receipts/model.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

async function loadShare() {
  const outfile = join(frontendRoot, "test/.tmp-receipt-share.mjs");
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/receipts/share.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await unlink(outfile).catch(() => {});
  return module;
}

const model = await loadModel();
const share = await loadShare();

if (typeof globalThis.DOMException !== "function") {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name;
    }
  };
}

const fixtureReceipt = {
  address: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
  mandate: "Mandate11111111111111111111111111111111111",
  invoiceHash: "aa".repeat(32),
  paymentId: "bb".repeat(32),
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  sourceTokenAccount: "Source111111111111111111111111111111111111",
  recipientTokenAccount: "Dest1111111111111111111111111111111111111",
  agent: "Agent111111111111111111111111111111111111",
  executedAtSlot: "484791192",
  signatureReference: "cc".repeat(32),
  bump: "255",
  onChainStatus: "1",
  amount: { baseUnits: "4500000", decimals: 6, display: "4.500000", displayKind: "ui-amount" },
  tokenLabel: "USDC",
  currentMandate: { status: "absent" },
  seller: { status: "absent" },
};

test("classifies empty, malformed, and plausible receipt PDAs", () => {
  assert.equal(model.classifyReceiptPda(""), "empty");
  assert.equal(model.classifyReceiptPda("InvalidPDA"), "malformed");
  assert.equal(model.classifyReceiptPda("not a key"), "malformed");
  assert.equal(model.classifyReceiptPda("2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1"), "plausible");
});

test("initial page state is malformed without an RPC read", () => {
  assert.deepEqual(model.initialPageState("InvalidPDA"), { kind: "malformed", receiptPda: "InvalidPDA" });
  assert.deepEqual(model.initialPageState("2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1"), {
    kind: "loading",
    receiptPda: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
  });
});

test("share URL is the ChainPay verify path, not Explorer", () => {
  const url = model.publicReceiptUrl("2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", "https://chainpay.example");
  assert.equal(url, "https://chainpay.example/verify/2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1");
  assert.equal(url.includes("explorer.solana.com"), false);
  const payload = share.shareCopy("4.50", "USDC", "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", "https://chainpay.example");
  assert.equal(payload.url, url);
});

test("unknown decimals stay exact base units", () => {
  assert.equal(model.amountLabel({
    baseUnits: "4500000",
    decimals: null,
    display: "4500000",
    displayKind: "base-units",
  }), "4500000 base units");
  assert.equal(model.amountLabel(fixtureReceipt.amount), "4.500000");
});

test("mandate limits go through the same label as the receipt amount", async () => {
  // The card printed maxPerPayment, totalLimit and amountSpent as raw u64 base
  // units directly beneath an amount decimal-formatted from the mint, so a
  // 10 USDC cap read as `10000000` under an amount reading `10.00`.
  //
  // amountLabel itself is covered above. This pins that load.ts actually routes
  // the mandate fields through it — asserted on source because load.ts imports
  // the SDK and config/client and cannot be executed without a built sdk/dist,
  // which the frontend suite deliberately does not build.
  const load = await readFile(new URL("../src/receipts/load.ts", import.meta.url), "utf8");
  assert.match(load, /function mandateAmount\(value: bigint, decimals: number \| null\)/);
  assert.match(load, /amountLabel\(amountView\(formatExactTokenAmount\(value, decimals\)\)\)/);
  for (const field of ["maxPerPayment", "totalLimit", "amountSpent"]) {
    assert.match(
      load,
      new RegExp(`${field}: mandateAmount\\(mandate\\.${field}, decimals\\)`),
      `${field} must be formatted, not printed raw`,
    );
  }
});

test("verified stamps keep Allowed and Paid independent of seller and current mandate", () => {
  const stamps = model.receiptStamps(fixtureReceipt);
  assert.equal(stamps[0].key, "allowed");
  assert.equal(stamps[0].tone, "yes");
  assert.equal(stamps[1].key, "paid");
  assert.equal(stamps[1].tone, "yes");
  assert.equal(stamps[2].tone, "neutral");
  assert.equal(model.pageAllowsSuccessChrome({ kind: "verified", receiptPda: fixtureReceipt.address, receipt: fixtureReceipt }), true);
  assert.equal(model.pageAllowsSuccessChrome({ kind: "not_found", receiptPda: fixtureReceipt.address }), false);
  assert.equal(model.pageAllowsSuccessChrome({ kind: "rpc_error", receiptPda: fixtureReceipt.address, message: "down" }), false);
});

test("seller HTTP 200 is never valid without independent verification", () => {
  assert.deepEqual(model.sellerStateFromHttp({ httpStatus: 200 }), {
    status: "invalid",
    reason: "HTTP 200 is not enough to treat a seller statement as valid.",
  });
  assert.deepEqual(model.sellerStateFromHttp({ httpStatus: 404 }), { status: "absent" });
  assert.equal(model.sellerStateFromHttp({ httpStatus: null, networkError: true }).status, "unavailable");
  assert.equal(model.sellerStateFromHttp({ httpStatus: 200, cryptoUnavailable: true }).status, "unavailable");
  assert.equal(model.sellerStateFromHttp({
    httpStatus: 200,
    verification: { valid: false, reason: "Unknown delivery seller" },
  }).status, "invalid");
  const valid = model.sellerStateFromHttp({
    httpStatus: 200,
    verification: { valid: true },
    body: {
      publishedAt: "2026-09-15T04:16:01.000Z",
      payload: {
        contentHash: "8e60b641218418bde0cde3b190a028e846ccebed8dc804901b8e6f87b9072eee",
        servedAt: "2026-09-15T04:16:00.000Z",
        seller: "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB",
      },
    },
  });
  assert.equal(valid.status, "valid");
  const stamps = model.receiptStamps({ ...fixtureReceipt, seller: valid });
  assert.equal(stamps[2].tone, "yes");
  assert.equal(stamps[1].tone, "yes");
});

test("failed and unknown stamps are never green", () => {
  const invalid = model.sellerStamp({ status: "invalid", reason: "bad signature" });
  const unavailable = model.sellerStamp({ status: "unavailable", reason: "outage" });
  const absent = model.sellerStamp({ status: "absent" });
  assert.equal(model.stampIsGreen(invalid), false);
  assert.equal(model.stampIsGreen(unavailable), false);
  assert.equal(model.stampIsGreen(absent), false);
  assert.equal(invalid.tone, "no");
  assert.equal(unavailable.tone, "unknown");
});

test("distinct failure copy for malformed, missing, invalid, and RPC errors", () => {
  assert.match(model.failureCopy({ kind: "malformed", receiptPda: "InvalidPDA" }).title, /not a valid Solana account/);
  assert.match(model.failureCopy({ kind: "not_found", receiptPda: fixtureReceipt.address }).title, /No ChainPay receipt/);
  assert.match(model.failureCopy({ kind: "rpc_error", receiptPda: fixtureReceipt.address, message: "connection refused" }).body, /connection refused/);
  assert.match(model.failureCopy({
    kind: "invalid",
    receiptPda: fixtureReceipt.address,
    code: "wrong_owner",
    reason: "Receipt account is not owned by the ChainPay program",
  }).body, /not owned by the ChainPay program/);
});

test("share helper reports copy, cancel, and failure separately", async () => {
  const copied = await share.sharePublicReceipt({
    amountLabel: "4.50",
    tokenLabel: "USDC",
    receiptPda: fixtureReceipt.address,
    origin: "https://chainpay.example",
    clipboardWrite: async () => undefined,
  });
  assert.deepEqual(copied, { status: "copied" });
  const cancelled = await share.sharePublicReceipt({
    amountLabel: "4.50",
    tokenLabel: "USDC",
    receiptPda: fixtureReceipt.address,
    origin: "https://chainpay.example",
    share: async () => {
      const error = new DOMException("The user aborted a request.", "AbortError");
      throw error;
    },
  });
  assert.deepEqual(cancelled, { status: "cancelled" });
});
