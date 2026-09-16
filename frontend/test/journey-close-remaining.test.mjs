import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("settlement recovery uses inline operator copy instead of doc dead end", async () => {
  const source = await readFile(new URL("../src/settlement.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /docs\/settlement-recovery\.md/);
  assert.match(source, /Check settlement/);
  assert.match(source, /Cancel only if unstarted/);
});

test("payment flow no longer prepends recipient ATA creation", async () => {
  const dashboard = await readFile(new URL("../src/dashboard/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /RECIPIENT ACCOUNT/);
  assert.doesNotMatch(dashboard, /createInstruction\)\s*\{\s*nextPrepared\.transaction\.instructions\.unshift/);
  assert.match(dashboard, /chunkPreparedTransactions/);
  assert.match(dashboard, /Repair approval/);
  assert.match(dashboard, /saveWalletDrafts/);
});

test("sdk exposes buildApproveDelegate for delegate repair", async () => {
  const client = await readFile(new URL("../../sdk/src/client.ts", import.meta.url), "utf8");
  assert.match(client, /buildApproveDelegate/);
});
