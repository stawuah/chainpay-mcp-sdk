import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { paymentWidgetHtml } from "../dist/widget/resource.js";

function runtime(callTool) {
  const listeners = new Map();
  let copied;
  let copyClick;
  const button = { dataset: {}, textContent: "Copy transaction", addEventListener: (_event, fn) => { copyClick = fn; } };
  const root = {
    innerHTML: "", addEventListener() {},
    querySelectorAll() {
      const value = /data-copy="([^"]*)"/.exec(this.innerHTML)?.[1];
      if (!value) return [];
      button.dataset.copy = value;
      return [button];
    },
  };
  const window = { __CHAINPAY_WIDGET_PREVIEW__: true, addEventListener: (event, fn) => listeners.set(event, fn), openai: { callTool } };
  window.parent = window;
  const context = vm.createContext({
    window, document: { getElementById: (id) => id === "root" ? root : {}, documentElement: { getBoundingClientRect: () => ({ height: 400 }), scrollWidth: 400 } },
    navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    setTimeout() {}, console,
  });
  const script = paymentWidgetHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  return {
    root,
    apply(view) { context.view = view; vm.runInContext("apply(view)", context); },
    model() { return vm.runInContext("model", context); },
    async copy() { await copyClick(); return copied; },
  };
}

const settled = { version: 1, state: "settled", paymentId: "p1", amount: "10", symbol: "USDC", signature: "actual-signature", txShort: "actu…ture" };

test("Copy transaction copies the signature returned by the payment tool", async () => {
  const page = runtime();
  page.apply(settled);
  assert.equal(await page.copy(), "actual-signature");
});

test("a new quote discards the previous payment's signature and evidence", () => {
  const page = runtime();
  page.apply({ ...settled, merchant: "First merchant", rejectedBeforeBroadcast: true });
  page.apply({ version: 1, state: "ready", checks: [], amount: "25", symbol: "USDC" });
  assert.equal(page.model().signature, undefined);
  assert.equal(page.model().merchant, undefined);
  assert.equal(page.model().paymentId, undefined);
  assert.equal(page.model().rejectedBeforeBroadcast, undefined);
});

test("same-payment updates preserve descriptions but discard stale financial fields", () => {
  const page = runtime();
  page.apply({ ...settled, merchant: "Merchant", product: "Report", limits: { remaining: "20" } });
  page.apply({ version: 1, state: "settled", paymentId: "p1", signature: "actual-signature" });
  assert.equal(page.model().merchant, "Merchant");
  assert.equal(page.model().product, "Report");
  assert.equal(page.model().limits, undefined);
});

test("a late polling result cannot overwrite a newer card", async () => {
  let resolve;
  const page = runtime(() => new Promise((r) => { resolve = r; }));
  page.apply({ version: 1, state: "confirming", paymentId: "p1", currentStep: 4 });
  page.apply({ version: 1, state: "ready", checks: [], amount: "25", symbol: "USDC" });
  resolve({ structuredContent: { widget: settled } });
  await new Promise(setImmediate);
  assert.equal(page.model().state, "ready");
  assert.equal(page.model().amount, "25");
});
