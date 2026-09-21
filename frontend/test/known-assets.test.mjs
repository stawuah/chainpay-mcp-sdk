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

// The table lives in the SDK so every surface names a mint the same way;
// frontend/src/config/knownAssets.ts only re-exports it.
const { KNOWN_ASSETS, knownAsset, assetOrder, assetLabel, UNKNOWN_ASSET_ORDER } = await load("../../sdk/src/known-assets.ts");
const reexport = await readFile(new URL("../src/config/knownAssets.ts", import.meta.url), "utf8");

// Verified against Solana Devnet RPC before registration: both are initialized
// mints with 6 decimals. EURC is a plain 82-byte SPL mint; USDG is Token-2022
// at 869 bytes with account type 1 (Mint) in the byte after the base length.
const DEVNET = {
  USDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  PYUSD: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
  EURC: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
  USDG: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7",
};

test("every devnet mint the protocol can enable is named", () => {
  for (const [label, mint] of Object.entries(DEVNET)) {
    assert.equal(knownAsset(mint)?.label, label, `${label} is not named`);
  }
});

test("a mint is never claimed by two assets", () => {
  const seen = new Set();
  for (const asset of KNOWN_ASSETS) {
    for (const mint of asset.mints) {
      assert.equal(seen.has(mint), false, `${mint} is listed twice`);
      seen.add(mint);
    }
  }
});

test("an asset's clusters share one label, so the dashboard reads the same on either", () => {
  const usdc = KNOWN_ASSETS.find((asset) => asset.label === "USDC");
  assert.equal(usdc.mints.length, 2);
  assert.equal(new Set(usdc.mints.map((mint) => knownAsset(mint).label)).size, 1);
});

test("named assets lead the list and an unnamed mint sorts last", () => {
  const order = Object.values(DEVNET).map(assetOrder);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "named assets are not in order");
  assert.equal(assetOrder("So11111111111111111111111111111111111111112"), UNKNOWN_ASSET_ORDER);
  assert.ok(Math.max(...order) < UNKNOWN_ASSET_ORDER);
});

test("naming an asset does not enable it", () => {
  // The table is presentation. If this ever gains a field that gates payment,
  // the on-chain registry has been duplicated in a place no one audits.
  for (const asset of KNOWN_ASSETS) {
    assert.deepEqual(Object.keys(asset).sort(), ["label", "mints", "order"]);
  }
});

test("the dashboard re-exports the SDK table instead of keeping a copy", () => {
  assert.match(reexport, /from "@chainpay\/sdk\/known-assets"/);
  assert.doesNotMatch(reexport, /mints:/, "a second mint table would drift from the SDK's");
});

test("an unnamed mint is labelled with the neutral word, not a guessed ticker", () => {
  assert.equal(assetLabel(DEVNET.USDG), "USDG");
  assert.equal(assetLabel("So11111111111111111111111111111111111111112"), "tokens");
});
