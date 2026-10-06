import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/use-cases/data.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const data = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("every use case has a unique slug, both images, and plain-word copy", () => {
  const slugs = new Set();
  for (const item of data.USE_CASES) {
    assert.ok(!slugs.has(item.slug), `duplicate slug ${item.slug}`);
    slugs.add(item.slug);
    for (const size of ["card", "hero"]) {
      assert.ok(existsSync(new URL(`../public${data.imageFor(item, size)}`, import.meta.url)), `missing ${size} image for ${item.slug}`);
    }
    assert.equal(item.steps.length, 3);
    assert.ok(item.why.length <= 3, `${item.slug} has more than 3 reasons`);
    for (const line of [item.title, ...item.steps]) {
      assert.doesNotMatch(line, /mandate|PDA|policy|x402|!/i, `${item.slug}: "${line}"`);
    }
  }
  assert.equal(data.USE_CASES.filter((item) => item.featured).length, 1);
});

// Review 2026-10-04 (pr39-cards-teaser F1–F4): reader-facing copy must not overclaim privacy or availability.
const BANNED = [
  /only you/i,
  /nobody else/i,
  /no one else/i,
  /regular checkouts?/i,
  /any (shop|store|merchant|checkout)/i,
  /real (shops|stores|merchants)/i,
  /building it now/i,
];

test("summaries, reasons and soon notes stay inside what ships", () => {
  for (const item of data.USE_CASES) {
    const lines = [item.title, item.summary, ...item.steps, ...item.why, item.soonNote?.title, item.soonNote?.body, item.liveNote?.title, item.liveNote?.body].filter(Boolean);
    for (const line of lines) {
      for (const phrase of BANNED) assert.doesNotMatch(line, phrase, `${item.slug}: "${line}"`);
    }
  }
});

// Live on Devnet since 2026-10-06 (docs/project/release-manifest.md, Cards gates).
// It must still say sandbox test card, Devnet and simulated credit everywhere a reader lands.
test("the agent card entry is live but honest about sandbox, simulated credit and privacy", () => {
  const card = data.findUseCase("private-agent-card");
  assert.ok(card, "private-agent-card entry missing");
  assert.equal(card.status, "live");
  assert.match(card.summary, /virtual card/i);
  assert.match(card.summary, /sandbox test card/i);
  assert.match(card.summary, /Devnet/);
  assert.match(card.summary, /simulated credit/i);
  assert.match(card.summary, /no real card money/i);
  assert.match(card.why.join(" "), /public chain/i);
  assert.match(card.why.join(" "), /issuer/i, "say who else can see card limits");
  assert.deepEqual(card.example.find(([label]) => label === "Real money"), ["Real money", "None · sandbox and Devnet only"]);
  assert.match(card.example.map(([, value]) => value).join(" "), /simulated credit/i);
  assert.equal(card.cta.href, "/app/cards");
  assert.equal(card.soonNote, undefined, "a live card has no soon note");
  assert.ok(card.liveNote, "card needs its own live note with the sandbox caveat");
  assert.match(card.liveNote.body, /sandbox test card/i);
  assert.match(card.liveNote.body, /simulated/i);
  assert.match(card.liveNote.body, /Devnet USDC/);
});

test("the landing teaser and the use-case page read the same entry", async () => {
  const teaser = await readFile(new URL("../src/landing/AgentCardTeaser.tsx", import.meta.url), "utf8");
  const detail = await readFile(new URL("../src/use-cases/UseCaseDetail.tsx", import.meta.url), "utf8");
  const slug = teaser.match(/findUseCase\("([^"]+)"\)/)?.[1];
  assert.ok(slug, "teaser must look its entry up with findUseCase");
  const item = data.findUseCase(slug);
  assert.ok(item, `teaser slug ${slug} is not a use case, so the landing card would silently vanish`);
  for (const field of ["{item.title}", "{item.summary}", "STATUS_LABEL[item.status]", "/use-cases/${item.slug}", "imageFor(item", "item.cta.href"]) {
    assert.ok(teaser.includes(field), `teaser must render ${field} from the entry`);
  }
  assert.ok(!teaser.includes(item.summary), "teaser must not hardcode the summary");
  assert.match(detail, /findUseCase\(/);
  assert.doesNotMatch(teaser, /Coming next|will work/, "the cards band is live, not a teaser");
  for (const field of ["{item.title}", "{item.summary}", "item.soonNote", "item.liveNote"]) {
    assert.ok(detail.includes(field), `detail page must render ${field} from the entry`);
  }
});

// Audit 2026-10-05 A1, A2, A10: CTAs land somewhere real, and copy claims only what ships.
test("See a receipt opens the real demo receipt, not an empty lookup", async () => {
  const demo = await readFile(new URL("../src/receipts/demoReceipt.ts", import.meta.url), "utf8");
  const pda = demo.match(/DEMO_RECEIPT_PDA = "([1-9A-HJ-NP-Za-km-z]{32,44})"/)?.[1];
  assert.ok(pda, "demo receipt address missing");
  assert.equal(data.RECEIPT.href, `/verify/${pda}`);
  const receipts = data.findUseCase("receipts-for-accounting");
  assert.equal(receipts.cta.href, `/verify/${pda}`);
});

test("receipt copy never says every receipt proves the limits at payment", () => {
  const receipts = data.findUseCase("receipts-for-accounting");
  const text = [...receipts.why, ...receipts.example.flat()].join(" ");
  assert.doesNotMatch(text, /limits that allowed it|limits at payment/i);
});

test("card copy says card records are not payment receipts", () => {
  const card = data.findUseCase("private-agent-card");
  assert.doesNotMatch(card.why.join(" "), /lands as a receipt/i);
  assert.match(card.why.join(" "), /not a Solana payment receipt/);
});

// Tested on Devnet with Crossmint staging on 2026-10-06, but the flags are off: it stays "soon".
test("agent shopping stays Coming soon with a CTA that can't start an order", () => {
  const shopping = data.findUseCase("agent-shopping");
  assert.equal(shopping.status, "soon");
  assert.ok(shopping.soonNote, "agent shopping needs its own soon note");
  assert.match(shopping.soonNote.title, /Coming soon/);
  assert.match(shopping.soonNote.body, /Crossmint staging/);
  assert.match(shopping.soonNote.body, /Devnet/);
  assert.match(shopping.soonNote.body, /no order can start/i);
  assert.doesNotMatch(shopping.soonNote.body, /delivered|arrived/i, "delivery was never proven");
  assert.deepEqual(shopping.example.find(([label]) => label === "Status"), ["Status", "Tested on Devnet · switching on after one more check"]);
  assert.notEqual(shopping.cta.href, "/app");
  assert.match(shopping.cta.label, /spending limit/i);
});
