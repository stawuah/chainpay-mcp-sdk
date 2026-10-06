// Audit 2026-10-05 A3 and A5: pasted receipt links resolve locally, and a
// late retry for one receipt never lands on another.
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

const PDA_A = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const PDA_B = "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1";

// Every receipt read goes through globalThis.__receiptLoader, so a test can
// hold one answer back and release it late.
function stubLoaderPlugin() {
  return {
    name: "stub-receipt-loader",
    setup(build) {
      build.onResolve({ filter: /receipts\/load$|^\.\/load$/ }, () => ({ path: "receipt-load", namespace: "stub" }));
      build.onResolve({ filter: /^\.\/owner$/ }, () => ({ path: "receipt-owner", namespace: "stub" }));
      build.onLoad({ filter: /^receipt-load$/, namespace: "stub" }, () => ({
        contents: "export const loadPublicReceiptView = (pda, options) => globalThis.__receiptLoader(pda, options); export const peekPublicReceiptCache = () => undefined;",
        loader: "js",
      }));
      build.onLoad({ filter: /^receipt-owner$/, namespace: "stub" }, () => ({
        contents: "export const loadOwnerReceiptContext = async () => ({ purchase: { status: 'none' }, order: { status: 'none' } });",
        loader: "js",
      }));
    },
  };
}

async function bundle(entry, name, plugins = [stubLoaderPlugin()]) {
  const outfile = join(frontendRoot, `test/.tmp-${name}-${Date.now()}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile,
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime", "@chainpayhq/sdk"],
    define: { "import.meta.env": "{}" },
    plugins,
    logLevel: "error",
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

// react-dom decides at load time whether the browser has input events, so a
// document must exist before it loads or typed text never reaches onChange.
installDom("https://chainpay.example/");
const { createRoot } = await import("react-dom/client");

function installDom(url) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url, pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.PopStateEvent = window.PopStateEvent;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

function verified(address, baseUnits, display) {
  return {
    kind: "verified",
    receiptPda: address,
    receipt: {
      address,
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
      amount: { baseUnits, decimals: 6, display, displayKind: "ui-amount" },
      tokenLabel: "USDC",
      currentMandate: { status: "absent" },
      seller: { status: "absent" },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = (ms = 10) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const buttonNamed = (host, name) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === name);

// --- A3: pasted links ------------------------------------------------------

const input = await bundle("src/verify/receiptInput.ts", "receipt-input", []);

test("a raw address and a full /verify link resolve to the same receipt", () => {
  const expected = { ok: true, receiptPda: PDA_A, hash: "" };
  for (const value of [
    PDA_A,
    `  ${PDA_A}\n`,
    `https://chainpay-mcp.vercel.app/verify/${PDA_A}`,
    `https://some-other-host.example/verify/${PDA_A}/`,
    `http://localhost:5173/verify/${PDA_A}?utm=x`,
    `chainpay.example/verify/${PDA_A}`,
    `/verify/${PDA_A}`,
  ]) {
    assert.deepEqual(input.parseReceiptInput(value), expected, value);
  }
  // An audit link keeps its fragment so the signed invoice can still be checked here.
  assert.deepEqual(input.parseReceiptInput(`https://x.example/verify/${PDA_A}#purchase=abc`), { ok: true, receiptPda: PDA_A, hash: "#purchase=abc" });
});

test("malformed input and links that aren't receipt links fail with a clear reason", () => {
  const { RECEIPT_INPUT_ERRORS: E } = input;
  const cases = [
    ["", E.empty],
    ["   ", E.empty],
    ["not a receipt", E.badAddress],
    ["0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", E.badAddress],
    [`https://chainpay.example/app/receipts/${PDA_A}`, E.notReceiptLink],
    ["https://chainpay.example/verify", E.notReceiptLink],
    ["https://chainpay.example/verify/card#disclose=abc", E.notReceiptLink],
    ["https://chainpay.example/verify/not-a-pda", E.badAddressInLink],
    [`javascript://x/verify/${PDA_A}`, E.notReceiptLink],
    ["https://[bad/verify/x", E.badAddress],
  ];
  for (const [value, error] of cases) {
    assert.deepEqual(input.parseReceiptInput(value), { ok: false, error }, value);
  }
});

