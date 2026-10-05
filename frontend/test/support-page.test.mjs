// Audit 2026-10-05 A9 + R4: /support closed, blocked and open states. Closed
// never points at the dashboard or asks for money; it opens only on Devnet, only
// after the chain checks out, and says test tokens.
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

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/support", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

// The page's money paths are stubbed: this test is about the words around them.
const STUBS = {
  "./TipCard": "import { createElement } from 'react'; export const TipCard = () => createElement('section', { 'data-testid': 'tip-card' }, 'tip card');",
  "./Ledger": "export const Ledger = () => null; export const amountLabel = (units, asset) => units + ' ' + asset;",
  "./PayoutPanel": "export const PayoutPanel = () => null;",
  "./send": "export const supportConnection = () => ({ getAccountInfo: async () => null });",
  "./useSupportWallet": "export const useSupportWallet = () => ({ wallet: null });",
  "./readiness": "export const checkSupportChain = async () => { globalThis.__supportChecks = (globalThis.__supportChecks ?? 0) + 1; return globalThis.__supportReadiness; };",
  "./recovery": "export const isIndexed = () => false;",
  "../routing/useRoute": "export const useRoute = () => ({ navigate() {} });",
};

async function loadPage(env, name) {
  const outfile = join(frontendRoot, `test/.tmp-support-page-${name}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/support/SupportPage.tsx"],
    bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
    loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".webp": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime", "@solana/web3.js"],
    define: { "import.meta.env": JSON.stringify(env) },
    logLevel: "error",
    plugins: [{
      name: "support-stubs",
      setup(build) {
        build.onResolve({ filter: /^(\.\/(TipCard|Ledger|PayoutPanel|send|useSupportWallet|readiness|recovery)|\.\.\/routing\/useRoute)$/ }, (args) => ({ path: args.path, namespace: "support-stub" }));
        build.onLoad({ filter: /.*/, namespace: "support-stub" }, (args) => ({ contents: STUBS[args.path], loader: "js", resolveDir: frontendRoot }));
      },
    }],
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    await unlink(outfile).catch(() => {});
  }
}

async function render(page) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(page.default)));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const VALUE_CLAIM = /Buy us a coffee|keep ChainPay free|personal wallets|\$\d/;
// Real-looking keys (not the splitter's test-config throwaways, not all-zero).
const DEVNET_ENV = {
  VITE_SUPPORT_LIVE: "true",
  VITE_SUPPORT_CLUSTER: "devnet",
  VITE_SUPPORT_PROGRAM_ID: "D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH",
  VITE_SUPPORT_TRACKER_URL: "https://example-123.convex.site/support/v1",
  VITE_SUPPORT_RECIPIENT_A: "3yS1JFVT284y8z1LC9MRoWxZjzFrdoD5axKsZiyMsfC7",
  VITE_SUPPORT_RECIPIENT_B: "4iYFsZcZXQLTfykuzRwY19SxRja53Vm6jSf6CuTx6Kjt",
};
const READY = { state: "ready", accounts: { vault: { toBase58: () => "Vault111" } }, vault: { recipients: ["a", "b"] } };
const click = async (element) => { await act(async () => { element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 10)); }); };

async function assertClosed(host) {
  const text = host.textContent;
  assert.match(text, /Opening soon/);
  assert.match(text, /Tips are opening soon\./);
  assert.match(text, /Nothing can be sent from this page yet/);
  assert.equal(host.querySelector('[data-testid="tip-card"]'), null, "no way to send while closed");
  assert.doesNotMatch(text, /Open dashboard/);
  assert.doesNotMatch(text, VALUE_CLAIM);
  const back = [...host.querySelectorAll("a")].filter((a) => a.textContent.trim() === "Back to ChainPay");
  assert.ok(back.length >= 1, "Back to ChainPay is offered");
  for (const link of back) assert.equal(link.getAttribute("href"), "/");
  assert.equal(document.title, "Support · ChainPay");
}

test("closed: Opening soon, a way back to ChainPay, and no dashboard button", async () => {
  const page = await loadPage({}, "closed");
  assert.equal(page.supportMode(false), "closed");
  globalThis.__supportChecks = 0;
  const { host, unmount } = await render(page);
  try {
    await assertClosed(host);
    assert.equal(globalThis.__supportChecks, 0, "a closed page doesn't even read the chain");
  } finally {
    await unmount();
  }
});

test("fails closed: mainnet, an absent cluster, or missing/placeholder settings never open", async () => {
  const variants = {
    mainnet: { ...DEVNET_ENV, VITE_SUPPORT_CLUSTER: "mainnet" },
    "no-cluster": { ...DEVNET_ENV, VITE_SUPPORT_CLUSTER: undefined },
    "mixed-case": { ...DEVNET_ENV, VITE_SUPPORT_CLUSTER: "Devnet" },
    "no-program": { ...DEVNET_ENV, VITE_SUPPORT_PROGRAM_ID: "" },
    "zero-program": { ...DEVNET_ENV, VITE_SUPPORT_PROGRAM_ID: "11111111111111111111111111111111" },
    "no-tracker": { ...DEVNET_ENV, VITE_SUPPORT_TRACKER_URL: "" },
    "zero-recipient": { ...DEVNET_ENV, VITE_SUPPORT_RECIPIENT_A: "11111111111111111111111111111111" },
    "test-recipient": { ...DEVNET_ENV, VITE_SUPPORT_RECIPIENT_B: "6TcyBfPdBt1kjsvDZLzmBFnuMaLWiTaAt4RjUr9VA5YD" },
    "same-recipient": { ...DEVNET_ENV, VITE_SUPPORT_RECIPIENT_B: DEVNET_ENV.VITE_SUPPORT_RECIPIENT_A },
  };
  for (const [name, env] of Object.entries(variants)) {
    const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
    globalThis.__supportReadiness = READY;
    globalThis.__supportChecks = 0;
    const page = await loadPage(clean, `closed-${name}`);
    const { host, unmount } = await render(page);
    try {
      await assertClosed(host);
      assert.equal(globalThis.__supportChecks, 0, `${name}: no chain read`);
    } finally {
      await unmount();
    }
  }
});

test("blocked: a vault that doesn't check out stops signing and offers a retry", async () => {
  globalThis.__supportReadiness = { state: "blocked", reason: "The vault's recipients are placeholders.", retry: true };
  globalThis.__supportChecks = 0;
  const page = await loadPage(DEVNET_ENV, "blocked");
  const { host, unmount } = await render(page);
  try {
    assert.equal(host.querySelector('[data-testid="tip-card"]'), null, "no tip form while blocked");
    assert.match(host.textContent, /Tips are paused/);
    assert.match(host.textContent, /recipients are placeholders/);
    assert.match(host.textContent, /Nothing can be signed/);
    const retry = host.querySelector('[data-testid="support-retry"]');
    assert.ok(retry, "a retry is offered");
    globalThis.__supportReadiness = READY;
    await click(retry);
    assert.equal(globalThis.__supportChecks, 2, "retry reads the chain again");
    assert.ok(host.querySelector('[data-testid="tip-card"]'), "the tip form appears once the vault checks out");
  } finally {
    await unmount();
  }
});

test("open on Devnet: labeled Devnet test tokens, no real-value or donation claim", async () => {
  globalThis.__supportReadiness = READY;
  const page = await loadPage(DEVNET_ENV, "devnet");
  assert.equal(page.supportMode(true), "devnet");
  const { host, unmount } = await render(page);
  try {
    const text = host.textContent;
    assert.ok(host.querySelector('[data-testid="tip-card"]'), "the tip card shows when open");
    assert.match(text, /Devnet test tokens/);
    assert.match(text, /nothing here has real value/);
    assert.match(text, /Devnet test tokens only\. Nothing sent here has real value\./);
    assert.doesNotMatch(text, VALUE_CLAIM);
    assert.doesNotMatch(text, /Opening soon/);
    assert.match(text, /Open dashboard/, "the regular header comes back once open");
  } finally {
    await unmount();
  }
});

test("the hero words for each state stay inside what each state can do", async () => {
  const { SUPPORT_HERO } = await loadPage({}, "copy");
  assert.deepEqual(Object.keys(SUPPORT_HERO).sort(), ["closed", "devnet"], "no mainnet copy in a Devnet-only release");
  const closed = Object.values(SUPPORT_HERO.closed).map((v) => (typeof v === "function" ? v("@a", "@b") : v)).join(" ");
  const devnet = Object.values(SUPPORT_HERO.devnet).map((v) => (typeof v === "function" ? v("@a", "@b") : v)).join(" ");
  assert.doesNotMatch(closed, VALUE_CLAIM);
  assert.doesNotMatch(devnet, VALUE_CLAIM);
  assert.match(devnet, /test/i);
});
