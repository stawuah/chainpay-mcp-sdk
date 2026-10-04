import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";

// pet-prefs imports React only for its hook; stub it so the module loads alone.
const source = (await readFile(new URL("../src/pet-prefs.ts", import.meta.url), "utf8")).replace(
  /import \{ useSyncExternalStore \} from "react";/,
  "const useSyncExternalStore = () => undefined;",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

async function fresh(seed) {
  const storage = fakeStorage(seed);
  globalThis.window = { localStorage: storage, addEventListener() {}, removeEventListener() {} };
  const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n//${Math.random()}`).toString("base64")}`);
  return { mod, storage };
}

test("Bam Bam is on for public pages and off in the dashboard by default", async () => {
  const { mod } = await fresh();
  assert.equal(mod.getPetEnabled("landing"), true);
  assert.equal(mod.getPetEnabled("app"), false);
  assert.equal(mod.surfaceFor("app"), "app");
  assert.equal(mod.surfaceFor("landing"), "landing");
  assert.equal(mod.surfaceFor("verify"), "landing");
});

test("each surface remembers its own choice", async () => {
  const { mod, storage } = await fresh();
  mod.setPetEnabled("app", true);
  mod.setPetEnabled("landing", false);
  assert.equal(storage.getItem("chainpay.pet.on.app"), "1");
  assert.equal(storage.getItem("chainpay.pet.on.landing"), "0");
  assert.equal(mod.getPetEnabled("app"), true);
  assert.equal(mod.getPetEnabled("landing"), false);
});

test("an old Hide carries over as off everywhere, once", async () => {
  const { mod, storage } = await fresh({ "chainpay.pet.hidden": "1" });
  assert.equal(mod.getPetEnabled("landing"), false);
  assert.equal(mod.getPetEnabled("app"), false);
  assert.equal(storage.getItem("chainpay.pet.hidden"), null);
  mod.setPetEnabled("landing", true);
  assert.equal(mod.getPetEnabled("landing"), true);
});

test("without storage it still works in memory", async () => {
  globalThis.window = {
    get localStorage() {
      throw new Error("blocked");
    },
  };
  const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n//${Math.random()}`).toString("base64")}`);
  assert.equal(mod.getPetEnabled("app"), false);
  mod.setPetEnabled("app", true);
  assert.equal(mod.getPetEnabled("app"), true);
});
