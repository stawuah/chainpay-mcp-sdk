import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChainPayCli } from "../dist/cli.js";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

test("chainpay --help explains read-only commands and never-sign rule", async () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await runChainPayCli(["--help"]);
    assert.equal(code, 0);
  } finally {
    process.stdout.write = original;
  }
  const text = chunks.join("");
  assert.match(text, /chainpay status/);
  assert.match(text, /chainpay receipts/);
  assert.match(text, /chainpay receipt/);
  assert.match(text, /chainpay pause/);
  assert.match(text, /never signs/);
});

test("cli binary --help exits 0", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /CHAINPAY_OWNER/);
});

test("status without owner fails closed", async () => {
  await assert.rejects(runChainPayCli(["status"], {}), /CHAINPAY_OWNER|Pass --owner/);
});

// Real base58 keys: the CLI validates addresses before it builds anything.
const OWNER_KEY = "4wvWX75iKx7TkT6B3mcazKZURywk3znTmCNfftcZ9Shp";
const MANDATE_KEY = "GQ3Xh4QnLcZ3sGVxkLYX65tHh79ALx9ecjfLU3KaL7M3";

test("pause --json prints the unsigned transaction and never submits", async () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let code;
  try {
    code = await runChainPayCli([
      "pause", MANDATE_KEY,
      "--owner", OWNER_KEY,
      "--json",
    ], {});
  } finally {
    process.stdout.write = original;
  }
  assert.equal(code, 0);
  const card = JSON.parse(chunks.join(""));
  assert.equal(card.action, "owner_wallet_signature_required");
  assert.deepEqual(card.transaction.requiredSigners, [OWNER_KEY]);
  assert.equal(card.mandate, MANDATE_KEY);
  assert.equal(card.transaction.instructions[0].name, "pause_mandate");
  assert.match(card.transaction.instructions[0].dataBase64, /^[A-Za-z0-9+/]+=*$/);
});

test("chainpay export writes one CSV row per receipt, newest first, with its limits source", async () => {
  const { exportReceiptsCsv } = await import("../dist/cli.js");
  const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const base = {
    mandate: MANDATE_KEY,
    invoiceHash: new Uint8Array(32).fill(1),
    paymentId: new Uint8Array(32).fill(2),
    mint,
    sourceTokenAccount: OWNER_KEY,
    recipientTokenAccount: OWNER_KEY,
    agent: OWNER_KEY,
    signatureReference: new Uint8Array(32),
    status: "confirmed",
    onChainStatus: 1,
    bump: 255,
  };
  const older = { ...base, address: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", amount: 4_500_001n, executedAtSlot: 100n, policySnapshot: null };
  const newer = {
    ...base,
    address: "3Rcpt2v2SnapshotFixture111111111111111111",
    amount: 4_500_000n,
    executedAtSlot: 200n,
    policySnapshot: { version: 1, maxPerPayment: 5_000_000n, totalLimit: 50_000_000n, amountSpentAfter: 12_000_000n, paymentCountAfter: 3n, maxPaymentCount: 10n, expiresAtSlot: 9_000n, cooldownSlots: 0n },
  };
  const client = {
    getMandatesByOwner: async (owner) => (owner === OWNER_KEY ? [{ address: MANDATE_KEY }] : []),
    getPaymentsByMandate: async () => [older, newer],
    getMintDecimals: async () => 6,
    connection: { getBlockTime: async (slot) => (slot === 200 ? Date.UTC(2026, 9, 1) / 1000 : null) },
  };
  const { csv, rowCount } = await exportReceiptsCsv(client, { owner: OWNER_KEY, appUrl: "https://chainpay.example" });
  assert.equal(rowCount, 2);
  const lines = csv.trimEnd().split("\r\n");
  assert.match(lines[0], /^Date,Description,Amount,Payee,Reference,/);
  assert.match(lines[1], /^2026-10-01,,4\.5,/);
  assert.match(lines[1], /,5,50,12,on-chain,3Rcpt2v2SnapshotFixture1+,https:\/\/chainpay\.example\/verify\//);
  assert.match(lines[2], /^,,4\.500001,/);
  assert.match(lines[2], /,,,,not-recorded,/);
});

test("chainpay export without owner fails closed", async () => {
  await assert.rejects(runChainPayCli(["export"], {}), /CHAINPAY_OWNER|Pass --owner/);
});
