import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../src/wallet/brands.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { matchingWalletBrand, resolveWalletIcon } = await import(moduleUrl);

test("matchingWalletBrand maps connected wallet names onto bundled marks", () => {
  assert.equal(matchingWalletBrand("Jupiter"), "jupiter");
  assert.equal(matchingWalletBrand("Jupiter Wallet"), "jupiter");
  assert.equal(matchingWalletBrand("Phantom"), "phantom");
  assert.equal(matchingWalletBrand("Solflare"), "solflare");
  assert.equal(matchingWalletBrand("MetaMask"), "metamask");
  assert.equal(matchingWalletBrand("Unknown Wallet"), undefined);
});

test("resolveWalletIcon prefers the Wallet Standard icon, then a bundled mark", () => {
  const bundled = { jupiter: "/jupiter.svg", phantom: "/phantom.svg" };
  assert.equal(resolveWalletIcon("Jupiter", "data:image/svg+xml;base64,abc", bundled), "data:image/svg+xml;base64,abc");
  assert.equal(resolveWalletIcon("Jupiter Wallet", undefined, bundled), "/jupiter.svg");
  assert.equal(resolveWalletIcon("Phantom", "  ", bundled), "/phantom.svg");
  assert.equal(resolveWalletIcon("Backpack", undefined, bundled), undefined);
});
