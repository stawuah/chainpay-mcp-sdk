import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("revoke-all chunking helper uses the shared 1100-byte guard", async () => {
  const chunks = await readFile(new URL("../src/wallet/transactionChunks.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../src/dashboard/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(chunks, /DEFAULT_TX_SIZE_LIMIT = 1_100/);
  assert.match(chunks, /chunkPreparedTransactions/);
  assert.match(dashboard, /chunkPreparedTransactions\(/);
  assert.match(dashboard, /revoke-all:\$\{wallet\}:\$\{index\}/);
});
