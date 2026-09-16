import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

async function loadModule(entryPoint) {
  const outfile = join(frontendRoot, `test/.tmp-${entryPoint.replace(/\//g, "-")}.mjs`);
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await unlink(outfile).catch(() => {});
  return module;
}

test("recent activity dedupes inbox and settlement history by receipt PDA", async () => {
  const { buildRecentActivity } = await loadModule("src/owner/recentActivity.ts");
  const receipt = "Receipt1111111111111111111111111111111111111";
  const rows = buildRecentActivity([
    {
      id: "inbox-1",
      createdAt: "2026-09-15T12:00:00.000Z",
      source: "invoice",
      title: "Vendor invoice",
      prompt: "pay invoice",
      response: "ready",
      stage: "receipt_ready",
      toolCalls: [],
      attachments: [],
      outcome: { kind: "payment_settled", receiptAddress: receipt, status: "confirmed" },
    },
  ], [
    {
      id: "payment_abc",
      key: "k1",
      kind: "payments",
      wallet: "Wallet1111111111111111111111111111111111111",
      backend: "https://backend.example",
      status: "confirmed",
      result: { status: "confirmed", receipt_address: receipt },
    },
    {
      id: "payment_def",
      key: "k2",
      kind: "payments",
      wallet: "Wallet1111111111111111111111111111111111111",
      backend: "https://backend.example",
      status: "confirmed",
      result: { status: "confirmed", receipt_address: "Receipt2222222222222222222222222222222222222" },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.some((row) => row.receiptAddress === receipt), true);
  assert.equal(rows.some((row) => row.receiptAddress === "Receipt2222222222222222222222222222222222222"), true);
});

test("blocked prepare results map to blocked inbox stage before approval", async () => {
  const runtime = await readFile(join(frontendRoot, "src/owner/runtime.ts"), "utf8");
  const blockedIndex = runtime.indexOf('if (result.outcome?.kind === "payment_blocked"');
  const approvalIndex = runtime.indexOf("if (result.approval) return \"waiting_for_approval\"");
  assert.ok(blockedIndex >= 0);
  assert.ok(approvalIndex >= 0);
  assert.ok(blockedIndex < approvalIndex);
});

test("batch ask AI opens Requests tab from dashboard wiring", async () => {
  const dashboard = await readFile(join(frontendRoot, "src/dashboard/Dashboard.tsx"), "utf8");
  assert.match(dashboard, /onAskAgent=\{\(message\) => \{ selectTab\("assistant"\); void askChainPay\(message\); \}\}/);
  assert.match(dashboard, /<X402JobsPanel sessionReady=\{sessionReady\} onSignIn=\{onSignIn\} onCallMcp=\{onCallMcp\} \/>/);
  assert.match(await readFile(join(frontendRoot, "src/dashboard/OwnerOverview.tsx"), "utf8"), /Recent activity/);
});
