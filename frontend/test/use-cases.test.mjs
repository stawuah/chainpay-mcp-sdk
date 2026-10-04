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
    const lines = [item.title, item.summary, ...item.steps, ...item.why, item.soonNote?.title, item.soonNote?.body].filter(Boolean);
    for (const line of lines) {
      for (const phrase of BANNED) assert.doesNotMatch(line, phrase, `${item.slug}: "${line}"`);
    }
  }
});

test("the agent card entry is honest about privacy, testing and its own limits", () => {
  const card = data.findUseCase("private-agent-card");
  assert.ok(card, "private-agent-card entry missing");
  assert.equal(card.status, "soon");
  assert.match(card.summary, /virtual card/i);
  assert.match(card.summary, /testing/i);
  assert.match(card.summary, /sandbox/i);
  assert.match(card.why.join(" "), /public chain/i);
  assert.match(card.why.join(" "), /issuer/i, "say who else can see card limits");
  assert.ok(card.soonNote, "card needs its own soon note");
  // Card limits are set on the card; a spending permission is a different thing.
  assert.doesNotMatch(card.soonNote.body, /limits (your agent|it) will use/i);
  assert.match(card.soonNote.body, /spending permission/i);
});

test("the landing teaser and the use-case page read the same entry", async () => {
  const teaser = await readFile(new URL("../src/landing/AgentCardTeaser.tsx", import.meta.url), "utf8");
  const detail = await readFile(new URL("../src/use-cases/UseCaseDetail.tsx", import.meta.url), "utf8");
  const slug = teaser.match(/findUseCase\("([^"]+)"\)/)?.[1];
  assert.ok(slug, "teaser must look its entry up with findUseCase");
  const item = data.findUseCase(slug);
  assert.ok(item, `teaser slug ${slug} is not a use case, so the landing card would silently vanish`);
  for (const field of ["{item.title}", "{item.summary}", "STATUS_LABEL[item.status]", "/use-cases/${item.slug}", "imageFor(item"]) {
    assert.ok(teaser.includes(field), `teaser must render ${field} from the entry`);
  }
  assert.ok(!teaser.includes(item.summary), "teaser must not hardcode the summary");
  assert.match(detail, /findUseCase\(/);
  for (const field of ["{item.title}", "{item.summary}", "item.soonNote"]) {
    assert.ok(detail.includes(field), `detail page must render ${field} from the entry`);
  }
});
