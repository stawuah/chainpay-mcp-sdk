import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const landingPath = resolve(root, "landing/LandingPage.tsx");

const blocked = [
  "@chainpayhq/sdk",
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

test("landing CTAs stay on wired callbacks and the receipt CTA opens a real receipt", async () => {
  const text = await source();
  assert.match(text, /from "@astryxdesign\/core\/Button"/);
  assert.match(text, /label="Open dashboard"/);
  assert.match(text, /isDisabled=/);
  assert.match(text, /onClick=\{onOpenDashboard\}/);
  assert.match(text, /onClick=\{onConnect\}|onConnect\(\)/);
  assert.match(text, /label="See a receipt" isDisabled=\{false\} href=\{DEMO_RECEIPT_PATH\}/);
  assert.match(text, /from "\.\.\/receipts\/demoReceipt"/);
  assert.equal(text.includes("VITE_CHAINPAY_DEMO_RECEIPT_PDA"), false);
  assert.equal(text.includes("VITE_"), false);
  // The hero keeps one action; the header still opens the dashboard.
  const hero = text.slice(text.indexOf('className="landing-hero-actions"'), text.indexOf('className="t-body-sm landing-hero-note"'));
  assert.equal(hero.includes("Open dashboard"), false);
  assert.match(text, /className="top-actions"[\s\S]*label="Open dashboard"/);
});

test("the demo receipt is a fixed, real Devnet receipt address, not an env value", async () => {
  const demo = await readFile(resolve(root, "receipts/demoReceipt.ts"), "utf8");
  assert.match(demo, /DEMO_RECEIPT_PDA = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q"/);
  assert.match(demo, /DEMO_RECEIPT_PATH = `\/verify\/\$\{DEMO_RECEIPT_PDA\}`/);
  assert.equal(demo.includes("VITE_"), false);
  assert.equal(demo.includes("import "), false, "the landing bundle stays free of receipt code");
});

test("the illustrative receipt never reads as a live verification", async () => {
  const text = await source();
  assert.equal(text.includes("A live receipt reports the verified settlement state"), false);
  assert.match(text, /Example, not verified/);
});

test("illustrative receipt uses the approved example and never claims payment", async () => {
  const text = await source();
  assert.match(text, /Illustrative receipt · no payment made/);
  assert.match(text, /4\.50 USDC/);
  assert.match(text, /10 USDC/);
  assert.match(text, /100 USDC/);
  assert.match(text, /No seller statement/);
  assert.match(text, /Each receipt says whether its limits were recorded at payment or are today’s/);
  assert.match(text, /Public receipts exclude private request text and attachments/);
});

test("x402 and managed signing status stay honest", async () => {
  const text = await source();
  assert.match(text, /unsupported-sponsor/);
  assert.match(text, /Proven on Devnet with a demo seller: 402, payment inside the spending limit, receipt check, 200/);
  assert.match(text, /A replay doesn't pay twice/);
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
