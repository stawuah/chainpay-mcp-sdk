import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unlink } from "node:fs/promises";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

/**
 * An account switch replaces the connected address in place: WalletController calls
 * setWalletConnection(next) and wallet.wallet goes straight from A to B, never empty.
 * AppWorkspace only renders OwnerWelcome when wallet.wallet is falsy, so without a key
 * React reuses the same Dashboard instance and its draft state — invoice, amount,
 * recipient, CSV batch, mandate builder — survives the switch. The Dashboard stub below
 * stands in for that state: it is local useState, exactly like the real component's.
 */
const STUBS = {
  "../owner/useOwnerSignIn": 'export function useOwnerSignIn(){return {status:"ready",error:"",signIn(){}}}',
  "../owner/OwnerEntry": "export function OwnerEntry(){return null}",
  "../settlement": "export function PendingSettlements(){return null}",
  "../routing/useRoute": 'export function useRoute(){return {currentRoute:{kind:"app",tab:"payments"},navigate(){}}}',
  "../wallet/context": "export function useWallet(){return globalThis.__wallet}",
  "../owner/OwnerWelcome": "export function OwnerWelcome(){return <p>welcome</p>}",
  "../owner/runtime": "export function buildStablecoinOptions(){return []}",
  "../wallet/draftStore": "export function clearWalletDrafts(){}",
  "./Dashboard": `
    import { useState, useEffect } from "react";
    export default function Dashboard({ wallet }) {
      const [draft, setDraft] = useState("");
      useEffect(() => { globalThis.__mounts = (globalThis.__mounts ?? 0) + 1; }, []);
      return <div>
        <span data-testid="wallet">{wallet}</span>
        <span data-testid="draft">{draft}</span>
        <button type="button" data-testid="fill" onClick={() => setDraft("invoice drafted under " + wallet)}>fill</button>
      </div>;
    }`,
};

test("switching wallet accounts does not carry payment drafts to the new wallet", async () => {
  const outfile = join(frontendRoot, "test/.tmp-app-workspace.mjs");
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/dashboard/AppWorkspace.tsx"],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile,
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime"],
    plugins: [{
      name: "workspace-stubs",
      setup(build) {
        const filter = new RegExp(`^(${Object.keys(STUBS).map((k) => k.replace(/[./]/g, "\\$&")).join("|")})$`);
        build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "jsx" }));
      },
    }],
  });

  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/payments" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__mounts = 0;

  const walletFor = (address) => ({
    wallet: address,
    walletName: "Fixture wallet",
    walletCapabilities: null,
    signTransaction: undefined,
    signMessage: undefined,
    mandate: undefined,
    mandates: [],
    protocolConfig: null,
    registeredAssets: [],
    mcpTools: [],
    mcpResult: null,
    integrationStatus: "idle",
    integrationError: "",
    switchingWalletAccount: false,
  });
  globalThis.__wallet = walletFor("WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

  const AppWorkspace = (await import(pathToFileURL(outfile).href)).default;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const q = (id) => host.querySelector(`[data-testid="${id}"]`);

  await act(async () => { root.render(createElement(AppWorkspace)); });
  assert.equal(q("wallet").textContent, "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "dashboard should mount for wallet A");

  await act(async () => { q("fill").click(); });
  assert.match(q("draft").textContent, /WalletAAA/, "wallet A should now hold a draft");

  // The account switch: a new address, no disconnect, no empty interval.
  globalThis.__wallet = walletFor("WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  await act(async () => { root.render(createElement(AppWorkspace)); });

  assert.equal(q("wallet").textContent, "WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "dashboard should now show wallet B");
  assert.equal(q("draft").textContent, "", "wallet B must not inherit wallet A's draft");
  assert.equal(globalThis.__mounts, 2, "dashboard must remount on an account switch");

  await act(async () => { root.unmount(); });
  await unlink(outfile);
});
