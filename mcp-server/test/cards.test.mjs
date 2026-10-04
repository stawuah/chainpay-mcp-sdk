import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { findCardNumberLike, maxObligationCents } from "@chainpay/sdk";
import { TOOL_DEFINITIONS, callTool } from "../dist/index.js";
import { parseScope, CARD_TOOLS } from "../dist/authorization.js";
import { renderDocsHtml } from "../dist/docs.js";
import { SERVER_INSTRUCTIONS } from "../dist/protocol.js";

const CARD_A = "a1".repeat(32);
const CARD_B = "b2".repeat(32);
const wallet = Keypair.generate().publicKey.toBase58();
const capability = () => `cpcap_v1_${randomBytes(32).toString("base64url")}`;
const ALL_CARD_TOOLS = ["prepare_agent_card", "request_card_checkout", "get_card_activity", "get_statement", "freeze_agent_card"];

function context(scope) {
  return { client: {}, principal: { wallet, scope }, backendUrl: "http://axum.test", backendAuthToken: "c".repeat(48) };
}
const agentScope = (tools = ALL_CARD_TOOLS, cards = [CARD_A]) => ({ version: 1, mandates: [], tools, agents: {}, cards });

/** Swap global fetch for one test. Records every URL so tests can prove which routes were (not) called. */
async function withFetch(handler, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    return handler(String(url), init);
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const checkoutBody = (o = {}) => ({ capability: capability(), expiresAt: "2026-10-03T12:10:00.000Z", merchant: { displayName: "Data API" }, amountCents: "2000", currency: "USD", intentId: "int_01", status: "ready", ...o });
const checkoutArgs = (o = {}) => ({ cardId: CARD_A, merchantRef: "demo-approved", amountCents: "2000", currency: "USD", clientOperationId: "op-checkout-1", ...o });

// ---------------------------------------------------------------- catalogue

test("card tools are registered with closed schemas and no forbidden tool exists", () => {
  for (const name of ALL_CARD_TOOLS) {
    const def = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    assert.ok(def, name);
    assert.equal(def.inputSchema.additionalProperties, false, name);
    assert.ok(CARD_TOOLS.has(name));
  }
  const names = TOOL_DEFINITIONS.map((tool) => tool.name);
  for (const forbidden of names) assert.doesNotMatch(forbidden, /unfreeze|raise|grant|credit_line|repay|card_number|reveal|embed|set_card_policy|activate_card|update_card_permission|restore_card/);
  assert.match(SERVER_INSTRUCTIONS, /prepare_agent_card/);
  assert.match(SERVER_INSTRUCTIONS, /Never ask for, accept or repeat a card number/);
  const html = renderDocsHtml();
  assert.match(html, /id="agent-cards"/);
  assert.match(html, /What agents can never do here/);
  for (const name of ALL_CARD_TOOLS) assert.match(html, new RegExp(`tool-${name.replaceAll("_", "-")}`));
});

test("forbidden actions have no tool: direct calls are refused before any network work", async () => {
  await withFetch(() => { throw new Error("must not fetch"); }, async (calls) => {
    for (const name of ["unfreeze_agent_card", "raise_card_limit", "grant_card_credit", "repay_statement", "get_card_number", "reveal_card", "create_card_embed", "set_card_policy", "activate_agent_card"]) {
      await assert.rejects(callTool(context(null), name, { cardId: CARD_A }));
      await assert.rejects(callTool(context(agentScope([...ALL_CARD_TOOLS, name])), name, { cardId: CARD_A }));
    }
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- scopes

test("connection scope: cards-only scopes parse; malformed card scopes fail closed", () => {
  assert.deepEqual(parseScope(JSON.stringify(agentScope())).cards, [CARD_A]);
  assert.throws(() => parseScope(JSON.stringify({ ...agentScope(), cards: ["nope"] })), /Invalid connection scope/);
  assert.throws(() => parseScope(JSON.stringify({ ...agentScope(), cards: [] })), /Invalid connection scope/);
  assert.throws(() => parseScope(JSON.stringify({ ...agentScope(), cards: Array(21).fill(CARD_A) })), /Invalid connection scope/);
  // existing mandate scopes are unchanged
  const mandate = Keypair.generate().publicKey.toBase58();
  assert.equal(parseScope(JSON.stringify({ version: 1, mandates: [mandate], tools: ["get_mandate"], agents: { [mandate]: wallet } })).cards, undefined);
});

test("scope enforcement for every card tool", async () => {
  await withFetch((url) => {
    if (url.endsWith("/checkout-intents")) return Response.json(checkoutBody());
    if (url.includes("/activity")) return Response.json({ rows: [] });
    if (url.endsWith("/statements")) return Response.json({ statements: [] });
    if (url.endsWith("/freeze")) return Response.json({ freezeOperationId: "frz_1", onChain: "submitted", issuer: "pending_issuer_confirmation" });
    return new Response("{}", { status: 404 });
  }, async (calls) => {
    const agent = context(agentScope());
    // in scope
    assert.equal((await callTool(agent, "request_card_checkout", checkoutArgs())).structuredContent.action, "card_checkout_ready");
    assert.equal((await callTool(agent, "get_card_activity", { cardId: CARD_A })).structuredContent.action, "card_activity");
    assert.equal((await callTool(agent, "get_statement", { cardId: CARD_A })).structuredContent.found, false);
    // another card
    for (const name of ["request_card_checkout", "get_card_activity", "get_statement"]) {
      await assert.rejects(callTool(agent, name, name === "request_card_checkout" ? checkoutArgs({ cardId: CARD_B }) : { cardId: CARD_B }), /outside this connection's scope/);
    }
    // bad or missing card id
    await assert.rejects(callTool(agent, "get_card_activity", { cardId: "A1".repeat(32) }), /card id/);
    await assert.rejects(callTool(agent, "get_card_activity", {}), /card id/);
    // freeze is owner-session only, even when the scope lists it
    await assert.rejects(callTool(agent, "freeze_agent_card", { cardId: CARD_A, reason: "lost" }), /not permitted/);
    // a tool missing from scope.tools
    await assert.rejects(callTool(context(agentScope(["get_statement"])), "get_card_activity", { cardId: CARD_A }), /not permitted/);
    // owner session: may freeze and read, may not open an agent checkout
    const owner = context(null);
    assert.equal((await callTool(owner, "freeze_agent_card", { cardId: CARD_A, reason: "lost phone" })).structuredContent.issuer, "pending_issuer_confirmation");
    assert.equal((await callTool(owner, "get_card_activity", { cardId: CARD_B })).structuredContent.action, "card_activity");
    await assert.rejects(callTool(owner, "request_card_checkout", checkoutArgs()), /agent connection/);
    // no identity at all
    await assert.rejects(callTool({ client: {} }, "get_card_activity", { cardId: CARD_A }), /Sign in/);
    // a wallet argument can't impersonate another owner
    await assert.rejects(callTool(owner, "get_card_activity", { cardId: CARD_A, owner: Keypair.generate().publicKey.toBase58() }), /Wallet differs/);
    // nothing reached a route an agent must never touch
    assert.ok(calls.every(({ url }) => !/unfreeze|embed-session|repayment|recovery|activate|prepare$|redeem/.test(url)), JSON.stringify(calls.map((c) => c.url)));
    // scoped calls send the connection credential, never a wallet of their own
    assert.ok(calls.every(({ body }) => !body || !String(body).includes(wallet)));
  });
});

// -------------------------------------------------- forbidden behaviours (direct)

test("prepare_agent_card is a stateless draft: no network, no signing, exact max obligation", async () => {
  await withFetch(() => { throw new Error("must not fetch"); }, async (calls) => {
    const result = await callTool(context(agentScope()), "prepare_agent_card", { label: "Data API credits", budgetCents: "50000", maxPurchaseCents: "3000", merchants: ["demo-approved"], periodDays: 30 });
    const out = result.structuredContent;
    assert.equal(out.status, "draft");
    assert.equal(out.live, false);
    assert.equal(out.maxObligationCents, maxObligationCents(50_000n, 50).toString());
    assert.equal(out.maxObligationCents, "50250");
    assert.equal(out.display.maxObligation, "$502.50");
    assert.match(out.reviewUrl, /\/app\/cards\/new#draft=[A-Za-z0-9_-]+&digest=[0-9a-f]{64}$/);
    assert.ok(out.reviewUrl.endsWith(`&digest=${out.draftDigest}`));
    assert.match(result.content[0].text, new RegExp(`Check code: ${out.draftDigest.slice(0, 8)}`));
    assert.match(out.draftDigest, /^[0-9a-f]{64}$/);
    assert.ok(!("transaction" in out) && !("unsignedTransaction" in out) && !("cardId" in out));
    assert.match(result.content[0].text, /Nothing is live yet/);
    for (const extra of [{ creditLimitCents: "100000" }, { activate: true }, { authorizer: wallet }, { unfreeze: true }]) {
      await assert.rejects(callTool(context(null), "prepare_agent_card", { label: "x", budgetCents: "100", maxPurchaseCents: "100", mccs: [5734], periodDays: 1, ...extra }), /does not accept/);
    }
    await assert.rejects(callTool(context(null), "prepare_agent_card", { label: "x", budgetCents: "2000000", maxPurchaseCents: "100", mccs: [5734], periodDays: 1 }), /\$10,000/);
    await assert.rejects(callTool(context(null), "prepare_agent_card", { label: "x", budgetCents: "20.00", maxPurchaseCents: "100", mccs: [5734], periodDays: 1 }), /cents/);
    assert.equal(calls.length, 0);
  });
});

test("request_card_checkout refuses limit changes and card numbers in input, and calls only the checkout route", async () => {
  await withFetch(() => Response.json(checkoutBody()), async (calls) => {
    const agent = context(agentScope());
    for (const extra of [{ budgetCents: "999999" }, { maxPurchaseCents: "999999" }, { raiseLimit: true }, { creditCents: "1" }]) {
      await assert.rejects(callTool(agent, "request_card_checkout", checkoutArgs(extra)), /does not accept/);
    }
    await assert.rejects(callTool(agent, "request_card_checkout", checkoutArgs({ description: "use 4111 1111 1111 1111" })), /card number/);
    await assert.rejects(callTool(agent, "request_card_checkout", checkoutArgs({ currency: "EUR" })), /USD/);
    assert.equal(calls.length, 0);
    const result = await callTool(agent, "request_card_checkout", checkoutArgs());
    assert.match(result.structuredContent.capability, /^cpcap_v1_/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://axum.test/v1/cards/${CARD_A}/checkout-intents`);
  });
  // A malformed capability from upstream (say, a card number) never reaches the agent.
  await withFetch(() => Response.json(checkoutBody({ capability: "4111111111111111" })), async () => {
    await assert.rejects(callTool(context(agentScope()), "request_card_checkout", checkoutArgs()), /unexpected format/);
  });
});

test("get_statement is read only and always labelled simulated credit", async () => {
  await withFetch((url) => Response.json({ statementId: "stmt_1", cardId: CARD_A, periodIndex: 1, state: "closed", totalCents: "2010", feeCents: "10", dueAt: "2026-11-24T00:00:00.000Z", lines: [{ kind: "purchase", amountCents: "2000", feeCents: "10", at: "2026-10-03T00:00:00.000Z" }], simulatedCredit: true }), async (calls) => {
    const result = await callTool(context(agentScope()), "get_statement", { cardId: CARD_A, statementId: "stmt_1" });
    const s = result.structuredContent.statement;
    assert.equal(s.simulatedCredit, true);
    assert.equal(s.label, "Simulated credit");
    assert.equal(s.display.total, "$20.10");
    assert.match(result.content[0].text, /Agents can't pay or approve it/);
    assert.ok(calls.every(({ url, method }) => method === "GET" && !url.includes("repayment")));
  });
});

test("freeze_agent_card only freezes and reports the issuer as pending", async () => {
  await withFetch(() => Response.json({ freezeOperationId: "frz_9", onChain: "submitted", issuer: "pending_issuer_confirmation" }), async (calls) => {
    const result = await callTool(context(null), "freeze_agent_card", { cardId: CARD_A, reason: "suspicious" });
    assert.equal(result.structuredContent.onChain, "submitted");
    assert.equal(result.structuredContent.issuer, "pending_issuer_confirmation");
    assert.match(result.content[0].text, /pending/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/freeze$/);
    assert.equal(calls[0].method, "POST");
    await assert.rejects(callTool(context(null), "freeze_agent_card", { cardId: CARD_A, reason: "x", unfreeze: true }), /does not accept/);
  });
});

test("an unknown outcome is reported as unknown, never as done or not done", async () => {
  await withFetch(() => { throw new TypeError("socket hang up"); }, async () => {
    const result = await callTool(context(agentScope()), "request_card_checkout", checkoutArgs());
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.outcome, "unknown");
    assert.match(result.content[0].text, /clientOperationId "op-checkout-1"/);
  });
});

// ------------------------------------------------------------------ redaction fuzz

function randomPan() {
  const length = randomInt(13, 20);
  const digits = Array.from({ length }, () => randomInt(0, 10)).join("");
  const sep = [" ", "-", ""][randomInt(0, 3)];
  return digits.replace(/(\d{4})(?=\d)/g, `$1${sep}`);
}

const FORBIDDEN_KEYS = ["pan", "cardNumber", "cvv", "cvc", "expiry", "exp_month", "embedUrl", "teeToken", "authToken"];

function poison(value, pans) {
  const inject = () => { const pan = randomPan(); pans.push(pan); return pan; };
  if (Array.isArray(value)) return value.map((item) => poison(item, pans));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // never break the capability format: upstream validation rejects that outright (tested above)
      out[key] = key === "capability" ? item : typeof item === "string" && randomInt(0, 2) === 0 ? `${item} ${inject()}` : poison(item, pans);
    }
    for (const key of FORBIDDEN_KEYS) if (randomInt(0, 2) === 0) out[key] = inject();
    return out;
  }
  return value;
}

function assertClean(result, pans, label) {
  const text = JSON.stringify(result);
  assert.deepEqual(findCardNumberLike(text), [], `${label}: card-number-like run in ${text}`);
  for (const pan of pans) assert.equal(text.includes(pan.replace(/[ -]/g, "")), false, `${label}: leaked ${pan}`);
  const keys = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, item] of Object.entries(v)) { keys.push(k); walk(item); } };
  walk(result.structuredContent);
  for (const key of FORBIDDEN_KEYS) assert.equal(keys.includes(key), false, `${label}: forbidden key ${key}`);
}

test("fuzz: no 13-19 digit card number, CVV, embed URL or token ever leaves a card tool", async () => {
  const baseActivity = { rows: [
    { rowId: "row_1", cardId: CARD_A, at: "2026-10-03T00:00:00.000Z", kind: "authorization", lifecycle: "reserved", amountCents: "2000", merchant: { displayName: "Data API", mcc: "5734" }, intentId: "int_1" },
    { rowId: "row_2", cardId: CARD_A, at: "2026-10-03T00:01:00.000Z", kind: "authorization", lifecycle: "declined", amountCents: "9000", declineReason: "over_budget", merchant: { displayName: "Other", mcc: "5999" } },
    { rowId: "row_3", cardId: CARD_A, at: "2026-10-03T00:02:00.000Z", kind: "exception", lifecycle: "forced_capture", amountCents: "150", exception: "forced_capture" },
  ], nextCursor: "cur_2" };
  const baseStatement = { statementId: "stmt_1", cardId: CARD_A, periodIndex: 1, state: "closed", totalCents: "2010", feeCents: "10", digest: "ab".repeat(32), lines: [{ kind: "purchase", amountCents: "2000", feeCents: "10", at: "2026-10-03T00:00:00.000Z", merchant: { displayName: "Data API", mcc: "5734" } }], simulatedCredit: true };
  for (let i = 0; i < 60; i += 1) {
    const pans = [];
    const responses = {
      checkout: poison(checkoutBody(), pans),
      activity: poison(baseActivity, pans),
      statement: poison(baseStatement, pans),
      statements: { statements: [poison(baseStatement, pans)] },
      freeze: poison({ freezeOperationId: "frz_1", onChain: "submitted", issuer: "pending_issuer_confirmation" }, pans),
      error: poison({ code: "card_frozen", message: "Card is frozen", retryable: false }, pans),
    };
    await withFetch((url) => {
      if (url.includes("fail")) return Response.json(responses.error, { status: 409 });
      if (url.endsWith("/checkout-intents")) return Response.json(responses.checkout);
      if (url.includes("/activity")) return Response.json(responses.activity);
      if (url.endsWith("/statements")) return Response.json(responses.statements);
      if (url.includes("/statements/")) return Response.json(responses.statement);
      if (url.endsWith("/freeze")) return Response.json(responses.freeze);
      return Response.json(responses.error, { status: 500 });
    }, async () => {
      const agent = context(agentScope());
      const owner = context(null);
      try {
        assertClean(await callTool(agent, "request_card_checkout", checkoutArgs()), pans, "checkout");
      } catch (error) {
        // the upstream body may now fail strict validation (e.g. poisoned amount); that is a refusal, not a leak
        assert.doesNotMatch(String(error.message), /\d{13,}/);
      }
      assertClean(await callTool(agent, "get_card_activity", { cardId: CARD_A }), pans, "activity");
      assertClean(await callTool(agent, "get_statement", { cardId: CARD_A }), pans, "statement-latest");
      assertClean(await callTool(agent, "get_statement", { cardId: CARD_A, statementId: "stmt_1" }), pans, "statement");
      assertClean(await callTool(owner, "freeze_agent_card", { cardId: CARD_A, reason: "fuzz" }), pans, "freeze");
      assertClean(await callTool({ ...agent, backendUrl: "http://axum.test/fail" }, "get_card_activity", { cardId: CARD_A }), pans, "error");
      assertClean(await callTool(agent, "prepare_agent_card", { label: "Fuzz", budgetCents: String(randomInt(1, 1_000_000)), maxPurchaseCents: "1", mccs: [randomInt(0, 10_000)], periodDays: randomInt(1, 366) }), pans, "prepare");
    });
  }
});

test("review fixes: credit statements stay negative, numeric PANs are refused, freeze resumes with its key", async () => {
  await withFetch(() => Response.json({ statementId: "stmt_2", cardId: CARD_A, periodIndex: 2, state: "closed", totalCents: "-1005", feeCents: "-5", lines: [{ kind: "refund", amountCents: "1000", feeCents: "-5", at: "2026-10-03T00:00:00.000Z" }], simulatedCredit: true }), async () => {
    const s = (await callTool(context(agentScope()), "get_statement", { cardId: CARD_A, statementId: "stmt_2" })).structuredContent.statement;
    assert.equal(s.totalCents, "-1005");
    assert.equal(s.display.total, "-$10.05");
    assert.equal(s.lines[0].feeCents, "-5");
  });
  await withFetch(() => { throw new Error("must not fetch"); }, async (calls) => {
    await assert.rejects(callTool(context(agentScope()), "request_card_checkout", checkoutArgs({ amountCents: 4111111111111111 })), /card number/);
    await assert.rejects(callTool(context(agentScope()), "request_card_checkout", checkoutArgs({ amountCents: 2000 })), /must be a string/);
    assert.equal(calls.length, 0);
  });
  await withFetch(() => { throw new TypeError("offline"); }, async () => {
    const result = await callTool(context(null), "freeze_agent_card", { cardId: CARD_A, reason: "lost", clientOperationId: "op-freeze-77" });
    assert.equal(result.structuredContent.outcome, "unknown");
    assert.equal(result.structuredContent.clientOperationId, "op-freeze-77");
    assert.match(result.content[0].text, /op-freeze-77/);
    const read = await callTool(context(agentScope()), "get_card_activity", { cardId: CARD_A });
    assert.match(read.content[0].text, /safe to call get_card_activity again/);
  });
});

test("a connection can only be scoped to cards the owner session owns", async (t) => {
  const { createServer } = await import("node:http");
  const { createHttpServer } = await import("../dist/http.js");
  const { McpConnectionRegistry } = await import("../dist/connections.js");
  const token = "s".repeat(64);
  const backend = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end("{}"); return; }
    if (req.url === "/v1/auth/session") { res.end(JSON.stringify({ wallet, expires_at_ms: Date.now() + 60_000 })); return; }
    if (req.url === `/v1/cards/${CARD_A}`) { res.end(JSON.stringify({ cardId: CARD_A })); return; }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const registry = McpConnectionRegistry.inMemory();
  const { server } = createHttpServer({ client: {}, backendUrl: `http://127.0.0.1:${backend.address().port}` }, { host: "127.0.0.1", port: 3000, allowedOrigins: ["http://localhost:5173"] }, registry);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); backend.closeAllConnections(); backend.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (cards) => fetch(`${base}/connections`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ agentName: "Card agent", scope: JSON.stringify(agentScope(["get_card_activity"], cards)) }) });
  assert.equal((await post([CARD_B])).status, 403);
  assert.equal((await post([CARD_A, CARD_B])).status, 403);
  assert.equal((await post([CARD_A])).status, 201);
  const bad = await fetch(`${base}/connections`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ agentName: "x", scope: JSON.stringify(agentScope(["freeze_agent_card"])) }) });
  assert.equal(bad.status, 403);
});