test("the verify entry opens a pasted link without contacting it, and explains a bad one", async () => {
  const dom = installDom("https://chainpay.example/verify");
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error("no network in this test"); };
  globalThis.__receiptLoader = async (pda) => verified(pda, "10000", "0.010000");
  const { VerifyPage } = await bundle("src/verify/VerifyPage.tsx", "verify-entry");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let path = "";
  window.addEventListener("popstate", () => { path = window.location.pathname + window.location.hash; });
  try {
    await act(async () => root.render(createElement(VerifyPage, { receiptPda: "" })));
    assert.match(host.querySelector(".verify-demo-link a").getAttribute("href"), new RegExp(`^/verify/${PDA_A}$`));
    const field = host.querySelector("#verify-receipt-pda");
    const setValue = async (value) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(field, value);
        field.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    };
    const submit = () => act(async () => { host.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });

    await setValue("https://chainpay.example/verify/not-a-pda");
    await submit();
    assert.equal(host.querySelector("#verify-receipt-error").textContent, input.RECEIPT_INPUT_ERRORS.badAddressInLink);
    assert.equal(field.getAttribute("aria-invalid"), "true");
    assert.equal(path, "", "a bad link goes nowhere");

    await setValue(`https://evil.example/verify/${PDA_B}#purchase=abc`);
    assert.equal(host.querySelector("#verify-receipt-error"), null, "typing clears the error");
    await submit();
    assert.equal(path, `/verify/${PDA_B}#purchase=abc`);
    assert.deepEqual(fetched, [], "the pasted origin is never fetched");
  } finally {
    await act(async () => root.unmount());
    delete globalThis.fetch;
    dom.window.close();
  }
});

// --- A5: retry generations ---------------------------------------------------

