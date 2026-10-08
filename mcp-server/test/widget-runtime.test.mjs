import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { paymentWidgetHtml } from "../dist/widget/resource.js";

function runtime(callTool, options = {}) {
  const listeners = new Map();
  const timers = new Map();
  const requests = [];
  let clock = 0;
  let timerId = 0;
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
  const window = { __CHAINPAY_WIDGET_PREVIEW__: !options.start, addEventListener: (event, fn) => listeners.set(event, fn), ...(options.publicPage ? {} : { openai: { callTool } }), ...(options.flow ? { __CHAINPAY_FLOW__: { view: options.flow, statusUrl: `/pay/${options.flow.flowId}/status` } } : {}) };
  window.parent = window;
  const context = vm.createContext({
    window, document: { getElementById: (id) => id === "root" ? root : {}, documentElement: { getBoundingClientRect: () => ({ height: 400 }), scrollWidth: 400 } },
    navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, due: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Date: class extends Date { static now() { return clock; } },
    AbortController,
    fetch(url, init) { return new Promise((resolve) => { requests.push({ url, init, resolve }); }); },
    console,
  });
  const script = paymentWidgetHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  return {
    root,
    requests,
    apply(view) { context.view = view; vm.runInContext("apply(view)", context); },
    result(view) { context.view = view; vm.runInContext("fromResult({ structuredContent: { widget: view } })", context); },
    model() { return vm.runInContext("model", context); },
    async respond(index, view, updatedAt = clock) {
      requests[index].resolve({ status: 200, ok: true, json: async () => ({ view, updatedAt }) });
      await new Promise(setImmediate);
    },
    async advance(ms) {
      const end = clock + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        timers.delete(next[0]);
        clock = next[1].due;
        next[1].fn();
        await new Promise(setImmediate);
      }
      clock = end;
    },
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

const flow = { version: 1, flowId: "AAAAAAAAAAAAAAAAAAAAAA", flowUrl: "https://card.test/pay/AAAAAAAAAAAAAAAAAAAAAA", state: "paying", currentStep: 0, amount: "10", symbol: "USDC", cluster: "Solana Devnet" };

for (const state of ["signature", "unknown"]) {
  test(`public page keeps watching ${state} until settlement`, async () => {
    const page = runtime(undefined, { start: true, publicPage: true, flow });
    assert.match(page.root.innerHTML, /Payment prepared/);
    assert.equal(page.requests[0].url, `/pay/${flow.flowId}/status`);
    await page.respond(0, { ...flow, state }, 1);
    await page.advance(1000);
    assert.equal(page.model().state, state);
    assert.equal(page.requests.length, 2);
    await page.respond(1, { ...flow, ...settled, receipt: "receipt-one" }, 2);
    await page.advance(3200);
    assert.equal(page.model().state, "settled");
    assert.match(page.root.innerHTML, /Payment complete/);
    assert.equal(page.requests.length, 2, "terminal result stops public polling");
  });
}

test("replacing a flow cancels its fetch and reveal timer and watches the replacement", async () => {
  const page = runtime(undefined, { start: true, publicPage: true, flow });
  const replacement = { ...flow, flowId: "BBBBBBBBBBBBBBBBBBBBBB", flowUrl: "https://card.test/pay/BBBBBBBBBBBBBBBBBBBBBB", amount: "25" };
  page.result(replacement);
  assert.equal(page.requests[0].init.signal.aborted, true);
  assert.equal(page.requests[1].url, `${replacement.flowUrl}/status`);
  await page.respond(0, { ...flow, ...settled }, 100);
  await page.advance(800);
  assert.equal(page.model().flowId, replacement.flowId);
  assert.equal(page.model().amount, "25");
  assert.equal(page.model().currentStep, 0);
});

test("a non-flow quote survives old flow fetches and scheduled reveals", async () => {
  const page = runtime(undefined, { start: true, publicPage: true, flow });
  await page.respond(0, { ...flow, state: "confirming", currentStep: 4 }, 1);
  await page.advance(1000);
  assert.equal(page.requests.length, 2);
  page.result({ version: 1, state: "ready", checks: [], amount: "25", symbol: "USDC" });
  assert.equal(page.requests[1].init.signal.aborted, true);
  await page.respond(1, { ...flow, ...settled }, 2);
  await page.advance(4000);
  assert.equal(page.model().state, "ready");
  assert.equal(page.model().flowId, undefined);
  assert.equal(page.model().amount, "25");
});

test("unversioned tool evidence updates timestamped status without replaying settled animation", async () => {
  const page = runtime(undefined, { start: true, publicPage: true, flow });
  await page.respond(0, { ...flow, state: "confirming", currentStep: 4 }, 100);
  page.result({ ...flow, ...settled });
  await page.advance(3200);
  assert.equal(page.model().state, "settled", "tool result is accepted without updatedAt");
  page.result({ ...flow, ...settled, product: "Updated description" });
  assert.equal(page.model().state, "settled", "repeated terminal results never restart progress");
  assert.equal(page.model().product, "Updated description");
  await page.respond(1, { ...flow, state: "confirming", currentStep: 4 }, 101);
  await page.advance(800);
  assert.equal(page.model().state, "settled", "late pending response cannot undo terminal evidence");
});

test("embedded live cards watch public status without calling payment tools", async () => {
  const calls = [];
  const page = runtime((...args) => { calls.push(args); }, { start: true });
  page.result({ ...flow, state: "confirming", currentStep: 4, paymentId: "p1" });
  await page.respond(0, { ...flow, state: "confirming", currentStep: 4, paymentId: "p1" }, 1);
  await page.advance(2000);
  assert.deepEqual(calls, []);
  assert.equal(page.requests.length, 2);
});
