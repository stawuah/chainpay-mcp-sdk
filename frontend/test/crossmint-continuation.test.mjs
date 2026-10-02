import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({ entryPoints: [new URL("../src/owner/crossmint.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm" });
const { crossmintApprovalContinuation, originalCrossmintOperation } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const args = { orderId: "order", mandate: "mandate", agent: "agent", invoiceHash: "invoice", expectedTerms: "terms" };
const approval = { kind: "payment", action: "crossmint_agent_signature_required", payment: args, continuation: { tool: "execute_crossmint_payment", arguments: { ...args } } };

test("Crossmint wallet approval retains the original connector and reviewed identifiers", () => {
  assert.deepEqual(crossmintApprovalContinuation(approval), approval.continuation);
  assert.equal(crossmintApprovalContinuation({ action: "agent_signature_required" }), undefined);
});
test("missing, downgraded or altered continuation fails before wallet signing", () => {
  assert.throws(() => crossmintApprovalContinuation({ ...approval, continuation: undefined }), /missing/);
  assert.throws(() => crossmintApprovalContinuation({ ...approval, continuation: { ...approval.continuation, tool: "execute_payment" } }), /missing/);
  for (const field of Object.keys(args)) assert.throws(() => crossmintApprovalContinuation({ ...approval, continuation: { ...approval.continuation, arguments: { ...args, [field]: "different" } } }), /no longer matches/);
});
test("reloaded uncertain and failed payments retain their original operation instead of requesting another signature", () => {
  const operation = { id: "original", wallet: "owner", key: "mandate:invoice", kind: "payments", status: "unknown", wire: "original signed bytes" };
  assert.equal(originalCrossmintOperation(approval, [operation], "owner"), operation);
  assert.equal(originalCrossmintOperation(approval, [{ ...operation, status: "failed" }], "owner").id, "original");
  assert.equal(originalCrossmintOperation(approval, [operation], "other-owner"), undefined);
  assert.equal(originalCrossmintOperation(approval, [{ ...operation, status: "failed", result: { error: "Request rejected before submission: stale terms" } }], "owner"), undefined);
});
