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
