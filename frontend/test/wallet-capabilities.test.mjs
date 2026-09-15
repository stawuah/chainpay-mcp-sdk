import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

let loaded;
async function capabilities() {
  if (!loaded) {
    const source = await readFile(new URL("../src/wallet/capabilities.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    loaded = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  }
  return loaded;
}

function feature(versions) {
  return {
    "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: versions },
  };
}

test("missing advertisement is unverified and never enables v1 production", async () => {
  const caps = await capabilities();
  const report = caps.reportWalletCapabilities({
    source: "wallet-standard",
    name: "Jupiter",
    standardVersion: "1.0.0",
    chains: ["solana:devnet"],
    features: { "solana:signTransaction": { version: "1.0.0" } },
  });
  assert.deepEqual(report.advertisedVersions, []);
  assert.equal(report.v1Advertisement, "unverified");
  assert.equal(report.devnetChain, "advertised");
  assert.equal(report.productionTransactionFormat, "legacy");
  const copy = caps.describeWalletCapabilities(report);
  assert.match(copy.summary, /Not advertised/);
  assert.match(copy.summary, /v1 is unverified/);
  assert.match(copy.summary, /still builds legacy/);
  assert.equal(copy.productionLabel, "Legacy. v1 compile stays off until this wallet advertises 1.");
});

test("legacy-only and version 0 advertisements keep v1 unverified", async () => {
  const caps = await capabilities();
  const legacy = caps.reportWalletCapabilities({
    source: "wallet-standard",
    name: "Fixture",
    chains: ["solana:devnet"],
    advertisedVersions: ["legacy"],
  });
  const versioned = caps.reportWalletCapabilities({
    source: "wallet-standard",
    name: "Fixture",
    chains: ["solana:devnet"],
    advertisedVersions: ["legacy", 0],
  });
  assert.deepEqual(legacy.advertisedVersions, ["legacy"]);
  assert.deepEqual(versioned.advertisedVersions, ["legacy", "0"]);
  assert.equal(legacy.v1Advertisement, "unverified");
  assert.equal(versioned.v1Advertisement, "unverified");
});

test("numeric 1 turns on v1 compile for that wallet without claiming Jupiter signed", async () => {
  const caps = await capabilities();
  const report = caps.reportWalletCapabilities({
    source: "wallet-standard",
    name: "Jupiter",
    standardVersion: "1.0.0",
    chains: ["solana:devnet"],
    features: feature(["legacy", 0, 1]),
  });
  assert.deepEqual(report.advertisedVersions, ["legacy", "0", "1"]);
  assert.equal(report.v1Advertisement, "advertised");
  assert.equal(report.productionTransactionFormat, 1);
  const copy = caps.describeWalletCapabilities(report);
  assert.match(copy.summary, /legacy, 0, 1/);
  assert.match(copy.summary, /v1 compile is on/);
  assert.match(copy.summary, /not a Jupiter signing test/);
});

test("legacy injected wallets stay unverified even if a fixture advertises 1", async () => {
  const caps = await capabilities();
  const report = caps.reportWalletCapabilities({
    source: "legacy-injected",
    name: "Injected Solana wallet",
    advertisedVersions: [1],
    chains: ["solana:devnet"],
    features: feature([1]),
  });
  assert.equal(report.source, "legacy-injected");
  assert.deepEqual(report.advertisedVersions, []);
  assert.equal(report.v1Advertisement, "unverified");
  assert.equal(report.devnetChain, "unverified");
  assert.match(caps.describeWalletCapabilities(report).summary, /legacy injected/);
});

test("reads signTransaction and signAndSendTransaction and records Devnet chain evidence", async () => {
  const caps = await capabilities();
  const report = caps.reportWalletCapabilities({
    source: "wallet-standard",
    name: "Jupiter",
    chains: ["solana:mainnet"],
    accountChains: ["solana:devnet"],
    features: {
      "solana:signTransaction": { supportedTransactionVersions: ["legacy"] },
      "solana:signAndSendTransaction": { supportedTransactionVersions: [0, "1"] },
    },
  });
  assert.deepEqual(report.advertisedVersions, ["legacy", "0", "1"]);
  assert.equal(report.devnetChain, "advertised");
  assert.deepEqual(report.chains, ["solana:mainnet", "solana:devnet"]);
});

test("mainnet-only chains do not count as Devnet evidence", async () => {
  const caps = await capabilities();
  const report = caps.reportWalletCapabilities({
    source: "wallet-standard",
    name: "Jupiter",
    chains: ["solana:mainnet"],
    advertisedVersions: ["legacy", 0],
  });
  assert.equal(report.devnetChain, "other-solana");
  assert.match(caps.describeWalletCapabilities(report).chainLabel, /solana:devnet missing/);
});
