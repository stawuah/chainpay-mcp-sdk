import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

let moduleId = 0;
async function fixture(t, { signMessage = async () => new Uint8Array(64), onLogin } = {}) {
  const source = await readFile(new URL("../src/session.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const session = await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// ${moduleId++}`).toString("base64")}`);
  const original = { fetch: globalThis.fetch, location: globalThis.location };
  globalThis.location = { href: "https://chainpay.example/app" };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/challenge")) {
      assert.equal(init.method, "POST", "same-origin login uses POST so the browser sends Origin");
      return Response.json({ challenge_id: "fixture", message: "Fixture wallet login; no payment" });
    }
    if (String(url).endsWith("/session") && init.method === "POST") {
      if (onLogin) await onLogin();
      return Response.json({ token: "fixture-token", wallet: "owner-a", expires_at_ms: Date.now() + 60000 });
    }
    return Response.json({ ok: true });
  };
  t.after(() => Object.assign(globalThis, original));
  session.configureSession("https://chainpay.example", "https://mcp.example/mcp");
  session.setSessionWallet({ address: "owner-a", signMessage });
  return { ...session, calls };
}

test("concurrent private requests share a login and carry the owner credential", async t => {
  let signatures = 0;
  const f = await fixture(t, { signMessage: async () => { signatures++; return new Uint8Array(64); } });
  await Promise.all([f.authorizedFetch("https://mcp.example/inbox"), f.authorizedFetch("https://chainpay.example/v1/payments/fixture")]);
  assert.equal(signatures, 1);
  assert.equal(f.calls.filter(c => c.url.includes("/challenge")).length, 1);
  for (const call of f.calls.filter(c => c.url.includes("/inbox") || c.url.includes("/payments/"))) {
    assert.equal(call.init.headers.get("Authorization"), "Bearer fixture-token");
  }
  await assert.rejects(f.authorizedFetch("https://untrusted.example/private"), /another service/);
  assert.equal(f.calls.some(c => c.url.includes("untrusted")), false);
  f.setSessionWallet(null);
  assert.equal(f.calls.at(-1).init.method, "DELETE");
});

test("rejected login never sends a private request and can be retried", async t => {
  let reject = true;
  const f = await fixture(t, { signMessage: async () => { if (reject) throw new Error("Declined"); return new Uint8Array(64); } });
  await assert.rejects(f.authorizedFetch("https://mcp.example/inbox"), /Declined/);
  assert.equal(f.calls.some(c => c.url.endsWith("/inbox")), false);
  reject = false;
  assert.equal((await f.authorizedFetch("https://mcp.example/inbox")).status, 200);
});

test("wallet switch during login revokes the late session and sends no private request", async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { onLogin: async () => { entered(); await hold; } });
  const request = f.authorizedFetch("https://mcp.example/inbox");
  await started;
  f.setSessionWallet({ address: "owner-b", signMessage: async () => new Uint8Array(64) });
  release();
  await assert.rejects(request, /Wallet changed/);
  assert.equal(f.calls.at(-1).init.method, "DELETE");
  assert.equal(f.calls.at(-1).init.headers.Authorization, "Bearer fixture-token");
  assert.equal(f.calls.some(c => c.url.endsWith("/inbox")), false);
});

test("expired credentials require a fresh login; a 401 is not silently retried", async t => {
  const f = await fixture(t);
  await f.authorizedFetch("https://mcp.example/inbox");
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).endsWith("/inbox") ? new Response("{}", { status: 401 }) : previous(url, init);
  assert.equal((await f.authorizedFetch("https://mcp.example/inbox")).status, 401);
  assert.equal(f.calls.filter(c => c.url.includes("/challenge")).length, 1);
  globalThis.fetch = previous;
  await f.authorizedFetch("https://mcp.example/inbox");
  assert.equal(f.calls.filter(c => c.url.includes("/challenge")).length, 2);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 120000;
  t.after(() => { Date.now = originalNow; });
  await f.authorizedFetch("https://mcp.example/inbox");
  assert.equal(f.calls.filter(c => c.url.includes("/challenge")).length, 3);
});

test("passive workspace refresh never signs in or retries a canceled login", async t => {
  let signatures = 0;
  let decline = true;
  const f = await fixture(t, { signMessage: async () => {
    signatures++;
    if (decline) throw new Error("Declined");
    return new Uint8Array(64);
  } });
  const passive = () => f.authorizedFetch("https://mcp.example/inbox", {}, undefined, "passive");
  await assert.rejects(passive(), /Sign in to refresh/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.ensureSessionReady(), /Declined/);
  await Promise.all([assert.rejects(passive(), /Sign in to refresh/), assert.rejects(passive(), /Sign in to refresh/)]);
  assert.equal(signatures, 1);
  decline = false;
  await f.ensureSessionReady();
  assert.equal(f.hasReadySession(), true);
  assert.equal((await passive()).status, 200);
  assert.equal(signatures, 2);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 120000;
    assert.equal(f.hasReadySession(), false);
    await assert.rejects(passive(), /Sign in to refresh/);
    assert.equal(signatures, 2);
  } finally { Date.now = originalNow; }
});

test("session subscribers observe login, rejection and owner changes", async t => {
  const f = await fixture(t);
  const observed = [];
  const unsubscribe = f.subscribeSession(() => observed.push(f.hasReadySession()));
  t.after(unsubscribe);
  await f.ensureSessionReady();
  assert.equal(observed.at(-1), true);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).endsWith("/inbox") ? new Response("{}", { status: 401 }) : previous(url, init);
  await f.authorizedFetch("https://mcp.example/inbox", {}, undefined, "passive");
  assert.equal(observed.at(-1), false);
  globalThis.fetch = previous;
  await f.ensureSessionReady();
  assert.equal(observed.at(-1), true);
  f.setSessionWallet(null);
  assert.equal(observed.at(-1), false);
});
