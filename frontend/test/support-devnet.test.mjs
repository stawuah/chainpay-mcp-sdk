// Audit 2026-10-05 R4: support tips are Devnet test tokens only.
//   - config fails closed unless every setting is present and says Devnet,
//   - the on-chain readiness check blocks signing on any wrong account,
//   - an uncertain send is re-checked by the same signature, and the card says
//     "pending indexing" instead of asking for another tip.
import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");
const { PublicKey } = await import("@solana/web3.js");

const PROGRAM = "D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH";
const A = "3yS1JFVT284y8z1LC9MRoWxZjzFrdoD5axKsZiyMsfC7";
const B = "4iYFsZcZXQLTfykuzRwY19SxRja53Vm6jSf6CuTx6Kjt";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SIGNATURE = "5".repeat(88);
const ENV = {
  VITE_SUPPORT_LIVE: "true",
  VITE_SUPPORT_CLUSTER: "devnet",
  VITE_SUPPORT_PROGRAM_ID: PROGRAM,
  VITE_SUPPORT_TRACKER_URL: "https://example-123.convex.site/support/v1",
  VITE_SUPPORT_RECIPIENT_A: A,
  VITE_SUPPORT_RECIPIENT_B: B,
};

async function bundle(name, contents, { env = ENV, stubs = {} } = {}) {
  const outfile = join(frontendRoot, `test/.tmp-support-devnet-${name}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    stdin: { contents, resolveDir: join(frontendRoot, "src/support"), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
    loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".webp": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime", "@solana/web3.js"],
    define: { "import.meta.env": JSON.stringify(env) },
    logLevel: "error",
    plugins: [{
      name: "stubs",
      setup(build) {
        const names = Object.keys(stubs);
        if (!names.length) return;
        const filter = new RegExp(`^(${names.map((n) => n.replace(/[./]/g, "\\$&")).join("|")})$`);
        build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js", resolveDir: frontendRoot }));
      },
    }],
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

const lib = await bundle("lib", `
  export * from "./config";
  export * from "./readiness";
  export * from "./recovery";
  export { supportAccounts } from "./donation";
`);

test("config: Devnet SOL and Devnet USDC only, no swaps, Devnet explorer links", () => {
  assert.equal(lib.SUPPORT_CLUSTER, "devnet");
  assert.equal(lib.USDC_MINT, DEVNET_USDC);
  assert.equal(lib.SWAP_ENABLED, false);
  assert.equal(lib.WALLET_CHAIN, "solana:devnet");
  assert.equal(lib.explorerTx("abc"), "https://explorer.solana.com/tx/abc?cluster=devnet");
  assert.equal(lib.explorerAddress("abc"), "https://explorer.solana.com/address/abc?cluster=devnet");
  assert.equal(lib.SUPPORT_RPC_URL, "https://example-123.convex.site/support/rpc", "derives the relay next to the tracker");
  assert.equal(lib.supportReady(), true);
});

test("config fails closed on anything but complete Devnet settings", () => {
  const base = lib.SUPPORT_SETTINGS;
  assert.equal(lib.supportConfigProblem(base), null);
  const bad = {
    off: { live: false },
    mainnet: { cluster: "mainnet" },
    absent: { cluster: "" },
    "mainnet-beta": { cluster: "mainnet-beta" },
    "no program": { programId: "" },
    "junk program": { programId: "not-a-key" },
    "zero program": { programId: "11111111111111111111111111111111" },
    "test-config mint as program": { programId: "AB3FQHskSYuWVw4M9EpGdxNzrAjBNiYGpbH4CVzLFene" },
    "no tracker": { trackerUrl: "" },
    "http tracker": { trackerUrl: "http://example.convex.site/support/v1" },
    "tracker with a query": { trackerUrl: "https://example.convex.site/support/v1?key=x" },
    "tracker with credentials": { trackerUrl: "https://user:pw@example.convex.site/support/v1" },
    "missing recipient": { recipients: [A, ""] },
    "zero recipient": { recipients: ["11111111111111111111111111111111", B] },
    "test recipient": { recipients: ["7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9", B] },
    "same recipient": { recipients: [A, A] },
  };
  for (const [name, change] of Object.entries(bad)) {
    const settings = { ...base, ...change };
    assert.ok(lib.supportConfigProblem(settings), name);
    assert.equal(lib.supportReady(settings), false, name);
  }
});

test("config: a build with no support env at all is closed", async () => {
  const empty = await bundle("empty", `export * from "./config";`, { env: {} });
  assert.equal(empty.supportReady(), false);
  assert.equal(empty.SUPPORT_RPC_URL, "https://api.devnet.solana.com", "never falls back to mainnet");
  const mainnet = await bundle("mainnet", `export * from "./config";`, { env: { ...ENV, VITE_SUPPORT_CLUSTER: "mainnet" } });
  assert.equal(mainnet.supportReady(), false);
  assert.equal(mainnet.USDC_MINT, DEVNET_USDC);
});

// A Devnet chain where everything is set up right; each test breaks one thing.
function chain(overrides = {}) {
  const accounts = lib.supportAccounts(PROGRAM, DEVNET_USDC);
  const key = (address) => new PublicKey(address).toBytes();
  const vaultData = new Uint8Array(lib.VAULT_SIZE);
  vaultData.set(lib.VAULT_DISCRIMINATOR, 0);
  vaultData.set(key(A), 8);
  vaultData.set(key(B), 40);
  const usdcData = new Uint8Array(165);
  usdcData.set(key(DEVNET_USDC), 0);
  usdcData.set(accounts.vault.toBytes(), 32);
  usdcData[108] = 1;
  const mintData = new Uint8Array(82);
  mintData[44] = 6;
  mintData[45] = 1;
  const state = {
    genesis: DEVNET_GENESIS,
    [accounts.programId.toBase58()]: { owner: new PublicKey(LOADER), executable: true, data: new Uint8Array(36) },
    [accounts.vault.toBase58()]: { owner: accounts.programId, executable: false, data: vaultData },
    [accounts.vaultUsdc.toBase58()]: { owner: new PublicKey(TOKEN), executable: false, data: usdcData },
    [DEVNET_USDC]: { owner: new PublicKey(TOKEN), executable: false, data: mintData },
  };
  const edit = typeof overrides === "function" ? overrides : () => Object.assign(state, overrides);
  edit(state, accounts);
  return {
    accounts,
    rpc: {
      getGenesisHash: async () => { if (state.genesis instanceof Error) throw state.genesis; return state.genesis; },
      getAccountInfo: async (address) => state[address.toBase58()] ?? null,
    },
  };
}

test("readiness: a correctly set-up Devnet vault is ready, with its decoded ledger", async () => {
  const { rpc, accounts } = chain();
  const result = await lib.checkSupportChain(rpc);
  assert.equal(result.state, "ready");
  assert.equal(result.accounts.vault.toBase58(), accounts.vault.toBase58());
  assert.deepEqual(result.vault.recipients, [A, B]);
});

test("readiness: every wrong program, vault, owner, recipient or mint blocks signing", async () => {
  const cases = {
    "not Devnet": (s) => { s.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"; },
    "program missing": (s, a) => { delete s[a.programId.toBase58()]; },
    "program not executable": (s, a) => { s[a.programId.toBase58()].executable = false; },
    "program wrong loader": (s, a) => { s[a.programId.toBase58()].owner = new PublicKey(TOKEN); },
    "vault missing": (s, a) => { delete s[a.vault.toBase58()]; },
    "vault wrong owner": (s, a) => { s[a.vault.toBase58()].owner = new PublicKey(TOKEN); },
    "vault wrong shape": (s, a) => { s[a.vault.toBase58()].data[0] ^= 1; },
    "vault too short": (s, a) => { s[a.vault.toBase58()].data = s[a.vault.toBase58()].data.slice(0, 100); },
    "placeholder recipients": (s, a) => { s[a.vault.toBase58()].data.fill(0, 8, 72); },
    "recipients swapped": (s, a) => { const d = s[a.vault.toBase58()].data; const first = d.slice(8, 40); d.copyWithin(8, 40, 72); d.set(first, 40); },
    "recipient rotated away": (s, a) => { s[a.vault.toBase58()].data.set(new PublicKey(PROGRAM).toBytes(), 40); },
    "USDC account missing": (s, a) => { delete s[a.vaultUsdc.toBase58()]; },
    "USDC account not a token account": (s, a) => { s[a.vaultUsdc.toBase58()].owner = a.programId; },
    "USDC account holds mainnet USDC": (s, a) => { s[a.vaultUsdc.toBase58()].data.set(new PublicKey(MAINNET_USDC).toBytes(), 0); },
    "USDC account owned by someone else": (s, a) => { s[a.vaultUsdc.toBase58()].data.set(new PublicKey(A).toBytes(), 32); },
    "USDC account delegated": (s, a) => { s[a.vaultUsdc.toBase58()].data[72] = 1; },
    "USDC account frozen/uninitialized": (s, a) => { s[a.vaultUsdc.toBase58()].data[108] = 2; },
    "USDC account close authority": (s, a) => { s[a.vaultUsdc.toBase58()].data[129] = 1; },
    "mint missing": (s) => { delete s[DEVNET_USDC]; },
    "mint wrong decimals": (s) => { s[DEVNET_USDC].data[44] = 9; },
    "RPC down": (s) => { s.genesis = new Error("fetch failed"); },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const { rpc } = chain(edit);
    const result = await lib.checkSupportChain(rpc);
    assert.equal(result.state, "blocked", name);
    assert.equal(result.retry, true, `${name}: the page offers a retry`);
    assert.ok(result.reason.length > 10, `${name}: says why`);
  }
});

test("readiness: incomplete settings block without reading the chain", async () => {
  let reads = 0;
  const rpc = { getGenesisHash: async () => { reads++; return DEVNET_GENESIS; }, getAccountInfo: async () => { reads++; return null; } };
  const result = await lib.checkSupportChain(rpc, { ...lib.SUPPORT_SETTINGS, cluster: "mainnet" });
  assert.equal(result.state, "blocked");
  assert.equal(result.retry, false, "retrying can't fix a build setting");
  assert.equal(reads, 0);
});

function memoryStore() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
}

test("recovery: the signed tip is saved, reloaded exactly, and cleared only for its own signature", () => {
  const storage = memoryStore();
  const tip = { signature: SIGNATURE, lastValidBlockHeight: 1234, asset: "USDC", amount: "5000000", label: "5 USDC", savedAt: 1 };
  lib.savePendingTip(tip, storage);
  assert.deepEqual(lib.loadPendingTip(storage), tip);
  lib.clearPendingTip("6".repeat(88), storage);
  assert.deepEqual(lib.loadPendingTip(storage), tip, "another signature doesn't clear it");
  lib.clearPendingTip(SIGNATURE, storage);
  assert.equal(lib.loadPendingTip(storage), null);
  for (const junk of ["{", JSON.stringify({ ...tip, signature: "x" }), JSON.stringify({ ...tip, amount: "1.5" }), JSON.stringify({ ...tip, asset: "BONK" })]) {
    storage.setItem("chainpay-support:pending-tip:v1", junk);
    assert.equal(lib.loadPendingTip(storage), null, junk);
  }
  assert.equal(lib.loadPendingTip(null), null, "no storage is fine");
});

test("recovery: re-checking the same signature only ever answers confirmed, failed, expired or unknown", async () => {
  const tip = { signature: SIGNATURE, lastValidBlockHeight: 100 };
  const rpc = (status, height = 50) => ({
    getSignatureStatuses: async (sigs, config) => {
      assert.deepEqual(sigs, [SIGNATURE], "asks about the same signature");
      assert.equal(config.searchTransactionHistory, true);
      if (status instanceof Error) throw status;
      return { value: [status] };
    },
    getBlockHeight: async () => height,
  });
  assert.deepEqual(await lib.recheckTip(rpc({ err: null, confirmationStatus: "finalized" }), tip), { status: "confirmed" });
  assert.deepEqual(await lib.recheckTip(rpc({ err: null, confirmationStatus: "confirmed" }), tip), { status: "confirmed" });
  assert.equal((await lib.recheckTip(rpc({ err: { InstructionError: [0, "x"] } }), tip)).status, "failed");
  assert.deepEqual(await lib.recheckTip(rpc({ err: null, confirmationStatus: "processed" }), tip), { status: "unknown" });
  assert.deepEqual(await lib.recheckTip(rpc(null, 50), tip), { status: "unknown" }, "still inside its blockhash window");
  assert.deepEqual(await lib.recheckTip(rpc(null, 101), tip), { status: "expired" }, "expired with no trace: it didn't land");
  assert.deepEqual(await lib.recheckTip(rpc(new Error("503")), tip), { status: "unknown" }, "an RPC failure is not an outcome");
  assert.equal(lib.isIndexed(SIGNATURE, [{ signature: SIGNATURE }]), true);
  assert.equal(lib.isIndexed(SIGNATURE, []), false);
  assert.equal(lib.isIndexed(SIGNATURE, undefined), false);
});

// --- The card itself: an uncertain tip is never followed by a prompt to tip again.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/support", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const card = await bundle("tipcard", `export { TipCard } from "./TipCard";`, {
  stubs: {
    "./send": `
      export const supportConnection = () => ({
        getSignatureStatuses: async (sigs) => { globalThis.__statusCalls = [...(globalThis.__statusCalls ?? []), ...sigs]; return { value: [globalThis.__status ?? null] }; },
        getBlockHeight: async () => 1,
      });
      export const checkBalance = async () => null;
      export const friendlyError = () => "error";
      export const sendSigned = async () => { throw new Error("must not send"); };
      export const signForSupport = async () => { throw new Error("must not sign"); };
      export const base58 = () => "";
    `,
    "./price": "export const usdHint = () => null; export const useSolUsd = () => null;",
  },
});

async function renderCard(props) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const accounts = lib.supportAccounts(PROGRAM, DEVNET_USDC);
  const full = {
    walletState: { wallet: null, options: [], connectingId: "", error: "", connect: async () => null, disconnect() {}, refresh() {} },
    accounts,
    ensureReady: async () => null,
    indexed: () => false,
    onSent() {},
    onRefreshLedger() {},
    ...props,
  };
  await act(async () => root.render(createElement(card.TipCard, full)));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { host, rerender: async (more) => { await act(async () => root.render(createElement(card.TipCard, { ...full, ...more }))); }, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const SAVED = { signature: SIGNATURE, lastValidBlockHeight: 1000, asset: "SOL", amount: "100000000", label: "0.1 SOL", savedAt: Date.now() };

test("card: an earlier uncertain tip is re-checked by its signature, with no way to tip again", async () => {
  window.localStorage.setItem("chainpay-support:pending-tip:v1", JSON.stringify(SAVED));
  globalThis.__status = null;
  globalThis.__statusCalls = [];
  const { host, unmount } = await renderCard();
  try {
    const status = host.querySelector('[data-testid="tip-status"]');
    assert.ok(status, "opens on the saved tip, not the amount step");
    assert.equal(status.dataset.state, "unknown");
    assert.match(host.textContent, /Not confirmed yet/);
    assert.match(host.textContent, /don't send another one/);
    assert.match(host.textContent, /0\.1 SOL/);
    assert.match(host.textContent, /Devnet test tokens/);
    assert.doesNotMatch(host.textContent, /Send another|Choose an amount|Try again/);
    const explorer = [...host.querySelectorAll("a")].find((a) => /Devnet explorer/.test(a.textContent));
    assert.equal(explorer.getAttribute("href"), `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`);
    assert.deepEqual(globalThis.__statusCalls, [SIGNATURE]);

    // It lands: the card says so, then waits for the ledger instead of offering another tip.
    globalThis.__status = { err: null, confirmationStatus: "confirmed" };
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent.includes("Check again"));
    await act(async () => { again.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 20)); });
    assert.deepEqual(globalThis.__statusCalls, [SIGNATURE, SIGNATURE], "the same signature again, nothing new signed");
    const done = host.querySelector('[data-testid="tip-done"]');
    assert.ok(done);
    assert.equal(done.dataset.indexed, "no");
    assert.match(host.textContent, /Pending indexing/);
    assert.match(host.textContent, /nothing more to send/);
    assert.match(host.textContent, /not a ChainPay payment receipt/);
    assert.doesNotMatch(host.textContent, /Send another/);
    assert.ok(window.localStorage.getItem("chainpay-support:pending-tip:v1"), "kept until the ledger shows it");
  } finally {
    await unmount();
    window.localStorage.clear();
  }
});

test("card: once the ledger lists the tip it is cleared, and only then can you send another", async () => {
  window.localStorage.setItem("chainpay-support:pending-tip:v1", JSON.stringify(SAVED));
  globalThis.__status = { err: null, confirmationStatus: "finalized" };
  const { host, rerender, unmount } = await renderCard();
  try {
    assert.match(host.textContent, /Pending indexing/);
    await rerender({ indexed: (sig) => sig === SIGNATURE });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.equal(host.querySelector('[data-testid="tip-done"]').dataset.indexed, "yes");
    assert.match(host.textContent, /on the ledger/);
    assert.match(host.textContent, /Send another/);
    assert.equal(window.localStorage.getItem("chainpay-support:pending-tip:v1"), null);
  } finally {
    await unmount();
    window.localStorage.clear();
  }
});

test("card: a tip that confirmed long ago doesn't hold the card", async () => {
  window.localStorage.setItem("chainpay-support:pending-tip:v1", JSON.stringify({ ...SAVED, savedAt: Date.now() - 60 * 60_000 }));
  globalThis.__status = { err: null, confirmationStatus: "finalized" };
  const { host, unmount } = await renderCard();
  try {
    assert.match(host.textContent, /Choose an amount/);
    assert.equal(window.localStorage.getItem("chainpay-support:pending-tip:v1"), null);
  } finally {
    await unmount();
    window.localStorage.clear();
  }
});

test("card: a definite failure or expiry clears the saved tip and lets you try again", async () => {
  for (const [status, words] of [[{ err: { InstructionError: [0, "x"] } }, /failed on-chain/], [null, /expired before landing/]]) {
    window.localStorage.setItem("chainpay-support:pending-tip:v1", JSON.stringify({ ...SAVED, lastValidBlockHeight: 0 }));
    globalThis.__status = status;
    const { host, unmount } = await renderCard();
    try {
      assert.match(host.textContent, words);
      assert.match(host.textContent, /Try again/);
      assert.equal(window.localStorage.getItem("chainpay-support:pending-tip:v1"), null);
    } finally {
      await unmount();
      window.localStorage.clear();
    }
  }
});

test("card: only Devnet SOL and Devnet USDC, no Other token, no dollar presets", async () => {
  const { host, unmount } = await renderCard();
  try {
    const tokens = [...host.querySelectorAll('[aria-label="Token"] button')].map((b) => b.textContent);
    assert.deepEqual(tokens, ["SOL", "USDC"]);
    assert.doesNotMatch(host.textContent, /Other|Jupiter|\$\d/);
    assert.match(host.textContent, /Devnet test tokens · no real value/);
  } finally {
    await unmount();
  }
});
