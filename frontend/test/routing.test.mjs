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
  assert.deepEqual(paths.parsePathname("/app/receipts"), { kind: "app", tab: "payments" });
  assert.deepEqual(paths.parsePathname("/app/receipts/Receipt1111111111111111111111111111111111111"), {
    kind: "app",
    tab: "receipts",
    receiptDetail: "Receipt1111111111111111111111111111111111111",
  });
  assert.deepEqual(paths.parsePathname("/app/mandates/new"), { kind: "app", tab: "mandates", mandateBuilder: true });
  assert.deepEqual(paths.parsePathname("/app/not-a-tab"), { kind: "app-not-found", path: "/app/not-a-tab" });
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

test("permission details round-trip without changing legacy routes", () => {
  const address = "PdaAddress1111111111111111111111111111";
  const route = { kind: "app", tab: "mandates", mandateDetail: address };
  assert.equal(paths.buildPath(route), `/app/mandates/${address}`);
  assert.deepEqual(paths.parsePathname(paths.buildPath(route)), route);
  assert.deepEqual(paths.parsePathname("/app/mandates/new"), { kind: "app", tab: "mandates", mandateBuilder: true });
  assert.deepEqual(paths.parsePathname("/app/mandates/a/b"), { kind: "app-not-found", path: "/app/mandates/a/b" });
  assert.deepEqual(paths.parsePathname("/unknown-page"), { kind: "public-not-found", path: "/unknown-page" });
  assert.deepEqual(paths.parsePathname("/app/mandates/%ZZ"), { kind: "app", tab: "mandates", mandateDetail: "%ZZ" });
  assert.deepEqual(paths.parsePathname("/app/mandates/a%2Fb"), { kind: "app", tab: "mandates", mandateDetail: "a/b" });
});

test("owner destinations canonicalize legacy and advanced routes", () => {
 for (const [legacyPath, canonical] of [["/app/assistant", "/app/requests"], ["/app/tools", "/app/settings/advanced/tools"], ["/app/protocol", "/app/settings/advanced/protocol"], ["/app/receipts", "/app/payments"]]) {
   const route = paths.parsePathname(legacyPath);
   assert.equal(paths.buildPath(route), canonical);
   assert.deepEqual(paths.parsePathname(canonical), route);
 }
});
