import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const landingPath = resolve(root, "landing/LandingPage.tsx");

const blocked = [
  "@chainpay/sdk",
  "config/client",
  "wallet/connect",
  "wallet/WalletController",
  "owner/runtime",
];

const removed = [
  "The universal payment rail",
  "heroMessage",
  "MiniChart",
  "Stay in the loop",
  "Your email",
  "connector-routing",
  "x402.org",
  "lobster.cash",
  "Verified Devnet Activity",
  "#/aifi",
  "use-cases/treasury",
];

async function source() {
  return (await readFile(landingPath, "utf8")) + (await readFile(resolve(root, "landing/PaymentStory.tsx"), "utf8"));
}

test("landing preserves identity and tells the permission-to-receipt story", async () => {
  const text = await source();
  assert.match(text, /Give agents limits\./);
  assert.match(text, /Not your keys\./);
  assert.match(text, /Policy payments · Solana Devnet/);
  assert.match(text, /id="how-it-works"/);
  assert.match(text, /id: "spend-limits"/);
  assert.match(text, /id: "receipts"/);
  assert.match(text, /id="developers"/);
  assert.match(text, /id="faq"/);
  assert.match(text, /One agent. One payment./);
  assert.match(text, /Give the work a budget\./);
  assert.match(text, /The evidence stays\./);
  assert.match(text, /Fits the agent workflow you already have\./);
  assert.match(text, /Put your first agent on a budget\./);
});

test("landing CTAs stay on wired callbacks and do not invent a live receipt URL", async () => {
  const text = await source();
  assert.match(text, /from "@astryxdesign\/core\/Button"/);
  assert.match(text, /label="Open dashboard"/);
  assert.match(text, /isDisabled=/);
  assert.match(text, /onClick=\{onOpenDashboard\}/);
  assert.match(text, /onClick=\{onConnect\}|onConnect\(\)/);
  assert.match(text, /href="#receipts"/);
  assert.match(text, /See a receipt/);
  assert.equal(text.includes("/verify/"), false);
  assert.equal(text.includes("VITE_"), false);
});

test("illustrative receipt uses the approved example and never claims payment", async () => {
  const text = await source();
  assert.match(text, /Illustrative receipt · no payment made/);
  assert.match(text, /4\.50 USDC/);
  assert.match(text, /10 USDC/);
  assert.match(text, /100 USDC/);
  assert.match(text, /No seller statement/);
  assert.match(text, /Current permission settings are not a historical snapshot/);
  assert.match(text, /Public receipts exclude private request text and attachments/);
});

test("x402 and managed signing status stay honest", async () => {
  const text = await source();
  assert.match(text, /unsupported-sponsor/);
  assert.match(text, /receipt-proof|receipt PDA/);
  assert.match(text, /Not live facilitator acceptance/);
  assert.match(text, /Managed signing/);
  assert.match(text, /not hosted key custody/i);
});

test("landing drops rotating headlines, charts, newsletter, and connector microsites", async () => {
  const text = await source();
  for (const needle of removed) {
    assert.equal(text.includes(needle), false, `landing still contains ${needle}`);
  }
});

test("landing module does not import SDK, wallet connect, or client config", async () => {
  const text = await source();
  for (const needle of blocked) {
    assert.equal(text.includes(needle), false, `landing imported ${needle}`);
  }
  assert.match(text, /from "\.\.\/config\/public"/);
});
