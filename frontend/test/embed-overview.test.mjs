// Audit 2026-10-05 A8: the embed recovers from a load failure, and only
// settled payments show up as receipts.
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

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/embed/overview", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// After the DOM: react-dom checks for input events once, at load.
const { createRoot } = await import("react-dom/client");

const STUBS = {
  "@chainpay/sdk": "export const loadOpsSnapshot = (...args) => globalThis.__loadOpsSnapshot(...args);",
  "../config/client": "export const publicReceiptClient = {};",
  "../receipts/InboxReceipt": "import { createElement } from 'react'; export const LoadedReceiptCard = ({ receiptPda }) => createElement('div', { 'data-receipt': receiptPda }, 'receipt ' + receiptPda);",
  "../routing/useRoute": "export const useRoute = () => ({ navigate: (route) => globalThis.__navigated.push(route) });",
};

const outfile = join(frontendRoot, "test/.tmp-embed-overview.mjs");
await esbuild.build({
  absWorkingDir: frontendRoot,
  entryPoints: ["src/embed/EmbedOverview.tsx"],
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
  loader: { ".css": "empty" },
  external: ["react", "react-dom", "react/jsx-runtime"],
  logLevel: "error",
  plugins: [{
    name: "embed-stubs",
    setup(build) {
      build.onResolve({ filter: /^(@chainpay\/sdk|\.\.\/config\/client|\.\.\/receipts\/InboxReceipt|\.\.\/routing\/useRoute)$/ }, (args) => ({ path: args.path, namespace: "embed-stub" }));
      build.onLoad({ filter: /.*/, namespace: "embed-stub" }, (args) => ({ contents: STUBS[args.path], loader: "js", resolveDir: frontendRoot }));
    },
  }],
});
const { EmbedOverview, settledReceipts } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
await unlink(outfile).catch(() => {});

const OWNER = "7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9";
const settle = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const buttonNamed = (host, name) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === name);

function row(address, status, amount) {
  return { address, mandate: "M1", amount, amountBase: "1", symbol: "USDC", decimals: 6, status, executedAtSlot: "10", recipientTokenAccount: "R1", policy: { source: "not-recorded" } };
}

const SNAPSHOT = {
  kind: "spend_overview",
  owner: OWNER,
  totals: [{ mint: "u", symbol: "USDC", decimals: 6, spent: "1.50", remaining: "8.50", spentBase: "1500000", remainingBase: "8500000" }],
  mandates: [],
  receipts: [
    row("PendingNewest1111111111111111111111111111", "submitted", "9.00"),
    row("SettledA111111111111111111111111111111111", "confirmed", "1.00"),
    row("Prepared11111111111111111111111111111111", "prepared", "7.00"),
    row("SettledB111111111111111111111111111111111", "confirmed", "0.50"),
  ],
  attention: [],
  note: "Totals are mandate allowances, not wallet balance.",
};

test("settledReceipts keeps only confirmed payments, in order", () => {
  assert.deepEqual(settledReceipts(SNAPSHOT.receipts).map((r) => r.address), ["SettledA111111111111111111111111111111111", "SettledB111111111111111111111111111111111"]);
  assert.deepEqual(settledReceipts([]), []);
});

test("only settled payments appear as the latest receipt and in the list", async () => {
  globalThis.__loadOpsSnapshot = async () => SNAPSHOT;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(EmbedOverview, { owner: OWNER })));
    await settle();
    assert.equal(host.querySelector("[data-receipt]").dataset.receipt, "SettledA111111111111111111111111111111111");
    const listed = [...host.querySelectorAll(".ops-embed-receipts a")].map((a) => a.textContent);
    assert.deepEqual(listed, ["0.50 USDC"]);
    assert.equal(/9\.00|7\.00|Pending|Prepared/.test(host.textContent), false, "unsettled payments never show as spending");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a load failure keeps the owner field and a retry that loads again", async () => {
  let calls = 0;
  globalThis.__navigated = [];
  globalThis.__loadOpsSnapshot = async () => {
    calls += 1;
    if (calls === 1) throw new Error("RPC timed out.");
    return SNAPSHOT;
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(EmbedOverview, { owner: OWNER })));
    await settle();
    const error = host.querySelector('[data-testid="embed-error"]');
    assert.ok(error, "error state shows");
    assert.match(error.querySelector("[role='alert']").textContent, /Spending couldn't load\. RPC timed out\./);
    const field = error.querySelector("#ops-embed-owner");
    assert.ok(field, "owner address entry comes back");
    assert.equal(field.value, OWNER, "prefilled with the address that failed");
    await act(async () => buttonNamed(host, "Try again").click());
    await settle();
    assert.equal(calls, 2);
    assert.equal(host.querySelector('[data-testid="embed-error"]'), null);
    assert.match(host.textContent, /1\.50 USDC/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a different address typed after a failure opens that owner", async () => {
  globalThis.__navigated = [];
  globalThis.__loadOpsSnapshot = async () => { throw new Error("down"); };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(EmbedOverview, { owner: OWNER })));
    await settle();
    const field = host.querySelector("#ops-embed-owner");
    const other = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(field, other);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => { field.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.deepEqual(globalThis.__navigated, [{ kind: "embed-overview", owner: other }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
