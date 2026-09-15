import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(frontendRoot, "src");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

async function loadModule(relative) {
  const source = await readFile(join(srcRoot, relative), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${relative}`).toString("base64")}`);
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/overview", pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLDialogElement = window.HTMLDialogElement;
  if (globalThis.HTMLDialogElement && !globalThis.HTMLDialogElement.prototype.showModal) {
    globalThis.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
    globalThis.HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };
  }
  globalThis.Node = window.Node;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
  globalThis.matchMedia = window.matchMedia;
  globalThis.CSS = { supports: () => false, escape: (value) => value };
  window.scrollTo = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

test("dashboard nav lists every /app tab including protocol", async () => {
  const paths = await loadModule("routing/paths.ts");
  const navSource = await readFile(join(srcRoot, "dashboard/nav.ts"), "utf8");
  for (const tab of paths.DASHBOARD_TABS) {
    assert.match(navSource, new RegExp(`id: "${tab}"`));
  }
  assert.match(navSource, /id: "protocol"/);
  assert.match(navSource, /dashboardNavCoversAllTabs/);
});

test("Dashboard source uses published Astryx inventory primitives", async () => {
  const dashboard = await readFile(join(srcRoot, "dashboard/Dashboard.tsx"), "utf8");
  const nav = await readFile(join(srcRoot, "dashboard/DashboardNav.tsx"), "utf8");
  for (const needle of [
    '@astryxdesign/core/Button',
    '@astryxdesign/core/TextInput',
    '@astryxdesign/core/Selector',
    '@astryxdesign/core/FileInput',
    '@astryxdesign/core/Table',
    '@astryxdesign/core/TabList',
    '@astryxdesign/core/CheckboxInput',
    '@astryxdesign/core/RadioList',
    '@astryxdesign/core/Popover',
    '@astryxdesign/core/IconButton',
    '@astryxdesign/core/Skeleton',
    '@astryxdesign/core/Toast',
  ]) {
    assert.match(dashboard, new RegExp(needle.replace("/", "\\/")));
  }
  assert.match(nav, /@astryxdesign\/core\/MobileNav/);
  assert.match(nav, /@astryxdesign\/core\/Button/);
  assert.equal(dashboard.includes("from \"@/components/ui/"), false);
  assert.equal(dashboard.includes("<select"), false);
  assert.match(dashboard, /<FileInput/);
  assert.match(dashboard, /<Table/);
  assert.match(dashboard, /<TabList/);
  assert.match(dashboard, /<RadioList/);
  assert.match(dashboard, /<Popover/);
  assert.match(dashboard, /role="tablist"/);
  assert.match(dashboard, /panelId="settings-general"/);
  assert.match(dashboard, /panelId="receipt-lookup-pda"/);
  assert.equal(dashboard.includes("inputMode=\"decimal\""), false, "Astryx TextInput 0.6.1 has no inputMode prop");
});

test("DashboardNav renders all ten destinations and protocol", async () => {
  const outfile = join(frontendRoot, "test/.tmp-dashboard-nav.mjs");
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/dashboard/DashboardNav.tsx"],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile,
    external: ["react", "react-dom", "react/jsx-runtime"],
    plugins: [{
      name: "astryx-stubs",
      setup(build) {
        build.onResolve({ filter: /^@astryxdesign\/core\/(Button|MobileNav)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
          if (args.path.endsWith("/MobileNav")) {
            return {
              contents: "export function MobileNav({isOpen,onOpenChange,label,children,'data-testid':testId}){return isOpen?<dialog data-testid={testId} aria-label={label} open><button type=\"button\" onClick={()=>onOpenChange(false)}>Close</button>{children}</dialog>:null;}",
              loader: "jsx",
            };
          }
          return {
            contents: "export function Button({label,onClick,isDisabled,type,className,'aria-current':current,endContent}){return <button type={type||\"button\"} className={className} disabled={isDisabled} aria-current={current} onClick={onClick}>{label}{endContent}</button>;}",
            loader: "jsx",
          };
        });
      },
    }],
  });
  const dom = installDom();
  const { DashboardNav, DashboardMobileNav } = await import(pathToFileURL(outfile).href);
  const host = document.body.appendChild(document.createElement("div"));
  const reactRoot = createRoot(host);
  const selected = [];
  try {
    await act(async () => {
      reactRoot.render(createElement(DashboardNav, {
        tab: "overview",
        approvalCount: 0,
        toolCount: 4,
        onSelect: (tab) => selected.push(tab),
        onNavigateHome: () => selected.push("home"),
      }));
    });
    const labels = [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
    for (const label of ["Overview", "Mandates", "Payments", "Agents", "Receipts", "AI inbox", "Tools", "Connect MCP", "Protocol", "Settings", "Back to site"]) {
      assert.ok(labels.some((text) => text.includes(label)), `missing ${label}`);
    }
    const protocol = [...host.querySelectorAll("button")].find((button) => /Protocol/.test(button.textContent ?? ""));
    await act(async () => { protocol.click(); });
    assert.deepEqual(selected, ["protocol"]);

    await act(async () => {
      reactRoot.render(createElement(DashboardMobileNav, {
        isOpen: true,
        onOpenChange: (open) => selected.push(open ? "open" : "close"),
        tab: "payments",
        onSelect: () => {},
        onNavigateHome: () => {},
      }));
    });
    const dialog = document.querySelector("[data-testid='dashboard-mobile-nav']");
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-label"), "Dashboard navigation");
    const destinations = [...dialog.querySelectorAll("button")].map((button) => button.textContent ?? "");
    assert.ok(destinations.some((text) => text.includes("Protocol")));
    dialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const close = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Close");
    await act(async () => { close.click(); });
    assert.ok(selected.includes("close"));
  } finally {
    await act(async () => reactRoot.unmount());
    await unlink(outfile).catch(() => {});
    dom.window.close();
  }
});
