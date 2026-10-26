// PayPal dashboard tab: flag gating and nav coverage both ways, sub-view routes,
// a fixture render of every sub-view, and the PayPal session never touching storage.
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

const dom = new JSDOM("<!doctype html><html data-astryx-theme><body></body></html>", { url: "https://chainpay.example/app/paypal", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Node", "Element", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "history", "location", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "PopStateEvent", "CustomEvent", "matchMedia", "ResizeObserver", "DOMRect", "localStorage", "sessionStorage", "Storage"]) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = typeof dom.window[key] === "function" && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
dom.window.ResizeObserver = globalThis.ResizeObserver;
globalThis.CSS ??= { supports: () => false, escape: (value) => value };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

async function bundle(env, name) {
  const outfile = join(frontendRoot, `test/.tmp-paypal-${name}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["test/fixtures/paypal-test-entry.ts"],
    bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
    loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".webp": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@chainpayhq/sdk", "@solana/web3.js", "buffer", "@phala/dcap-qvl"],
    define: { "import.meta.env": JSON.stringify(env) },
    logLevel: "error",
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await unlink(outfile).catch(() => {});
  return mod;
}

const off = await bundle({}, "off");
const on = await bundle({ VITE_CHAINPAY_PAYPAL: "true", VITE_CHAINPAY_PAYPAL_API_ORIGIN: "https://paypal.example" }, "on");

test("flag off: no PayPal in the nav, and nav still covers every sidebar tab", () => {
  assert.equal(off.PAYPAL_TAB_ENABLED, false);
  assert.equal(off.tabEnabled("paypal"), false);
  assert.equal(off.DASHBOARD_NAV_ITEMS.some((item) => item.id === "paypal"), false);
  assert.equal(off.SIDEBAR_DASHBOARD_TABS.includes("paypal"), false);
  assert.equal(off.dashboardNavCoversAllTabs(), true);
});

test("flag on: PayPal sits after Cards, and nav covers every sidebar tab", () => {
  assert.equal(on.PAYPAL_TAB_ENABLED, true);
  assert.equal(on.PAYPAL_API_URL, "https://paypal.example");
  const ids = on.DASHBOARD_NAV_ITEMS.map((item) => item.id);
  assert.equal(ids[ids.indexOf("cards") + 1], "paypal");
  assert.equal(on.DASHBOARD_NAV_ITEMS.find((item) => item.id === "paypal").label, "PayPal");
  assert.ok(on.SIDEBAR_DASHBOARD_TABS.includes("paypal"));
  assert.equal(on.dashboardNavCoversAllTabs(), true);
});

test("PayPal sub-view routes round-trip; unknown views are not found", () => {
  assert.deepEqual(on.parsePathname("/app/paypal"), { kind: "app", tab: "paypal" });
  for (const view of on.PAYPAL_VIEWS) {
    const route = on.parsePathname(`/app/paypal/${view}`);
    assert.deepEqual(route, { kind: "app", tab: "paypal", paypalView: view });
    assert.equal(on.buildPath(route), view === "connect" ? "/app/paypal" : `/app/paypal/${view}`);
  }
  assert.equal(on.parsePathname("/app/paypal/nope").kind, "app-not-found");
});

async function render(element) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return { host, rerender: (next) => act(async () => { root.render(next); }), unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const button = (host, name) => [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent).trim() === name);

const OWNER = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MANDATE = { address: "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", owner: OWNER, approvedAgent: "AgEnT111111111111111111111111111111111111111", allowedMint: USDC, totalLimit: 250_000_000n, amountSpent: 91_500_000n, status: "active", tokenProgram: "spl-token", createdAt: 1757894400 };

test("every sub-view renders from fixtures, and approving clears the pending card", async () => {
  on.setPaypalSourceOverride(on.createFixturePaypalSource({ wallet: OWNER, now: 1_790_000_000 }));
  const views = [];
  const props = (view) => ({ wallet: OWNER, view, sessionReady: false, onSignIn() {}, mandates: [MANDATE], stablecoinOptions: [{ value: USDC, mint: USDC, label: "USDC", detail: "", tokenProgram: "spl-token" }], onView: (v) => views.push(v), onOpenPermissions() {} });
  const r = await render(createElement(on.PaypalArea, props("connect")));
  try {
    await settle();
    const text = () => r.host.textContent;
    assert.match(text(), /Example data/);
    assert.match(text(), /PayPal is connected/);
    assert.match(text(), /Waiting for you \(1\)/);
    assert.ok(button(r.host, "Approve $37.00"));
    assert.ok(button(r.host, "Decline"));
    assert.match(text(), /7R1i…|7R1i/);

    await r.rerender(createElement(on.PaypalArea, props("allowances")));
    await settle();
    assert.match(text(), /Solana mandates and PayPal allowances are separate limits/);
    assert.match(text(), /Ask me above \$20\.00/);
    assert.match(text(), /Fund with PYUSD/);
    assert.match(text(), /USDC spending permission 1/);
    assert.match(text(), /Weekly groceries/);
    for (const chip of ["Groceries", "Tickets", "Tours", "Print"]) assert.match(text(), new RegExp(chip));
    // The tab-level inbox is the only one: Allowances' own copy is off here.
    assert.equal(r.host.querySelectorAll("[aria-label='Purchases waiting for approval']").length, 1);

    await r.rerender(createElement(on.PaypalArea, props("marketplace")));
    await settle();
    for (const name of ["Corner Grocer", "Riverside Box Office", "Old Town Tours", "Quickprint"]) assert.match(text(), new RegExp(name));

    await r.rerender(createElement(on.PaypalArea, props("activity")));
    await settle();
    assert.equal(r.host.querySelectorAll(".cp-paypal-activity-row").length, 4);
    assert.match(text(), /Refunded \$11\.30\. That went back on the allowance\./);
    assert.match(text(), /Waiting for you/);

    await r.rerender(createElement(on.PaypalArea, props("disputes")));
    await settle();
    assert.match(text(), /PP-D-27183/);
    assert.equal(button(r.host, "Sync from PayPal"), undefined, "a buyer gets the read-only dispute view");

    await act(async () => { button(r.host, "Approve $37.00").dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    await settle();
    assert.equal(r.host.querySelector("[aria-label='Purchases waiting for approval']"), null);
  } finally {
    await r.unmount();
    on.setPaypalSourceOverride(null);
  }
});

test("the PayPal session token is kept in memory: never storage, cookie or URL", async () => {
  const RELAY = "relay-session-token-abc";
  const PAYPAL = "paypal-session-token-xyz";
  const calls = [];
  const original = globalThis.fetch;
  const writes = [];
  const setItem = dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem = function (key, value) { writes.push(`${key}=${value}`); return setItem.call(this, key, value); };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("Authorization") ?? init.headers?.Authorization ?? null;
    calls.push({ url, method: init.method ?? "GET", auth });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/v1/auth/challenge?wallet=" + OWNER)) return json({ challenge_id: "c", message: "Sign in" });
    if (url.endsWith("/v1/auth/session")) return json({ token: RELAY, wallet: OWNER, expires_at_ms: Date.now() + 3_600_000 });
    if (url === "https://paypal.example/v1/paypal/session/wallet") return json({ token: PAYPAL, wallet: OWNER, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (url === "https://paypal.example/v1/paypal/session") return json({ id: "b", workspace: "w", role: "buyer" });
    if (url === "https://paypal.example/v1/paypal/allowances") return json({ allowances: [] });
    return json({}, 404);
  };
  try {
    on.configureSession("https://relay.example", "https://mcp.example/mcp");
    on.setSessionWallet({ address: OWNER, signMessage: async () => new Uint8Array(64) });
    await on.ensureSessionReady();
    const source = on.createLivePaypalSource(OWNER, "https://paypal.example");
    const connection = await source.connect();
    assert.equal(connection.wallet, OWNER);
    assert.equal(connection.principal.role, "buyer");
    await connection.api("/allowances");

    const exchange = calls.find((c) => c.url.endsWith("/session/wallet"));
    assert.equal(exchange.method, "POST");
    assert.equal(exchange.auth, `Bearer ${RELAY}`, "the relay session goes to the exchange URL");
    for (const c of calls.filter((c) => c.url.startsWith("https://paypal.example/v1/paypal/") && !c.url.endsWith("/session/wallet"))) {
      assert.equal(c.auth, `Bearer ${PAYPAL}`, `${c.url} uses the PayPal session`);
    }
    // The relay session may go to the exchange URL only, not elsewhere on that origin.
    await assert.rejects(() => on.authorizedFetch("https://paypal.example/v1/paypal/allowances"), /Refusing to send a wallet session/);

    const stored = [...writes, document.cookie, location.href, JSON.stringify({ ...dom.window.localStorage }), JSON.stringify({ ...dom.window.sessionStorage })].join("\n");
    assert.equal(stored.includes(PAYPAL), false, "PayPal token reached storage, a cookie or the URL");
    assert.equal(stored.includes(RELAY), false, "relay token reached storage, a cookie or the URL");

    source.disconnect();
  } finally {
    globalThis.fetch = original;
    dom.window.Storage.prototype.setItem = setItem;
    on.setSessionWallet(null);
  }
});
