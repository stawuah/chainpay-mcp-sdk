// Owner workspace display math: amount formatting, the shared mint metadata
// store, totals by mint, the usage ring and collection states.
// Display only — nothing here signs, submits or reads a network.
import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

async function loadModule(entryPoint) {
  const outfile = join(frontendRoot, `test/.tmp-${entryPoint.replace(/\//g, "-")}.mjs`);
  await esbuild.build({ absWorkingDir: frontendRoot, entryPoints: [entryPoint], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error",
    // The SDK is consumed as the real package (only its plain-word tables are used here).
    external: ["@chainpay/sdk", "@solana/web3.js"] });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await unlink(outfile).catch(() => {});
  return module;
}

const { formatDisplayAmount } = await loadModule("src/ui/amount/formatDisplayAmount.ts");
const { createMintMetadataStore, mintMetadataKey } = await loadModule("src/ui/amount/mintMetadataStore.ts");
const { totalsByMint, usageRing } = await loadModule("src/dashboard/overview/spending.ts");
const { deriveCollectionState, knownCount } = await loadModule("src/ui/workspace/collectionModel.ts");
const { summarizeCards, cardsAttention } = await loadModule("src/dashboard/overview/cardsSummary.ts");

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("formatDisplayAmount groups thousands and keeps at least two fraction digits", () => {
  assert.equal(formatDisplayAmount(1_250_000_000n, 6), "1,250.00");
  assert.equal(formatDisplayAmount("91500000", 6), "91.50");
  assert.equal(formatDisplayAmount(5_000_000n, 6), "5.00");
  assert.equal(formatDisplayAmount(1n, 6), "0.000001");
});

test("formatDisplayAmount keeps every significant digit: 4.500001 is never rounded", () => {
  assert.equal(formatDisplayAmount(4_500_001n, 6), "4.500001");
  assert.equal(formatDisplayAmount(4_500_000n, 6), "4.50");
  assert.equal(formatDisplayAmount(4_510_000n, 6), "4.51");
});

test("formatDisplayAmount is exact above 2^53", () => {
  const huge = 2n ** 64n + 123n; // 18446744073709551739
  assert.equal(formatDisplayAmount(huge, 6), "18,446,744,073,709.551739");
  assert.equal(formatDisplayAmount("9007199254740993", 0), "9,007,199,254,740,993.00");
  assert.equal(formatDisplayAmount(9_007_199_254_740_993n, 6), "9,007,199,254.740993");
});

test("formatDisplayAmount handles zero, decimals 0 and decimals 9", () => {
  assert.equal(formatDisplayAmount(0n, 6), "0.00");
  assert.equal(formatDisplayAmount(0n, 0), "0.00");
  assert.equal(formatDisplayAmount(1250n, 0), "1,250.00");
  assert.equal(formatDisplayAmount(1_000_000_001n, 9), "1.000000001");
  assert.equal(formatDisplayAmount(1_500_000_000n, 9), "1.50");
  assert.equal(formatDisplayAmount(123_456_789_000_000_000n, 9), "123,456,789.00");
});

test("formatDisplayAmount refuses floats, garbage and invalid decimals instead of guessing", () => {
  assert.throws(() => formatDisplayAmount("1.5", 6), TypeError);
  assert.throws(() => formatDisplayAmount("abc", 6), TypeError);
  assert.throws(() => formatDisplayAmount(1n, -1), RangeError);
  assert.throws(() => formatDisplayAmount(1n, 1.5), RangeError);
  assert.throws(() => formatDisplayAmount(1n, Number.NaN), RangeError);
});

test("metadata store dedupes concurrent reads of one mint", async () => {
  let calls = 0;
  const gate = deferred();
  const store = createMintMetadataStore({ network: "devnet", fetchDecimals: async () => { calls += 1; return gate.promise; } });
  assert.equal(store.ensure("MintA").status, "loading");
  assert.equal(store.ensure("MintA").status, "loading");
  const loads = [store.load("MintA"), store.load("MintA")];
  gate.resolve(6);
  const settled = await Promise.all(loads);
  assert.equal(calls, 1);
  assert.deepEqual(settled, [{ status: "verified", decimals: 6 }, { status: "verified", decimals: 6 }]);
  assert.equal(store.decimals("MintA"), 6);
  await store.load("MintA");
  assert.equal(calls, 1, "a verified mint is not read again");
});

