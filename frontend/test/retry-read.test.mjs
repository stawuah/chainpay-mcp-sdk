import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { retryRead } = await load("../src/owner/retryRead.ts");
const noWait = { wait: async () => {} };

test("a read that succeeds first time is not repeated", async () => {
  let calls = 0;
  const value = await retryRead(async () => { calls += 1; return 7n; }, noWait);
  assert.equal(value, 7n);
  assert.equal(calls, 1);
});

test("a read that fails while the relay is cold succeeds on a later attempt", async () => {
  let calls = 0;
  const value = await retryRead(async () => {
    calls += 1;
    if (calls < 3) throw new Error("Failed to fetch");
    return 499858623n;
  }, noWait);
  assert.equal(value, 499858623n);
  assert.equal(calls, 3);
});

test("a null result retries, because an empty read is not an answer", async () => {
  let calls = 0;
  const value = await retryRead(async () => { calls += 1; return calls < 2 ? null : "sample"; }, noWait);
  assert.equal(value, "sample");
  assert.equal(calls, 2);
});

test("a read that never succeeds resolves null so callers keep their unavailable state", async () => {
  let calls = 0;
  const value = await retryRead(async () => { calls += 1; throw new Error("Failed to fetch"); }, noWait);
  assert.equal(value, null);
  assert.equal(calls, 4);
});

test("an unmounted component stops retrying", async () => {
  let calls = 0;
  const value = await retryRead(async () => { calls += 1; throw new Error("Failed to fetch"); }, {
    ...noWait,
    cancelled: () => calls >= 2,
  });
  assert.equal(value, null);
  assert.equal(calls, 2);
});

test("backoff grows so a cold relay is outlasted without hammering it", async () => {
  const waited = [];
  await retryRead(async () => null, { wait: async (ms) => { waited.push(ms); } });
  assert.deepEqual(waited, [500, 1000, 2000]);
});
