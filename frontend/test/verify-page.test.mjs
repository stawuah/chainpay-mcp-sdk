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

function stubReceiptLoadPlugin() {
  return {
    name: "stub-receipt-load",
    setup(build) {
      build.onResolve({ filter: /receipts\/load$/ }, () => ({
        path: join(frontendRoot, "test/fixtures/public-receipt-load.ts"),
      }));
    },
  };
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/verify/InvalidPDA", pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

test("public verify renders a distinct malformed PDA state without a success stamp", async () => {
  const outfile = join(frontendRoot, "test/.tmp-verify-page.mjs");
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/verify/VerifyPage.tsx"],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile,
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime"],
    plugins: [stubReceiptLoadPlugin()],
  });
  const dom = installDom();
  const { VerifyPage } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  const host = document.body.appendChild(document.createElement("div"));
  const reactRoot = createRoot(host);
  try {
    await act(async () => {
      reactRoot.render(createElement(VerifyPage, { receiptPda: "InvalidPDA" }));
    });
    const alert = host.querySelector("[role='alert']");
    assert.ok(alert, "malformed PDA should be an alert");
    assert.match(alert.textContent, /not a valid Solana account/);
    assert.equal(host.querySelector("[data-paid='yes']"), null);
    assert.equal(host.querySelector("[data-stamp='paid']"), null);
    assert.equal(host.textContent.includes("Connect wallet"), false);
  } finally {
    await act(async () => reactRoot.unmount());
    await unlink(outfile).catch(() => {});
    dom.window.close();
  }
});

test("public verify renders a mocked settled receipt without inventing delivery", async () => {
  const outfile = join(frontendRoot, "test/.tmp-verify-page-fixture.mjs");
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/verify/VerifyPage.tsx"],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile,
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime"],
    plugins: [stubReceiptLoadPlugin()],
  });
  const dom = installDom();
  const { VerifyPage } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  const host = document.body.appendChild(document.createElement("div"));
  const reactRoot = createRoot(host);
  try {
    await act(async () => {
      reactRoot.render(createElement(VerifyPage, { receiptPda: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1" }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.match(host.textContent ?? "", /4\.500000 USDC/);
    assert.match(host.textContent ?? "", /Seller statement absent/);
    assert.equal((host.textContent ?? "").includes("Delivered"), false);
    assert.ok(host.querySelector("[data-stamp='paid'][data-tone='yes']"));
    assert.ok(host.querySelector("[data-stamp='seller'][data-tone='neutral']"));
    assert.equal(host.textContent.includes("Connect wallet"), false);
  } finally {
    await act(async () => reactRoot.unmount());
    await unlink(outfile).catch(() => {});
    dom.window.close();
  }
});