test("metadata store: unavailable never becomes 0 and retry reads again", async () => {
  let attempt = 0;
  const store = createMintMetadataStore({ network: "devnet", fetchDecimals: async () => { attempt += 1; if (attempt === 1) throw new Error("RPC blocked"); return 6; } });
  const first = await store.load("MintA");
  assert.equal(first.status, "unavailable");
  assert.equal(first.error, "RPC blocked");
  assert.equal("decimals" in first, false, "an unavailable mint carries no decimals");
  assert.equal(store.decimals("MintA"), null, "never 0");
  const again = await store.load("MintA");
  assert.equal(again.status, "unavailable", "load does not silently retry");
  const retried = await store.retry("MintA");
  assert.deepEqual(retried, { status: "verified", decimals: 6 });
  assert.equal(attempt, 2);
});

test("metadata store rejects invalid decimals as unavailable", async () => {
  for (const bad of [-1, 1.5, 300, Number.NaN]) {
    const store = createMintMetadataStore({ network: "devnet", fetchDecimals: async () => bad });
    const state = await store.load("MintA");
    assert.equal(state.status, "unavailable", `decimals ${bad}`);
    assert.equal(store.decimals("MintA"), null);
  }
});

test("metadata store re-keys on a network change and drops reads from the old network", async () => {
  const gates = { devnet: deferred(), mainnet: deferred() };
  let network = "devnet";
  const store = createMintMetadataStore({ network, fetchDecimals: async () => gates[network].promise });
  store.ensure("MintA");
  network = "mainnet";
  store.setNetwork("mainnet");
  assert.equal(mintMetadataKey("mainnet", "MintA"), "mainnet:MintA");
  assert.equal(store.get("MintA"), undefined, "nothing carried over to the new network");
  store.ensure("MintA");
  gates.devnet.resolve(9); // the old network answers late
  await flush();
  assert.equal(store.get("MintA").status, "loading", "a late devnet answer is not applied to mainnet");
  gates.mainnet.resolve(6);
  await flush(); await flush();
  assert.deepEqual(store.get("MintA"), { status: "verified", decimals: 6 });
  store.setNetwork("devnet");
  assert.equal(store.get("MintA"), undefined, "the stale devnet read never landed");
});

test("metadata store notifies subscribers on every transition", async () => {
  const store = createMintMetadataStore({ network: "devnet", fetchDecimals: async () => 6 });
  const seen = [];
  const stop = store.subscribe(() => seen.push(store.get("MintA")?.status));
  await store.load("MintA");
  stop();
  assert.deepEqual(seen, ["loading", "verified"]);
});

const mandate = (over) => ({ allowedMint: "USDC", status: "active", amountSpent: 0n, totalLimit: 0n, ...over });

test("totals stay separate by mint and count only active permissions toward the ring", () => {
  const totals = totalsByMint([
    mandate({ amountSpent: 91_500_000n, totalLimit: 250_000_000n }),
    mandate({ amountSpent: 8_250_000n, totalLimit: 100_000_000n, status: "paused" }),
    mandate({ amountSpent: 40_000_000n, totalLimit: 40_000_000n, status: "expired" }),
    mandate({ allowedMint: "PYUSD", amountSpent: 1n, totalLimit: 10n }),
  ]);
  assert.deepEqual(totals.map((total) => total.mint), ["USDC", "PYUSD"]);
  const usdc = totals[0];
  assert.equal(usdc.active.spent, 91_500_000n);
  assert.equal(usdc.active.limit, 250_000_000n);
  assert.equal(usdc.active.remaining, 158_500_000n);
  assert.equal(usdc.active.count, 1);
  assert.equal(usdc.permissionCount, 3);
  assert.equal(totals[1].active.remaining, 9n);
});

test("remaining allowance never goes negative when spent exceeds the limit", () => {
  const [total] = totalsByMint([mandate({ amountSpent: 12n, totalLimit: 10n })]);
  assert.equal(total.active.remaining, 0n);
});

test("usage ring math: normal, warning, exhausted, zero limit and unavailable", () => {
  assert.deepEqual(usageRing({ spent: 91_500_000n, limit: 250_000_000n, decimalsKnown: true }), { kind: "normal", percent: 36.6, fraction: 0.366, warning: false });
  assert.equal(usageRing({ spent: 90n, limit: 100n, decimalsKnown: true }).warning, true, "warning at 90%");
  assert.equal(usageRing({ spent: 89n, limit: 100n, decimalsKnown: true }).warning, false);
  assert.deepEqual(usageRing({ spent: 40n, limit: 40n, decimalsKnown: true }), { kind: "exhausted", percent: 100, fraction: 1, warning: true });
  assert.deepEqual(usageRing({ spent: 50n, limit: 40n, decimalsKnown: true }), { kind: "exhausted", percent: 100, fraction: 1, warning: true }, "clamped");
  assert.deepEqual(usageRing({ spent: 0n, limit: 0n, decimalsKnown: true }), { kind: "unavailable", reason: "zero-limit" });
  assert.deepEqual(usageRing({ spent: 5n, limit: 100n, decimalsKnown: false }), { kind: "unavailable", reason: "metadata" });
  const big = usageRing({ spent: 2n ** 70n, limit: 2n ** 71n, decimalsKnown: true });
  assert.equal(big.percent, 50, "bigint scaling stays exact above 2^53");
});

