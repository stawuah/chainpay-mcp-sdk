import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { tokenProgramAccountType } = await load("../src/owner/tokenAccounts.ts");

/** Byte 165 records the kind once a Token-2022 account carries extensions. */
function extended(kind, length) {
  const data = new Uint8Array(length);
  data[165] = kind;
  return data;
}

test("a classic SPL mint is recognised by its exact length", () => {
  // Devnet USDC, 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU, is 82 bytes.
  assert.equal(tokenProgramAccountType(new Uint8Array(82)), "mint");
});

test("a classic SPL token account is recognised by its exact length", () => {
  assert.equal(tokenProgramAccountType(new Uint8Array(165)), "account");
});

test("a Token-2022 mint carrying extensions is a mint, not a token account", () => {
  // Devnet PYUSD, CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM, is 869 bytes
  // with byte 165 set to 1. A length test alone reads this as a token account
  // and accepts the mint as a payment destination.
  assert.equal(tokenProgramAccountType(extended(1, 869)), "mint");
});

test("a Token-2022 token account carrying extensions is a token account", () => {
  assert.equal(tokenProgramAccountType(extended(2, 182)), "account");
});

test("anything else is unknown rather than assumed usable", () => {
  assert.equal(tokenProgramAccountType(new Uint8Array(0)), "unknown");
  assert.equal(tokenProgramAccountType(new Uint8Array(100)), "unknown");
  assert.equal(tokenProgramAccountType(extended(0, 200)), "unknown");
  assert.equal(tokenProgramAccountType(extended(7, 200)), "unknown");
});
