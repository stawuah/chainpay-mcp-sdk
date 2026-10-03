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
