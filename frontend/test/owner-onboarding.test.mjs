import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(frontendRoot, "src");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

async function compile(relative) {
  const source = await readFile(join(srcRoot, relative), "utf8");
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}

async function loadModule(relative) {
  const compiled = await compile(relative);
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${relative}`).toString("base64")}`);
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/overview", pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.Node = window.Node;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

test("empty overview copy names the first-mandate path and distinguishes login from approval", async () => {
  const onboarding = await loadModule("owner/onboarding.ts");
  assert.equal(onboarding.FIRST_MANDATE_TITLE, "Set up your first mandate");
  assert.deepEqual(onboarding.OWNER_SETUP_STEPS.map((step) => step.label), ["Connect wallet", "Sign in", "Review mandate", "Approve in wallet"]);
  assert.match(onboarding.LOGIN_VS_APPROVAL, /login message/i);
  assert.match(onboarding.LOGIN_VS_APPROVAL, /wallet transaction/i);
  assert.equal(onboarding.EMPTY_OWNER_ACTIVITY, "No payments for this wallet yet.");
  assert.equal(onboarding.configuredDemoReceiptPath(""), null);
  assert.equal(onboarding.configuredDemoReceiptPath("not-a-pda"), null);
});

test("mandate review keeps exact token amounts and rejects extra decimals", async () => {
  const amounts = await loadModule("owner/amounts.ts");
  assert.equal(amounts.parseTokenAmount("10.50", 6).toString(), "10500000");
  assert.equal(amounts.reviewExactAmount("10.50", 6), "10.5");
  assert.equal(amounts.reviewExactAmount("10.500000", 6), "10.5");
  assert.equal(amounts.parseTokenAmount("1", 0).toString(), "1");
  assert.throws(() => amounts.parseTokenAmount("1.234", 2), /decimal places/);
  assert.throws(() => amounts.parseTokenAmount("1e2", 6), /valid non-negative/);
  assert.throws(() => amounts.parseTokenAmount("-1", 6), /valid non-negative/);
});

test("connection scope is limited to owned mandates and allowPayments is explicit", async () => {
  const scope = await loadModule("owner/connectionScope.ts");
  const owned = scope.ownedMandateAddresses([
    { address: "owner-mandate", owner: "owner-a", status: "active" },
    { address: "other-mandate", owner: "owner-b", status: "active" },
    { address: "revoked-mandate", owner: "owner-a", status: "revoked" },
  ], "owner-a");
  assert.deepEqual(owned, ["owner-mandate"]);
  const readOnly = JSON.parse(scope.buildConnectionScope("owner-mandate", owned, false));
  assert.deepEqual(readOnly.mandates, ["owner-mandate"]);
  assert.equal(readOnly.tools.includes("execute_payment"), false);
  const withPay = JSON.parse(scope.buildConnectionScope("owner-mandate", owned, true));
  assert.equal(withPay.tools.includes("execute_payment"), true);
  assert.throws(() => scope.buildConnectionScope("other-mandate", owned, true), /another owner's mandate/);
});

test("slot estimates are labeled estimated and never treat 216000 slots as a day", async () => {
  const slots = await loadModule("owner/slotEstimate.ts");
  const sample = slots.slotDurationFromSample({ numSlots: 2, samplePeriodSecs: 1 });
  assert.equal(sample.estimated, true);
  assert.equal(sample.secondsPerSlot, 0.5);
  assert.equal(slots.estimatedSlotsForDays(1, sample).toString(), "172800");
  assert.notEqual(slots.estimatedSlotsForDays(1, sample).toString(), "216000");
  const label = slots.mandateExpiryLabel(1000n, 100n, sample);
  assert.match(label, /Estimated/);
  assert.match(label, /slot 1000/);
  assert.equal(slots.mandateExpiryLabel(1000n, null, null), "Expiry slot 1000");
  assert.equal(slots.sampleFromRpcResult([{ numSlots: 4, samplePeriodSecs: 2 }]).numSlots, 4);
  assert.equal(slots.sampleFromRpcResult([]), null);
});

test("Dashboard empty overview and settings no longer invent this wallet's payments or fake prefs", async () => {
  const dashboard = await readFile(join(srcRoot, "dashboard/Dashboard.tsx"), "utf8");
  assert.equal(dashboard.includes("Verified Devnet baselines"), false);
  assert.equal(dashboard.includes("216_000"), false);
  assert.equal(dashboard.includes("216000"), false);
  assert.match(dashboard, /FIRST_MANDATE_TITLE/);
  assert.match(dashboard, /EmptyOwnerOverview/);
  assert.match(dashboard, /No payments for this wallet yet/);
  assert.match(dashboard, /Owned mandate/);
  assert.match(dashboard, /allowPayments/);
  assert.match(dashboard, /Permit payments within this mandate/);
  assert.match(dashboard, /Solana Devnet/);
  assert.match(dashboard, /Notifications unavailable/);
  assert.equal(dashboard.includes("Mainnet-beta"), false);
  assert.match(dashboard, /Estimated/);
  assert.match(dashboard, /reviewExactAmount/);
  assert.match(dashboard, /buildConnectionScope/);
});

test("EmptyOwnerOverview renders the setup path without a live wallet transaction", async () => {
  const outfile = join(frontendRoot, "test/.tmp-empty-overview.mjs");
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/owner/EmptyOwnerOverview.tsx"],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile,
    external: ["react", "react-dom", "react/jsx-runtime"],
    plugins: [{
      name: "astryx-button-stub",
      setup(build) {
        build.onResolve({ filter: /^@astryxdesign\/core\/Button$/ }, () => ({ path: "astryx-button", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export function Button({label,onClick,isDisabled,type}){return <button type={type||\"button\"} disabled={isDisabled} onClick={onClick}>{label}</button>;}",
          loader: "jsx",
        }));
      },
    }],
  });
  const dom = installDom();
  const { EmptyOwnerOverview } = await import(pathToFileURL(outfile).href);
  const host = document.body.appendChild(document.createElement("div"));
  const reactRoot = createRoot(host);
  let reviewed = 0;
  try {
    await act(async () => {
      reactRoot.render(createElement(EmptyOwnerOverview, {
        walletConnected: true,
        signedIn: false,
        signingIn: false,
        signInError: "",
        onSignIn: () => {},
        onReviewMandate: () => { reviewed += 1; },
        demoReceiptHref: null,
      }));
    });
    const text = host.textContent ?? "";
    assert.match(text, /Set up your first mandate/);
    assert.match(text, /Connect wallet/);
    assert.match(text, /Sign in/);
    assert.match(text, /Review mandate/);
    assert.match(text, /Approve in wallet/);
    assert.match(text, /login message/);
    assert.match(text, /No payments for this wallet yet/);
    assert.equal(text.includes("Verified Devnet"), false);
    const review = [...host.querySelectorAll("button")].find((button) => /Review mandate/i.test(button.textContent ?? ""));
    assert.ok(review);
    await act(async () => { review.click(); });
    assert.equal(reviewed, 1);
  } finally {
    await act(async () => reactRoot.unmount());
    await unlink(outfile).catch(() => {});
    dom.window.close();
  }
});
