import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("receipt detail routes round-trip", async () => {
  const paths = await load("../src/routing/paths.ts");
  const address = "Receipt1111111111111111111111111111111111111";
  const route = { kind: "app", tab: "receipts", receiptDetail: address };
  assert.equal(paths.buildPath(route), `/app/receipts/${address}`);
  assert.deepEqual(paths.parsePathname(paths.buildPath(route)), route);
  assert.deepEqual(paths.parsePathname("/app/receipts/a/b"), { kind: "app-not-found", path: "/app/receipts/a/b" });
});

test("x402 resume requires payment_id and resumable status", async () => {
  const jobs = await load("../src/spend/x402Display.ts");
  assert.equal(jobs.x402JobResumable({
    x402_payment_id: "x402-1",
    resource: "https://api.example",
    status: "confirmed",
    protocol: "chainpay_custom_x402",
    payable: true,
    payment_id: "payment_abc",
    created_at_ms: 1,
    updated_at_ms: 2,
  }), true);
  assert.equal(jobs.x402JobResumable({
    x402_payment_id: "x402-2",
    resource: "https://api.example",
    status: "verified",
    protocol: "chainpay_custom_x402",
    payable: true,
    payment_id: "payment_abc",
    created_at_ms: 1,
    updated_at_ms: 2,
  }), false);
  assert.equal(jobs.x402JobResumable({
    x402_payment_id: "x402-3",
    resource: "https://api.example",
    status: "submitted",
    protocol: "chainpay_custom_x402",
    payable: true,
    created_at_ms: 1,
    updated_at_ms: 2,
  }), false);
});

test("dashboard wiring includes J4b CRUD surfaces", async () => {
  const dashboard = await readFile(new URL("../src/dashboard/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /EDIT LIMITS/);
  assert.match(dashboard, /non-revoked mandate/);
  assert.match(dashboard, /isDisabled=\{!connectionToken\}/);
  assert.match(dashboard, /Register mint/);
  assert.match(dashboard, /receiptDetail/);
  assert.match(dashboard, /x402JobResumable|onCallMcp=\{onCallMcp\}/);
  assert.match(dashboard, /status !== "revoked"/);
});

test("resume clears the pause flag; every other update preserves it", async () => {
  const { pausedAfterMandateAction: pausedAfter } = await load("../src/owner/mandateAction.ts");

  // Resume is only ever offered on a paused mandate. It shares the update_mandate
  // instruction with "update", and the program assigns paused unconditionally, so
  // sending paused: true here would re-pause the mandate the owner just resumed.
  assert.equal(pausedAfter("resume", "paused"), false);

  // Editing limits must not silently resume a paused mandate.
  assert.equal(pausedAfter("update", "paused"), true);
  assert.equal(pausedAfter("update", "active"), false);
});

test("mandate update action is part of runtime types", async () => {
  const runtime = await readFile(new URL("../src/owner/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /"update"/);
  assert.match(runtime, /MandateUpdateFields/);
});
