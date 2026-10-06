import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseFrames, reportedOutcome, settlementsIn, settlesAttempt, vaultAccounts, waitForSettlement } from "./private-settlement.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../backend/src/connectors/card_issuer/testdata/${name}`, import.meta.url), "utf8"));
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PARTNER = "3burs6CNFvrQW8US2C5W84do8J1EezWsQfsoBAvHF5q6";
// The live Devnet settlement the relay's tests pin (10.05 USDC, ref 145170267661).
const attempt = { mint: USDC, recipientTokenAccount: PARTNER, clientRefId: "145170267661", amountBaseUnits: "10050000" };

test("vault derivation matches Devnet (same as the relay)", () => {
  assert.deepEqual(vaultAccounts(USDC), {
    vault: "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG",
    vaultTokenAccount: "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r",
  });
});

test("the live settlement settles its attempt and nothing else", () => {
  const tx = fixture("magicblock_settlement_live_exact.json");
  assert.deepEqual(settlementsIn(tx).map((s) => [s.clientRefId, s.amount, s.mint]), [["145170267661", "10050000", USDC]]);
  assert.equal(settlesAttempt(tx, attempt), true);
  assert.equal(settlesAttempt(tx, { ...attempt, amountBaseUnits: "10050001" }), false);
  assert.equal(settlesAttempt(tx, { ...attempt, clientRefId: "145170267662" }), false);
  assert.equal(settlesAttempt(tx, { ...attempt, recipientTokenAccount: "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r" }), false);
  assert.equal(settlesAttempt(tx, { ...attempt, mint: "So11111111111111111111111111111111111111112" }), false);
});

test("a wrong-amount settlement does not settle the attempt", () => {
  const tx = fixture("magicblock_settlement_live_wrong_amount.json");
  const ref = settlementsIn(tx)[0].clientRefId;
  assert.equal(settlesAttempt(tx, { ...attempt, clientRefId: ref }), false);
  assert.equal(settlesAttempt(tx, { ...attempt, clientRefId: ref, amountBaseUnits: "500000" }), true);
});

test("failed, truncated or forged-log transactions are never evidence", () => {
  const tx = fixture("magicblock_settlement_live_exact.json");
  assert.equal(settlesAttempt({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, "Custom"] } } }, attempt), false);
  const truncated = structuredClone(tx);
  truncated.meta.logMessages.splice(8, 0, "Log truncated");
  assert.equal(settlesAttempt(truncated, attempt), false);
  // The reference printed by another program's frame does not count.
  const forged = structuredClone(tx);
  forged.meta.logMessages = forged.meta.logMessages.filter((l) => !l.startsWith("Program log: client_ref_id"));
  const noop = forged.meta.logMessages.findIndex((l) => l.startsWith("Program noopb9"));
  forged.meta.logMessages.splice(noop + 1, 0, "Program log: client_ref_id: 145170267661");
  assert.equal(settlesAttempt(forged, attempt), false);
  assert.equal(parseFrames(["Program A invoke [1]"]), null, "unbalanced");
});

test("waiting finds the settlement in finalized history; outcome reports it", async () => {
  const tx = fixture("magicblock_settlement_live_exact.json");
  let lists = 0;
  const connection = {
    async getSignaturesForAddress(_account, _opts, commitment) {
      assert.equal(commitment, "finalized");
      lists += 1;
      return lists === 1 ? [] : [{ signature: "other", slot: 1, err: null }, { signature: "settle", slot: 2, err: null }];
    },
    async getParsedTransaction(signature) {
      return signature === "settle" ? tx : { meta: { err: null, logMessages: [], innerInstructions: [] } };
    },
  };
  const found = await waitForSettlement(connection, attempt, { timeoutMs: 1_000, intervalMs: 1, sleep: async () => {} });
  assert.deepEqual(found, { signature: "settle", slot: 2, commitment: "finalized" });
  assert.equal(reportedOutcome("unknown", found), "settled");
  assert.equal(reportedOutcome("sent", found), "settled");
  assert.equal(reportedOutcome("sent", null), "sent");
  assert.equal(reportedOutcome("unknown", null), "unknown");
});

test("waiting gives up with null when nothing settles", async () => {
  const connection = { getSignaturesForAddress: async () => [], getParsedTransaction: async () => null };
  assert.equal(await waitForSettlement(connection, attempt, { timeoutMs: 5, intervalMs: 10, sleep: async () => {} }), null);
});
