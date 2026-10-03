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
  assert.deepEqual(paths.parsePathname("/embed/overview"), { kind: "embed-overview", owner: "" });
  assert.deepEqual(paths.parsePathname("/embed/overview/Owner1111111111111111111111111111111111111"), {
    kind: "embed-overview",
    owner: "Owner1111111111111111111111111111111111111",
  });
});

test("builds canonical paths and keeps tab whitelist", () => {
  assert.equal(paths.buildPath({ kind: "landing" }), "/");
  assert.equal(paths.buildPath({ kind: "app", tab: "overview" }), "/app/overview");
  assert.equal(paths.buildPath({ kind: "app", tab: "mandates", mandateBuilder: true }), "/app/mandates/new");
  assert.equal(paths.buildPath({ kind: "verify", receiptPda: "PdaAddress1111111111111111111111111111" }), "/verify/PdaAddress1111111111111111111111111111");
  assert.equal(paths.buildPath({ kind: "embed-overview", owner: "Owner1111111111111111111111111111111111111" }), "/embed/overview/Owner1111111111111111111111111111111111111");
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

test("parses and builds use case paths", () => {
  assert.deepEqual(paths.parsePathname("/use-cases"), { kind: "use-cases" });
  assert.deepEqual(paths.parsePathname("/use-cases/"), { kind: "use-cases" });
  assert.deepEqual(paths.parsePathname("/use-cases/sponsor-funds-your-agent"), { kind: "use-case", slug: "sponsor-funds-your-agent" });
  assert.deepEqual(paths.parsePathname("/use-cases/a/b"), { kind: "public-not-found", path: "/use-cases/a/b" });
  assert.deepEqual(paths.parsePathname("/use-cases/Upper"), { kind: "public-not-found", path: "/use-cases/Upper" });
  assert.equal(paths.buildPath({ kind: "use-cases" }), "/use-cases");
  assert.equal(paths.buildPath({ kind: "use-case", slug: "one-tap-stop" }), "/use-cases/one-tap-stop");
});

test("card routes: list, new (draft intake), detail sections, and the public card check", () => {
  const id = "ab".repeat(32);
  assert.deepEqual(paths.parsePathname("/app/cards"), { kind: "app", tab: "cards" });
  assert.deepEqual(paths.parsePathname("/app/cards/new"), { kind: "app", tab: "cards", cardsNew: true });
  assert.deepEqual(paths.parsePathname(`/app/cards/${id}`), { kind: "app", tab: "cards", cardId: id });
  for (const section of paths.CARD_SECTIONS) {
    const route = paths.parsePathname(`/app/cards/${id}/${section}`);
    assert.deepEqual(route, { kind: "app", tab: "cards", cardId: id, cardSection: section });
    assert.equal(paths.parsePathname(paths.buildPath(route)).cardId, id);
  }
  assert.equal(paths.buildPath({ kind: "app", tab: "cards", cardId: id, cardSection: "activity" }), `/app/cards/${id}`);
  assert.equal(paths.buildPath({ kind: "app", tab: "cards", cardId: id, cardSection: "privacy" }), `/app/cards/${id}/privacy`);
  assert.equal(paths.buildPath({ kind: "app", tab: "cards", cardsNew: true }), "/app/cards/new");
  assert.equal(paths.buildPath({ kind: "app", tab: "cards" }), "/app/cards");
  for (const bad of ["/app/cards/XYZ", `/app/cards/${id}/nope`, `/app/cards/${id}/privacy/extra`, `/app/cards/${id.toUpperCase()}`]) {
    assert.equal(paths.parsePathname(bad).kind, "app-not-found", bad);
  }
  assert.deepEqual(paths.parsePathname("/verify/card"), { kind: "verify-card" });
  assert.equal(paths.buildPath({ kind: "verify-card" }), "/verify/card");
});
