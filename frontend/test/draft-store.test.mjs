import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadDraftStore() {
  const source = await readFile(new URL("../src/wallet/draftStore.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("wallet-scoped drafts round-trip without cross-wallet leakage", async () => {
  const store = await loadDraftStore();
  store.resetDraftStoreForTests();
  store.saveWalletDrafts("wallet-a", {
    payment: { invoice: "inv-a", amount: "1", recipient: "recipient-a" },
    assistant: { prompt: "prompt-a", reply: "reply-a", history: [], attachments: [] },
  });
  store.saveWalletDrafts("wallet-b", {
    payment: { invoice: "inv-b", amount: "2", recipient: "recipient-b" },
  });
  assert.deepEqual(store.loadWalletDrafts("wallet-a").payment, {
    invoice: "inv-a",
    amount: "1",
    recipient: "recipient-a",
  });
  assert.deepEqual(store.loadWalletDrafts("wallet-b").payment, {
    invoice: "inv-b",
    amount: "2",
    recipient: "recipient-b",
  });
  assert.equal(store.loadWalletDrafts("wallet-a").assistant?.prompt, "prompt-a");
  assert.equal(store.loadWalletDrafts("wallet-b").assistant, undefined);
});
