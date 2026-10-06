// "Payment & approval updates": every row says what it is about, and a confirmed
// row clears itself once it has been on screen, while waiting and failed rows stay.
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

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Node", "Element", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "Event", "MouseEvent", "CustomEvent", "localStorage"]) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = typeof dom.window[key] === "function" && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
}
// The store dispatches window events, so they must be the DOM's own Event.
globalThis.Event = dom.window.Event;
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const outfile = join(frontendRoot, "test/.tmp-settlement-panel.mjs");
await esbuild.build({
  absWorkingDir: frontendRoot,
  stdin: { contents: `export { PendingSettlements, describeOperation } from "./src/settlement";`, resolveDir: frontendRoot, loader: "ts" },
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@chainpayhq/sdk", "@solana/web3.js", "buffer"],
  define: { "import.meta.env": "{}" },
  logLevel: "error",
});
const m = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
await unlink(outfile).catch(() => {});

const KEY = "chainpay.pending-operations.v1";
const id = (n) => `transaction_${n.toString(16).padStart(64, "0")}`;
const row = (n, status, extra = {}) => ({ id: id(n), key: `k-${n}`, kind: "transactions", backend: "https://relay.example", wallet: "owner", generation: 1, status, ...extra });
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");
const settle = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function render(rows, props = {}) {
  localStorage.setItem(KEY, JSON.stringify(rows));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(createElement(m.PendingSettlements, { wallet: "owner", ...props })); });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("each row names what was confirmed, failed or is still waiting", async () => {
  const { host, unmount } = await render([
    row(1, "confirmed", { key: `card-base:${"d4".repeat(32)}:0:h`, label: "Setting up “Crossmint”: approval 1 of 3" }),
    row(2, "confirmed", { kind: "payments", label: "Payment of 5 USDC to 9xQe…VFin" }),
    row(3, "submitted", { key: "pause-mandate:Mdt:h" }),
    row(4, "failed", { key: "something-new:1", result: { status: "failed", error: "Request rejected before submission" } }),
  ], { confirmedSeenMs: 60_000 });
  const rows = [...host.querySelectorAll(".owner-settlement-row")].map((el) => el.querySelector(".owner-settlement-head").textContent);
  assert.deepEqual(rows, [
    "ConfirmedSetting up “Crossmint”: approval 1 of 3",
    "ConfirmedPayment of 5 USDC to 9xQe…VFin",
    "Waiting for confirmationPausing a spending permission",
    "Could not completeWallet approval",
  ]);
  await unmount();
});

test("a confirmed row clears itself once seen; waiting and failed rows stay, and history is kept", async () => {
  const { host, unmount } = await render([row(1, "confirmed", { label: "Payment of 5 USDC to 9xQe…VFin", signature: "sig" }), row(2, "submitted"), row(3, "failed")], { confirmedSeenMs: 30 });
  assert.equal(host.querySelectorAll(".owner-settlement-row").length, 3);
  await settle(80);
  const states = [...host.querySelectorAll(".owner-settlement-row")].map((el) => el.dataset.status);
  assert.deepEqual(states, ["submitted", "failed"]);
  const confirmed = stored().find((r) => r.id === id(1));
  assert.equal(confirmed.signature, "sig", "the confirmed payment stays in history for recent activity");
  assert.equal(typeof confirmed.seenAt, "number");
  await unmount();
});

test("a confirmed row isn't cleared while the page is hidden", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  try {
    const { host, unmount } = await render([row(1, "confirmed")], { confirmedSeenMs: 20 });
    await settle(60);
    assert.equal(host.querySelectorAll(".owner-settlement-row").length, 1, "not seen yet");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await settle(60);
    assert.equal(host.querySelector(".owner-settlement-row"), null);
    await unmount();
  } finally {
    delete document.visibilityState;
  }
});

test("a panel with only seen confirmations shows nothing", async () => {
  const { host, unmount } = await render([row(1, "confirmed", { seenAt: 1 })]);
  assert.equal(host.querySelector(".owner-settlements"), null);
  await unmount();
});
