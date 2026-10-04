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
const outfile = join(frontendRoot, "test/.tmp-status-page.mjs");

const DAY = 86_400_000;
const IDS = ["web", "relay", "mcp", "solana", "program"];
const dayKey = (at) => new Date(at).toISOString().slice(0, 10);
// Today only counts the checks due so far (see expectedChecks in shared/status.ts).
const dueToday = (now) => Math.max(1, Math.floor((now % DAY) / 300_000));
const full = (now, count = 90) => Array.from({ length: count }, (_, i) => {
  const total = i === 0 ? dueToday(now) : 288;
  return { day: dayKey(now - i * DAY), total, up: total, degraded: 0, down: 0 };
});
function feed({ at, days, incidents = [], state = "up" }) {
  const now = Date.now();
  return { generatedAt: now, incidents, components: IDS.map((id) => ({ id, state, at, latencyMs: 120, days: days ?? full(now) })) };
}

await esbuild.build({
  absWorkingDir: frontendRoot,
  entryPoints: ["src/status/StatusPage.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  outfile,
  loader: { ".css": "empty" },
  define: { "import.meta.env": "{}" },
  external: ["react", "react-dom", "react/jsx-runtime"],
});
test.after(() => unlink(outfile).catch(() => {}));

async function render(response) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/status", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/status\/v1$/);
    if (response === null) throw new TypeError("network down");
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const { default: StatusPage } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(StatusPage)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return {
    host,
    banner: () => host.querySelector(".status-banner h2").textContent,
    rows: () => [...host.querySelectorAll(".status-current")].map((el) => el.textContent.trim()),
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      dom.window.close();
    },
  };
}

test("fresh checks show every component operational", async () => {
  const page = await render(feed({ at: Date.now() - 60_000 }));
  try {
    assert.equal(page.banner(), "All systems operational");
    assert.deepEqual(page.rows(), Array(5).fill("Operational"));
  } finally { await page.close(); }
});

test("F1 stale checks show each component as Unknown, not Operational", async () => {
  const page = await render(feed({ at: Date.now() - 3 * DAY }));
  try {
    assert.equal(page.banner(), "Status unknown");
    assert.deepEqual(page.rows(), Array(5).fill("Unknown"));
    assert.equal(page.host.querySelectorAll(".status-current.status-tone-ok").length, 0);
  } finally { await page.close(); }
});

test("a stale outage is not reported as a current outage", async () => {
  const page = await render(feed({ at: Date.now() - 3 * DAY, state: "down" }));
  try {
    assert.equal(page.banner(), "Status unknown");
    assert.deepEqual(page.rows(), Array(5).fill("Unknown"));
  } finally { await page.close(); }
});

test("a failed feed says unavailable and never shows a component as operational", async () => {
  const page = await render(null);
  try {
    assert.equal(page.banner(), "Status data unavailable");
    assert.deepEqual(page.rows(), Array(5).fill("Unknown"));
  } finally { await page.close(); }
});

test("F3 one day of data reads as partial coverage, not 100% over 90 days", async () => {
  const now = Date.now();
  const yesterday = { day: dayKey(now - DAY), total: 288, up: 288, degraded: 0, down: 0 };
  const page = await render(feed({ at: now - 60_000, days: [yesterday] }));
  try {
    const axis = page.host.querySelector(".status-axis").textContent;
    assert.match(axis, /100\.00% uptime · \d+% of time checked/);
    assert.match(page.host.querySelector(".status-bars").getAttribute("aria-label"), /No checks on 89 of these days/);
  } finally { await page.close(); }
});

test("F3 a day the prober barely ran is a partial-data bar, not a green one", async () => {
  const now = Date.now();
  const days = full(now).map((d, i) => i === 2 ? { ...d, total: 1, up: 1 } : d);
  const page = await render(feed({ at: now - 60_000, days }));
  try {
    const bars = [...page.host.querySelector(".status-row .status-bars").children];
    assert.equal(bars.length, 90);
    assert.match(bars[87].className, /status-bar-gaps/);
    assert.equal(bars.filter((bar) => bar.className.includes("status-bar-gaps")).length, 1);
    assert.match(page.host.querySelector(".status-legend").textContent, /Partial data/);
    assert.match(page.host.querySelector(".status-bars").getAttribute("aria-label"), /partial data on/);
  } finally { await page.close(); }
});

test("F4 a reopened incident (resolvedAt null) shows as active, not past", async () => {
  const now = Date.now();
  const incident = { id: "i1", title: "Relay down", impact: "major", components: ["relay"], startedAt: now - 3_600_000, resolvedAt: null,
    updates: [{ at: now - 3_600_000, state: "investigating", message: "x" }, { at: now - 1_800_000, state: "resolved", message: "fixed" }, { at: now - 60_000, state: "investigating", message: "it is back" }] };
  const page = await render(feed({ at: now - 60_000, incidents: [incident] }));
  try {
    assert.ok(page.host.querySelector("[aria-label='Active incident']"));
    assert.match(page.host.querySelector(".status-empty").textContent, /No incidents/);
  } finally { await page.close(); }
});
