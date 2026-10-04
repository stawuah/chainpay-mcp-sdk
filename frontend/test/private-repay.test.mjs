// Private statement repayment opt-in (MagicBlock Private Payments): the vault
// model is shown and agreed to before anything is prepared, signed or sent.
import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/cards", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Node", "Element", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "HTMLInputElement", "Event", "MouseEvent", "CustomEvent", "DOMRect"]) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = typeof dom.window[key] === "function" && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const outfile = join(frontendRoot, "test/.tmp-private-repay.mjs");
await esbuild.build({
  absWorkingDir: frontendRoot,
  entryPoints: ["src/dashboard/cards/PrivateRepayOptIn.tsx"],
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
  loader: { ".css": "empty" },
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@chainpay/sdk", "@chainpay/sdk/*"],
  define: { "import.meta.env": "{}" },
  logLevel: "error",
});
const { PrivateRepayOptIn } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
test.after(() => unlink(outfile).catch(() => {}));

const attempt = { statementId: "card:000001", attemptId: "p1", state: "awaiting_settlement", clientRefId: "418273645512", amountBaseUnits: "10050000" };
const pending = () => Promise.reject(Object.assign(new Error("not yet"), { code: "settlement_pending" }));

async function mount(props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(PrivateRepayOptIn, { amountCents: "1005", onBack() {}, onDone() {}, ...props })));
  return { host, root };
}

const button = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent.includes(text));
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

test("explains the vault before opting in, and nothing runs until the owner agrees", async () => {
  const calls = [];
  const { host } = await mount({
    prepare: async () => { calls.push("prepare"); return attempt; },
    check: async () => { calls.push("check"); return pending(); },
    pay: async () => { calls.push("pay"); return { transferOutcome: "sent" }; },
    wait: async () => { calls.push("wait"); return { state: "discharged", statement: {} }; },
  });
  const text = host.querySelector('[data-testid="private-repay-disclosure"]').textContent;
  assert.match(text, /MagicBlock's shared vault first/);
  assert.match(text, /tokens in your account until a payment/);
  assert.match(text, /can't check who paid/);
  assert.match(text, /Devnet test USDC only/);
  const payBtn = button(host, "privately");
  assert.equal(payBtn.disabled, true);
  await act(async () => payBtn.click());
  assert.deepEqual(calls, [], "no network before opt-in");
  await act(async () => host.querySelector('[data-testid="private-repay-agree"]').click());
  assert.equal(button(host, "privately").disabled, false);
  await act(async () => button(host, "privately").click());
  await flush();
  assert.deepEqual(calls, ["prepare", "check", "pay", "wait"]);
  assert.match(host.querySelector('[data-testid="private-repay-done"]').textContent, /exactly \$10\.05/);
  assert.match(host.textContent, /didn't check who paid/);
});

test.beforeEach(() => { try { window.localStorage.clear(); } catch {} });

test("an attempt that already settled is never paid twice", async () => {
  const calls = [];
  let done;
  const { host } = await mount({
    prepare: async () => attempt,
    check: async () => ({ state: "discharged", statement: {} }),
    pay: async () => { calls.push("pay"); return { transferOutcome: "sent" }; },
    wait: async () => ({ state: "discharged", statement: {} }),
    onDone: (r) => { done = r; },
  });
  await act(async () => host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(host, "privately").click());
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(done.state, "discharged");
});

test("an unconfirmed send says don't pay again, and a mismatch keeps the statement open", async () => {
  let release;
  const { host } = await mount({
    prepare: async () => attempt,
    check: pending,
    pay: async (_attempt, onSigned) => { onSigned("5igSignedTransfer"); return { transferOutcome: "unknown" }; },
    wait: () => new Promise((resolve) => { release = resolve; }),
  });
  await act(async () => host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(host, "privately").click());
  await flush();
  assert.match(host.querySelector('[data-testid="private-repay-sent"]').textContent, /don't pay again/);
  await act(async () => release({ state: "repayment_mismatch", mismatch: ["amount"], statement: {} }));
  await flush();
  const mismatch = host.querySelector('[data-testid="private-repay-mismatch"]');
  assert.match(mismatch.textContent, /different amount/);
  assert.match(mismatch.textContent, /still open/);
});

test("a failed confirmation after paying never reads as not paid", async () => {
  const { host } = await mount({
    prepare: async () => attempt,
    check: pending,
    pay: async () => ({ transferOutcome: "sent" }),
    wait: async () => { throw new Error("Timed out"); },
  });
  await act(async () => host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(host, "privately").click());
  await flush();
  const error = host.querySelector('[data-testid="private-repay-error"]');
  assert.match(error.textContent, /Not confirmed yet/);
  assert.match(error.textContent, /Don't pay again/);
  assert.ok(button(host, "Check again"));
});

test("after a reload, an attempt this browser already sent waits instead of paying again", async () => {
  const calls = [];
  const props = {
    prepare: async () => attempt,
    check: pending,
    // The wallet returns the signed transfer, then the send's outcome is unknown.
    pay: async (_attempt, onSigned) => { calls.push("pay"); onSigned("5igSignedTransfer1111111111111111111111111111111111111111111111"); return { transferOutcome: "unknown" }; },
    wait: () => new Promise(() => {}),
  };
  const first = await mount(props);
  await act(async () => first.host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(first.host, "privately").click());
  await flush();
  assert.deepEqual(calls, ["pay"]);
  // Reload: a fresh component, same attempt, still settlement_pending.
  const second = await mount(props);
  await act(async () => second.host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(second.host, "privately").click());
  await flush();
  assert.deepEqual(calls, ["pay"], "not paid twice");
  assert.match(second.host.querySelector('[data-testid="private-repay-sent"]').textContent, /don't pay again/);
});

test("a wallet that cancels leaves the statement payable: no 'sent' marker, 'Not paid', and the next try pays", async () => {
  let pays = 0;
  const props = {
    prepare: async () => attempt,
    check: pending,
    // Rejected in the wallet: onSigned never runs.
    pay: async () => { pays += 1; throw new Error("User rejected the request."); },
    wait: () => Promise.reject(Object.assign(new Error("Still waiting for the partner."), { code: "settlement_pending" })),
  };
  const first = await mount(props);
  await act(async () => first.host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(first.host, "privately").click());
  await flush();
  const error = first.host.querySelector('[data-testid="private-repay-error"]');
  assert.match(error.textContent, /^Not paid/);
  assert.match(error.textContent, /Nothing was sent/);
  assert.doesNotMatch(error.textContent, /don't pay again/i);
  assert.equal(Object.keys(window.localStorage).filter((k) => k.startsWith("cp-private-sent:")).length, 0, "no marker without a signature");
  // Same attempt again (the reference is fixed per statement): pay is offered, not skipped.
  await act(async () => button(first.host, "Try again").click());
  await flush();
  assert.equal(pays, 2);
  const second = await mount(props);
  await act(async () => second.host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(second.host, "privately").click());
  await flush();
  assert.equal(pays, 3, "a reload still offers the payment");
  assert.doesNotMatch(second.host.textContent, /don't pay again/i);
});

test("the 'sent' marker is the signature the wallet returned, and a failure after signing never reads as not paid", async () => {
  const { host } = await mount({
    prepare: async () => attempt,
    check: pending,
    pay: async (_attempt, onSigned) => { onSigned("SignedTransferSig"); throw new Error("Network error"); },
    wait: () => new Promise(() => {}),
  });
  await act(async () => host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(host, "privately").click());
  await flush();
  const stored = JSON.parse(window.localStorage.getItem(`cp-private-sent:${attempt.statementId}:${attempt.attemptId}`));
  assert.equal(stored.signature, "SignedTransferSig");
  assert.match(host.querySelector('[data-testid="private-repay-error"]').textContent, /Not confirmed yet/);
  assert.match(host.textContent, /Don't pay again/);
});

test("an old marker without a signature (written before the wallet answered) doesn't block paying", async () => {
  window.localStorage.setItem(`cp-private-sent:${attempt.statementId}:${attempt.attemptId}`, "2026-10-04T10:00:00.000Z");
  let pays = 0;
  const { host } = await mount({
    prepare: async () => attempt,
    check: pending,
    pay: async (_attempt, onSigned) => { pays += 1; onSigned("Sig"); return { transferOutcome: "sent" }; },
    wait: async () => ({ state: "discharged", statement: {} }),
  });
  await act(async () => host.querySelector('[data-testid="private-repay-agree"]').click());
  await act(async () => button(host, "privately").click());
  await flush();
  assert.equal(pays, 1);
});
