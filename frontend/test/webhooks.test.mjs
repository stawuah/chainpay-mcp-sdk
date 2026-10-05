// Settings → Webhooks (owner webhooks, audit R5): honest delivery copy, the
// secret shown exactly once, every delivery state, and no savable UI when the
// relay has webhooks switched off.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/settings", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Node", "Element", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "history", "location", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "CustomEvent", "matchMedia", "ResizeObserver", "DOMRect"]) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = typeof dom.window[key] === "function" && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
dom.window.ResizeObserver = globalThis.ResizeObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
dom.window.CSS ??= globalThis.CSS;

const outfile = join(frontendRoot, "test/.tmp-webhooks.mjs");
await esbuild.build({
  absWorkingDir: frontendRoot,
  entryPoints: ["test/fixtures/webhooks-test-entry.ts"],
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
  loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".webp": "empty" },
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@chainpay/sdk", "@solana/web3.js", "buffer", "@phala/dcap-qvl"],
  define: { "import.meta.env": "{}" },
  logLevel: "error",
});
const m = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
await unlink(outfile).catch(() => {});

async function render(element) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  await settle();
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function click(el) { assert.ok(el, "element exists"); await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); await settle(); }
const button = (host, name) => [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent).trim() === name);
async function type(input, value) {
  // Astryx's TextInput is controlled; drive its React change handler with the new value.
  const props = input[Object.keys(input).find((key) => key.startsWith("__reactProps"))];
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    props.onChange({ target: input, currentTarget: input, defaultPrevented: false });
  });
  await settle();
}
const section = (mode, props = {}) => { m.setWebhooksSourceOverride(m.createFixtureWebhooksSource(mode)); return createElement(m.WebhooksSection, { sessionReady: true, onSignIn() {}, ...props }); };

test("signed out and switched off show nothing that can be saved", async () => {
  let signIns = 0;
  let view = await render(section("fixture", { sessionReady: false, onSignIn() { signIns++; } }));
  assert.match(view.host.textContent, /Sign in to manage webhooks/);
  assert.match(view.host.textContent, /never approves a payment/);
  assert.equal(view.host.querySelector("input"), null);
  await click(button(view.host, "Sign in"));
  assert.equal(signIns, 1);
  await view.unmount();
  view = await render(section("off"));
  assert.match(view.host.textContent, /Not switched on yet/);
  assert.equal(button(view.host, "Add endpoint"), undefined);
  await view.unmount();
  view = await render(section("fail"));
  assert.match(view.host.textContent, /Couldn't load your webhooks/);
  assert.ok(button(view.host, "Try again"));
  await view.unmount();
});

test("delivery copy is honest: verified only, at least once, scheduled, dedupe by webhook-id", async () => {
  const view = await render(section("fixture"));
  const text = view.host.textContent;
  assert.match(text, /Verified receipts only/);
  assert.match(text, /at least once/);
  assert.match(text, /never instant/);
  assert.match(text, /Dedupe by webhook-id/);
  assert.doesNotMatch(text, /real[- ]time|instantly/i);
  assert.match(text, /hooks\.example\.com\/chainpay/);
  assert.match(text, /Active/);
  assert.match(text, /Disabled/);
  assert.match(text, /1 of 5 active/);
  await view.unmount();
});

test("the signing secret is shown once and is gone after it is saved", async () => {
  const view = await render(section("empty"));
  assert.match(view.host.textContent, /No endpoints yet/);
  await click(button(view.host, "Add endpoint"));
  const [url] = view.host.querySelectorAll("input");
  await type(url, "https://hooks.example.com/new");
  const submit = view.host.querySelector("form button[type=submit]");
  await click(submit);
  const secret = view.host.querySelector(".cp-webhooks-secret-value")?.textContent ?? "";
  assert.match(secret, /^whsec_[A-Za-z0-9+/=]{40,}$/);
  assert.match(view.host.textContent, /won't see it again/);
  await click(button(view.host, "I saved it"));
  assert.equal(view.host.textContent.includes(secret), false);
  assert.match(view.host.textContent, /hooks\.example\.com\/new/);
  await view.unmount();
});

test("a refused destination keeps the form open with the relay's reason", async () => {
  const view = await render(section("empty"));
  await click(button(view.host, "Add endpoint"));
  await type(view.host.querySelector("input"), "https://169.254.169.254/latest");
  await click(view.host.querySelector("form button[type=submit]"));
  assert.match(view.host.querySelector("[role=alert]").textContent, /not a public internet address/);
  assert.equal(view.host.querySelector(".cp-webhooks-secret-value"), null);
  await view.unmount();
});

test("every delivery state reads plainly and can be sent again with the same event id", async () => {
  const view = await render(section("fixture"));
  await click(button(view.host, "Deliveries"));
  const text = view.host.textContent;
  for (const label of ["Delivered", "Retrying", "Gave up", "Queued"]) assert.match(text, new RegExp(label));
  assert.match(text, /HTTP 503/);
  assert.match(text, /may still have processed it/);
  const resend = [...view.host.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Send again");
  assert.equal(resend.length, 3, "delivered, retrying and gave-up rows; not the queued one");
  const before = view.host.querySelectorAll(".cp-webhooks-id code")[2].textContent;
  await click(resend[2]);
  const after = view.host.querySelectorAll(".cp-webhooks-id code")[2].textContent;
  assert.equal(after, before);
  assert.match(view.host.querySelectorAll(".cp-webhooks-delivery")[2].textContent, /Queued/);
  await view.unmount();
});

test("delivery states map to the shared status vocabulary", () => {
  const base = { id: "d", event_id: "e", event_type: "payment.receipt_ready", receipt_address: "R", attempts: 8, next_attempt_at_ms: 1, last_status: null, last_error: null, delivered_at_ms: 1, created_at_ms: 1, updated_at_ms: 1 };
  assert.equal(m.deliveryStatus({ ...base, state: "delivered" }, 8).tone, "positive");
  assert.equal(m.deliveryStatus({ ...base, state: "retry_scheduled" }, 8).tone, "warning");
  assert.equal(m.deliveryStatus({ ...base, state: "exhausted" }, 8).tone, "critical");
  assert.match(m.deliveryStatus({ ...base, state: "exhausted" }, 8).description, /8 of 8/);
  assert.equal(m.deliveryStatus({ ...base, state: "pending" }, 8).label, "Queued");
});

test("the dashboard does not bring back the removed generic preferences tab", async () => {
  const dashboard = await readFile(join(frontendRoot, "src/dashboard/Dashboard.tsx"), "utf8");
  const sectionSource = await readFile(join(frontendRoot, "src/dashboard/webhooks/WebhooksSection.tsx"), "utf8");
  assert.equal(/notification/i.test(dashboard + sectionSource), false);
  assert.match(dashboard, /<WebhooksSection /);
});
