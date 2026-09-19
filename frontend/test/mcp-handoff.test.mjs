import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(frontendRoot, "src");

async function compile(relative) {
  const source = await readFile(join(srcRoot, relative), "utf8");
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}

async function loadHandoff() {
  const compiled = await compile("owner/mcpHandoff.ts");
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// mcpHandoff`).toString("base64")}`);
}

test("buildMcpFirstPrompt includes mandate and read-only guardrails", async () => {
  const { buildMcpFirstPrompt, connectionAccessLabel } = await loadHandoff();
  const prompt = buildMcpFirstPrompt({
    agentName: "Invoice agent",
    mandateAddress: "Mandate1111111111111111111111111111111111111",
    mandateLabel: "Research USDC",
    paymentsPermitted: false,
  });
  assert.match(prompt, /Invoice agent/);
  assert.match(prompt, /Mandate1111111111111111111111111111111111111/);
  assert.match(prompt, /Research USDC/);
  assert.match(prompt, /Do not prepare, sign, or submit a payment/);
  assert.match(prompt, /read and prepare/i);
  assert.equal(connectionAccessLabel(false), "Read and prepare");
  assert.equal(connectionAccessLabel(true), "Payments permitted");
});

test("dashboard connect panel exposes finish-card handoff copy", async () => {
  const source = await readFile(join(srcRoot, "dashboard/Dashboard.tsx"), "utf8");
  assert.match(source, /Finish connecting/);
  assert.match(source, /Copy first prompt/);
  assert.match(source, /buildMcpFirstPrompt/);
  assert.match(source, /connection-handoff-scope/);
});
