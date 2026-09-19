import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

// Only the component's own behaviour is under test, so the clipboard, the token
// artwork and the Astryx button are stubbed. The clipboard stub is what lets the
// refusal path be exercised at all: a real one cannot be made to fail on demand.
const stubs = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /@astryxdesign\/core\/Button$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onResolve({ filter: /ui\/TokenIcon$/ }, (args) => ({ path: "TokenIcon", namespace: "stub" }));
    build.onResolve({ filter: /owner\/runtime$/ }, (args) => ({ path: "runtime", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      if (args.path === "TokenIcon") {
        return { contents: "export function TokenIcon({mint}){return <i data-token={mint} />;}", loader: "jsx" };
      }
      if (args.path === "runtime") {
        return {
          contents: `export async function copyValue(value){
            globalThis.__copied.push(value);
            return globalThis.__copyOk;
          }`,
          loader: "js",
        };
      }
      return {
        contents: "export function Button({label,onClick,isDisabled,type}){return <button type={type||\"button\"} disabled={isDisabled} onClick={onClick}>{label}</button>;}",
        loader: "jsx",
      };
    });
  },
};

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/settings" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PYUSD = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
const WALLET = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
// Derived from WALLET and each mint by the SDK, which the component calls for real.
const USDC_ACCOUNT = "3Fd8V7E95c5AkvBiDpRGMMm8tAFrPRE8co1HeX76ua4i";
const PYUSD_ACCOUNT = "9rhdsFzTuLu2EaW3DFGFq94fSS9ubQEmeP3XcCeTykJX";
const options = [
  { value: USDC, mint: USDC, label: "USDC", detail: "Classic SPL Token", tokenProgram: "spl-token" },
  { value: PYUSD, mint: PYUSD, label: "PYUSD", detail: "Token-2022 · capability checked at payment", tokenProgram: "token-2022" },
];

const outfile = join(frontendRoot, "test/.tmp-token-addresses.mjs");
await esbuild.build({
  absWorkingDir: frontendRoot,
  entryPoints: ["src/dashboard/TokenAddresses.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  outfile,
  external: ["react", "react-dom", "react/jsx-runtime", "lucide-react"],
  plugins: [stubs],
});
const { TokenAddresses } = await import(pathToFileURL(outfile).href);

async function mount(props) {
  const dom = installDom();
  globalThis.__copied = [];
  globalThis.__copyOk = true;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(createElement(TokenAddresses, props)); });
  const rerender = async () => { await act(async () => {}); };
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
  };
  return { host, rerender, cleanup };
}

const buttons = (host) => [...host.querySelectorAll("button")];
const labels = (host) => buttons(host).map((b) => b.textContent ?? "");

test("every enabled token lists the account that receives it and the mint that names it", async () => {
  const { host, cleanup } = await mount({ options, wallet: WALLET });
  try {
    const codes = [...host.querySelectorAll("code")].map((node) => node.textContent);
    assert.deepEqual(codes, [USDC_ACCOUNT, USDC, PYUSD_ACCOUNT, PYUSD]);
    const text = host.textContent ?? "";
    assert.match(text, /USDC/);
    assert.match(text, /PYUSD/);
    // The token program decides which program a payment must use, so it is shown.
    assert.match(text, /Classic SPL Token/);
    assert.match(text, /Token-2022/);
  } finally {
    await cleanup();
  }
});

test("each token has its own copy action naming that token", async () => {
  const { host, cleanup } = await mount({ options, wallet: WALLET });
  try {
    assert.deepEqual(labels(host), [
      "Copy USDC account", "Copy USDC mint",
      "Copy PYUSD account", "Copy PYUSD mint",
    ]);
  } finally {
    await cleanup();
  }
});

test("the account button copies the token account and the mint button copies the mint", async () => {
  const { host, rerender, cleanup } = await mount({ options, wallet: WALLET });
  try {
    await act(async () => { buttons(host)[2].click(); });
    await rerender();
    await act(async () => { buttons(host)[3].click(); });
    await rerender();
    assert.deepEqual(globalThis.__copied, [PYUSD_ACCOUNT, PYUSD]);
  } finally {
    await cleanup();
  }
});

test("copying one address does not report success under another", async () => {
  const { host, rerender, cleanup } = await mount({ options, wallet: WALLET });
  try {
    await act(async () => { buttons(host)[0].click(); });
    await rerender();
    assert.deepEqual(labels(host), [
      "Copied", "Copy USDC mint",
      "Copy PYUSD account", "Copy PYUSD mint",
    ]);
    const statuses = [...host.querySelectorAll("[role='status']")].map((node) => node.textContent);
    assert.deepEqual(statuses, ["Copied"]);
  } finally {
    await cleanup();
  }
});

test("a refused clipboard tells the owner to select the address instead of claiming success", async () => {
  const { host, rerender, cleanup } = await mount({ options, wallet: WALLET });
  try {
    globalThis.__copyOk = false;
    await act(async () => { buttons(host)[0].click(); });
    await rerender();
    const status = host.querySelector("[role='status']")?.textContent ?? "";
    assert.match(status, /Could not copy/);
    assert.equal(labels(host).includes("Copied"), false);
  } finally {
    await cleanup();
  }
});

test("an empty registry says so rather than rendering an empty card", async () => {
  const { host, cleanup } = await mount({ options: [], wallet: WALLET });
  try {
    assert.equal(host.querySelectorAll("code").length, 0);
    assert.equal(buttons(host).length, 0);
    assert.match(host.textContent ?? "", /No enabled registry assets have loaded yet/);
  } finally {
    await cleanup();
  }
});

test.after(async () => {
  await unlink(outfile).catch(() => {});
  await unlink(outfile.replace(/\.mjs$/, ".css")).catch(() => {});
});
