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
