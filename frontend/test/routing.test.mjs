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

const paths = await load("../src/routing/paths.ts");
const legacy = await load("../src/routing/legacyHash.ts");

test("parses landing, app tabs, mandate builder, and verify paths", () => {
  assert.deepEqual(paths.parsePathname("/"), { kind: "landing" });
  assert.deepEqual(paths.parsePathname("/app"), { kind: "app", tab: "overview" });
  assert.deepEqual(paths.parsePathname("/app/receipts"), { kind: "app", tab: "receipts" });
  assert.deepEqual(paths.parsePathname("/app/mandates/new"), { kind: "app", tab: "mandates", mandateBuilder: true });
  assert.deepEqual(paths.parsePathname("/app/not-a-tab"), { kind: "app", tab: "overview" });
  assert.deepEqual(paths.parsePathname("/verify/abcDEF1234567890abcDEF1234567890ab"), {
    kind: "verify",
    receiptPda: "abcDEF1234567890abcDEF1234567890ab",
  });
});

test("builds canonical paths and keeps tab whitelist", () => {
  assert.equal(paths.buildPath({ kind: "landing" }), "/");
  assert.equal(paths.buildPath({ kind: "app", tab: "overview" }), "/app/overview");
  assert.equal(paths.buildPath({ kind: "app", tab: "mandates", mandateBuilder: true }), "/app/mandates/new");
  assert.equal(paths.buildPath({ kind: "verify", receiptPda: "PdaAddress1111111111111111111111111111" }), "/verify/PdaAddress1111111111111111111111111111");
  for (const tab of paths.DASHBOARD_TABS) assert.equal(paths.isDashboardTab(tab), true);
  assert.equal(paths.isDashboardTab("inbox"), false);
});

test("maps legacy microsite hashes and preserves ordinary anchors", () => {
  assert.equal(legacy.legacyHashTarget("#/aifi"), "/#how-it-works");
  assert.equal(legacy.legacyHashTarget("#/use-cases/treasury-approvals"), "/#how-it-works");
  assert.equal(legacy.legacyHashTarget("#how-it-works"), null);
  assert.equal(legacy.legacyHashTarget("#use-cases"), null);
  const history = { state: null, replaced: "", replaceState(_state, _title, url) { this.replaced = url; } };
  assert.equal(legacy.applyLegacyHashRedirect({ hash: "#/aifi", pathname: "/" }, history), true);
  assert.equal(history.replaced, "/#how-it-works");
  assert.equal(legacy.applyLegacyHashRedirect({ hash: "#activity", pathname: "/" }, history), false);
});
