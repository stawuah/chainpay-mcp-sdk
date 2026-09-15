import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadModule(t, relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("custom x402/1.0 challenges are payable with exact amount strings", async () => {
  const jobs = await loadModule({}, "../src/spend/x402Display.ts");
  const summary = jobs.summarizeX402Challenge({
    version: "x402/1.0",
    amount: "10000",
    resource: "https://api.example/resource",
  });
  assert.equal(summary.protocol, "chainpay_custom_x402");
  assert.equal(summary.payable, true);
  assert.equal(summary.amount, "10000");
});

test("standard x402 v2 and MPP stay visible but blocked", async () => {
  const jobs = await loadModule({}, "../src/spend/x402Display.ts");
  const v2 = jobs.summarizeX402Challenge({
    x402Version: 2,
    accepts: [{ maxAmountRequired: "2500000" }],
  });
  assert.equal(v2.protocol, "standard_x402_v2");
  assert.equal(v2.payable, false);
  assert.equal(v2.amount, "2500000");
  assert.equal(v2.blockedReason, "x402_unsupported_sponsor");

  const mpp = jobs.summarizeX402Challenge({ version: "mpp" });
  assert.equal(mpp.protocol, "mpp");
  assert.equal(mpp.payable, false);
});

test("verified jobs expose receipt cycle steps", async () => {
  const jobs = await loadModule({}, "../src/spend/x402Display.ts");
  const steps = jobs.x402CycleSteps({
    x402_payment_id: "job-1",
    resource: "https://api.example",
    status: "verified",
    protocol: "chainpay_custom_x402",
    payable: true,
    created_at_ms: 1,
    updated_at_ms: 2,
  });
  assert.ok(steps.includes("Done"));
});

test("catalog quotes stay labeled estimates", async () => {
  const catalog = await loadModule({}, "../src/spend/payshQuote.ts");
  const quote = catalog.catalogQuoteForProvider({
    fqn: "exa/search",
    title: "Exa",
    min_price_usd: 0,
    max_price_usd: 0.007,
  });
  assert.equal(quote.estimateAmount, "0.007");
  assert.match(quote.label, /pay\.sh estimate/);
  assert.equal(quote.estimateOnly, true);
});