test("collection states: unknown is never zero", () => {
  assert.equal(deriveCollectionState({ signedIn: false, status: "ready", count: 0 }), "signed-out");
  assert.equal(deriveCollectionState({ status: "loading", count: 0 }), "loading");
  assert.equal(deriveCollectionState({ status: "error", count: 0 }), "failed");
  assert.equal(deriveCollectionState({ status: "error", count: 2 }), "partial");
  assert.equal(deriveCollectionState({ status: "ready", count: 0, failedSources: 1 }), "failed");
  assert.equal(deriveCollectionState({ status: "ready", count: 3, failedSources: 1 }), "partial");
  assert.equal(deriveCollectionState({ status: "ready", count: 0 }), "empty");
  assert.equal(deriveCollectionState({ status: "ready", count: 2 }), "loaded");
  assert.equal(knownCount("failed", 0), null);
  assert.equal(knownCount("signed-out", 0), null);
  assert.equal(knownCount("partial", 4), null, "a partial count is not a total");
  assert.equal(knownCount("empty", 0), 0);
});

test("cards summary counts lifecycle states and carries no amounts", () => {
  const card = (over) => ({ cardId: "c", label: "x", lastFour: "4242", issuerState: "OPEN", mirror: { state: "acknowledged" }, freeze: { onChain: false, issuer: "confirmed" }, billing: { label: "b", carriedCreditCents: "999999" }, ...over });
  const summary = summarizeCards([card({}), card({ freeze: { onChain: true, issuer: "confirmed" } }), card({})]);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.lifecycle.map((row) => [row.key, row.count]), [["active", 2], ["frozen", 1]]);
  assert.equal(JSON.stringify(summary).includes("999999"), false, "no private amounts leave the adapter");
  assert.deepEqual(Object.keys(summary).sort(), ["lifecycle", "total"]);
  assert.deepEqual(summarizeCards([]), { total: 0, lifecycle: [] });
});

test("cards attention: restore, unconfirmed and pending freezes need the owner; unread is never clear", () => {
  const card = (over) => ({ cardId: "c", label: "x", lastFour: "4242", issuerState: "OPEN", mirror: { state: "acknowledged" }, freeze: { onChain: false, issuer: "confirmed" }, ...over });
  const loaded = (cards, illustrative = false) => { const summary = summarizeCards(cards); return { state: summary.total ? "loaded" : "empty", summary, illustrative }; };

  const mixed = cardsAttention(loaded([
    card({}),
    card({ freeze: { onChain: true, issuer: "pending_issuer_confirmation" } }),
    card({ recovery: { state: "recovery_frozen" } }),
    card({ recovery: { state: "restored_pending_reconcile" } }),
    card({ freeze: { onChain: true, issuer: "failed" } }),
    card({ freeze: { onChain: true, issuer: "confirmed" } }),
  ], true));
  assert.equal(mixed.status, "checked");
  assert.equal(mixed.illustrative, true);
  assert.deepEqual(mixed.items.map((row) => [row.key, row.count]), [["needs_restore", 2], ["freeze_failed", 1], ["freeze_pending", 1]], "most urgent first; active and frozen need nothing");
  assert.deepEqual(mixed.items.map((row) => row.tone), ["warning", "critical", "info"], "same tones as the Cards area");

  const calm = cardsAttention(loaded([card({}), card({ freeze: { onChain: true, issuer: "confirmed" } })]));
  assert.deepEqual(calm, { status: "checked", items: [], illustrative: false }, "active and frozen cards are checked and clear");
  assert.deepEqual(cardsAttention(loaded([])), { status: "checked", items: [], illustrative: false }, "no cards is a checked clear");
  assert.deepEqual(cardsAttention({ state: "not-enabled" }), { status: "checked", items: [], illustrative: false }, "cards switched off: nothing to check");

  assert.deepEqual(cardsAttention({ state: "failed" }), { status: "unchecked", reason: "failed", items: [] }, "an unreadable list is not clear");
  assert.deepEqual(cardsAttention({ state: "signed-out" }), { status: "unchecked", reason: "signed-out", items: [] }, "signed out is not clear");
  assert.deepEqual(cardsAttention({ state: "loading" }), { status: "pending", items: [] }, "still reading is not clear yet");
  assert.deepEqual(cardsAttention({ state: "surprise" }), { status: "unchecked", reason: "failed", items: [] }, "an unknown state is not clear");
});