test("verify page: a retry for receipt A that answers after moving to B is ignored", async () => {
  const dom = installDom(`https://chainpay.example/verify/${PDA_A}`);
  const lateA = deferred();
  const calls = [];
  globalThis.__receiptLoader = (pda, options) => {
    calls.push([pda, Boolean(options?.refresh)]);
    if (pda === PDA_A && !options?.refresh) return Promise.resolve({ kind: "rpc_error", receiptPda: PDA_A, message: "RPC timed out" });
    if (pda === PDA_A) return lateA.promise;
    return Promise.resolve(verified(PDA_B, "2000000", "2.000000"));
  };
  const { VerifyPage } = await bundle("src/verify/VerifyPage.tsx", "verify-retry");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(VerifyPage, { receiptPda: PDA_A })));
    await tick();
    assert.match(host.textContent, /Receipt verification is unavailable/);
    await act(async () => buttonNamed(host, "Try again").click());
    await act(async () => root.render(createElement(VerifyPage, { receiptPda: PDA_B })));
    await tick();
    assert.match(host.textContent, /2\.000000 USDC/);
    lateA.resolve(verified(PDA_A, "9990000", "9.990000"));
    await tick(30);
    assert.match(host.textContent, /2\.000000 USDC/, "B stays on screen");
    assert.equal(host.textContent.includes("9.990000"), false, "A's late amount never shows");
    assert.deepEqual(calls, [[PDA_A, false], [PDA_A, true], [PDA_B, false]]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("receipt card: a retry for receipt A that answers after moving to B is ignored", async () => {
  const dom = installDom("https://chainpay.example/app/receipts");
  const lateA = deferred();
  globalThis.__receiptLoader = (pda, options) => {
    if (pda === PDA_A && !options?.refresh) return Promise.resolve({ kind: "rpc_error", receiptPda: PDA_A, message: "RPC timed out" });
    if (pda === PDA_A) return lateA.promise;
    return Promise.resolve(verified(PDA_B, "2000000", "2.000000"));
  };
  const { LoadedReceiptCard } = await bundle("src/receipts/InboxReceipt.tsx", "inbox-retry");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(LoadedReceiptCard, { receiptPda: PDA_A })));
    await tick();
    await act(async () => buttonNamed(host, "Try again").click());
    assert.match(host.textContent, /Reading the finalized receipt/, "a retry shows it is working");
    await act(async () => root.render(createElement(LoadedReceiptCard, { receiptPda: PDA_B })));
    await tick();
    lateA.resolve(verified(PDA_A, "9990000", "9.990000"));
    await tick(30);
    assert.match(host.textContent, /2\.000000 USDC/);
    assert.equal(host.textContent.includes("9.990000"), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

// --- A5: the shared loader never hands back a superseded answer -------------

function stubLoadDepsPlugin() {
  const stubs = {
    "@chainpayhq/sdk": "export const bytesToHex = () => ''; export const formatExactTokenAmount = () => ({}); export const receiptPolicy = () => ({ source: 'not-recorded' });",
    "../config/client": "export const PROGRAM_ID = 'Program1111'; export const publicReceiptClient = { readPublicReceipt: (pda) => globalThis.__readPublicReceipt(pda), getCurrentSlot: async () => 1n };",
    "../config/public": "export const DEVNET_PYUSD_TOKEN_2022_MINT = 'p'; export const DEVNET_USDC_MINT = 'u';",
    "./seller": "export const loadSellerStatement = async () => ({ status: 'absent' });",
  };
  return {
    name: "stub-load-deps",
    setup(build) {
      build.onResolve({ filter: /^(@chainpayhq\/sdk|\.\.\/config\/client|\.\.\/config\/public|\.\/seller)$/ }, (args) => ({ path: args.path, namespace: "stub-dep" }));
      build.onLoad({ filter: /.*/, namespace: "stub-dep" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    },
  };
}

test("load: a slow read superseded by a retry resolves to the retry's answer", async () => {
  const outfile = join(frontendRoot, `test/.tmp-receipt-load-${Date.now()}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot, entryPoints: ["src/receipts/load.ts"], bundle: true, format: "esm", platform: "node",
    outfile, plugins: [stubLoadDepsPlugin()], logLevel: "error",
  });
  const load = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await unlink(outfile).catch(() => {});
  const reads = [];
  globalThis.__readPublicReceipt = (pda) => {
    const read = deferred();
    reads.push(read);
    return read.promise;
  };
  const notFound = { receipt: { valid: false, code: "not_found", reason: "missing" } };
  const offline = (message) => Promise.reject(new Error(message));

  const first = load.loadPublicReceiptView(PDA_A);
  const shared = load.loadPublicReceiptView(PDA_A);
  assert.equal(shared, first, "a second plain load shares the read in flight");
  const retry = load.loadPublicReceiptView(PDA_A, { refresh: true });
  assert.equal(reads.length, 2);
  reads[1].resolve(notFound);
  assert.equal((await retry).kind, "not_found");
  // The first read answers last, with an older failure. Its callers get the newer answer.
  reads[0].resolve(offline("old RPC failure"));
  assert.equal((await first).kind, "not_found");
  assert.equal((await shared).kind, "not_found");

  // An invalidation with no newer read starts a fresh one instead of returning stale data.
  const before = load.loadPublicReceiptView(PDA_B, { refresh: true });
  load.invalidatePublicReceiptCache(PDA_B);
  reads[2].resolve(offline("stale"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(reads.length, 4, "the invalidated read was replaced by a fresh one");
  reads.at(-1).resolve(notFound);
  assert.equal((await before).kind, "not_found");
});
