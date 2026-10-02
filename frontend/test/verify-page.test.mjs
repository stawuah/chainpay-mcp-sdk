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

function installDom(url = "https://chainpay.example/verify/InvalidPDA") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url, pretendToBeVisual: true });
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
    assert.match(host.textContent ?? "", /No seller statement/);
    assert.equal((host.textContent ?? "").includes("Delivered"), false);
    assert.ok(host.querySelector("[data-stamp='paid'][data-tone='yes']"));
    assert.ok(host.querySelector("[data-stamp='seller'][data-tone='neutral']"));
    const summary = host.querySelector(".receipt-summary");
    assert.ok(summary);
    assert.equal(summary.closest("details"), null, "summary must remain visible without disclosure");
    assert.match(summary.textContent, /Agent signing address/);
    assert.match(summary.textContent, /Recipient token account/);
    assert.match(summary.textContent, /Executed slot/);
    assert.match(host.querySelector(".receipt-public-url").textContent, /https:\/\/chainpay.example\/verify\/2KW2XR/);

    const privateText = document.body.appendChild(document.createElement("p"));
    privateText.textContent = "PRIVATE REQUEST AND ATTACHMENT";
    const originalAppend = document.body.appendChild.bind(document.body);
    let printed = false;
    document.body.appendChild = (node) => {
      const added = originalAppend(node);
      if (node.tagName === "IFRAME") {
        node.contentWindow.focus = () => {};
        node.contentWindow.print = () => {
          const output = node.contentDocument.body;
          assert.match(output.textContent, /chainpay/);
          assert.equal(output.querySelectorAll(".cp-brand-symbol path").length, 2);
          assert.match(output.textContent, /4\.500000 USDC/);
          assert.match(output.textContent, /No seller statement/);
          assert.match(output.textContent, /Paid is unchanged/);
          assert.equal(output.textContent.includes(privateText.textContent), false);
          assert.equal(output.querySelector("button"), null);
          assert.ok([...output.querySelectorAll("details")].every((details) => details.open));
          assert.equal(output.querySelector("[data-stamp='paid']").textContent, host.querySelector("[data-stamp='paid']").textContent);
          printed = true;
          node.contentWindow.dispatchEvent(new window.Event("afterprint"));
        };
      }
      return added;
    };
    const print = [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Print / Save as PDF"));
    await act(async () => print.click());
    assert.equal(printed, true);
    assert.equal(document.querySelector("iframe"), null);
    document.body.appendChild = originalAppend;

    assert.equal(host.textContent.includes("Connect wallet"), false);
  } finally {
    await act(async () => reactRoot.unmount());
    await unlink(outfile).catch(() => {});
    dom.window.close();
  }
});

async function renderVerify(receiptPda, url) {
  const outfile = join(frontendRoot, `test/.tmp-verify-page-${Date.now()}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/verify/VerifyPage.tsx"],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile,
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime", "@chainpay/sdk"],
    plugins: [stubReceiptLoadPlugin()],
  });
  const dom = installDom(url);
  try {
    const { VerifyPage } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    const host = document.body.appendChild(document.createElement("div"));
    const reactRoot = createRoot(host);
    await act(async () => {
      reactRoot.render(createElement(VerifyPage, { receiptPda }));
    });
    for (let attempt = 0; attempt < 20 && !/Order match|Spending permission at payment/.test(host.textContent ?? ""); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    const text = host.textContent ?? "";
    await act(async () => reactRoot.unmount());
    return text;
  } finally {
    await unlink(outfile).catch(() => {});
    dom.window.close();
  }
}

const purchaseFixture = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(frontendRoot, "test/fixtures/receipt-purchase.json"), "utf8")));
const V2_PDA = "3Rcpt2v2SnapshotFixture111111111111111111";

test("public verify without an audit link shows limits at payment and no purchase claim", async () => {
  const text = await renderVerify(V2_PDA, `https://chainpay.example/verify/${V2_PDA}`);
  assert.match(text, /Spending permission at payment/);
  assert.match(text, /Recorded on Solana at payment/);
  assert.equal(text.includes("Order match"), false);
  assert.equal(text.includes("Invoice signed by seller"), false);
  assert.equal(text.includes("Market data API"), false);
});

test("public verify shows invoice details only after the audit link verifies", async () => {
  const fragment = Buffer.from(JSON.stringify(purchaseFixture.request)).toString("base64url");
  const text = await renderVerify(V2_PDA, `https://chainpay.example/verify/${V2_PDA}#purchase=${fragment}`);
  assert.match(text, /Order match/);
  assert.match(text, /Invoice signed by seller/);
  assert.match(text, /Market data API, October usage/);
  assert.match(text, /Details from the link you opened/);
  assert.equal(text.includes("Share with details"), false);
});

test("public verify rejects an audit link for a different receipt and shows none of it", async () => {
  const fragment = Buffer.from(JSON.stringify(purchaseFixture.request)).toString("base64url");
  const text = await renderVerify("2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", `https://chainpay.example/verify/2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1#purchase=${fragment}`);
  assert.match(text, /Invoice not verified: it is not the invoice this receipt paid\. Nothing from it is shown\./);
  assert.equal(text.includes("Market data API"), false);
  assert.equal(text.includes("INV-2026-0142"), false);
});
