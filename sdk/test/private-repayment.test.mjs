import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIVATE_REPAYMENT_DEVNET_USDC,
  PRIVATE_REPAYMENT_METHOD,
  PrivateRepaymentError,
  assertPayableAttempt,
  payStatementPrivately,
  preparePrivateRepayment,
  privateRepaymentDisclosure,
  submitPrivateRepayment,
  waitForPrivateRepayment,
} from "../dist/cards/private-repayment.js";

const OWNER = "3dh3Bxu1hJzH3aHfwNAibRqTxyrPsUFyteiuGxycoohh";
const PARTNER = "8X9QgE3rA2rJpM6GrxyQoJfWNghQdqmQM2UoyoYPEd7U";
const TOKEN = "mb-session-token-never-stored";

function attempt(overrides = {}) {
  return {
    attemptId: "p1",
    state: "awaiting_settlement",
    method: PRIVATE_REPAYMENT_METHOD,
    statementId: "card:000001",
    cluster: "devnet",
    apiCluster: "devnet-private",
    api: "https://payments.magicblock.app",
    mint: PRIVATE_REPAYMENT_DEVNET_USDC,
    amountCents: "1005",
    amountBaseUnits: "10050000",
    recipientWallet: PARTNER,
    recipientTokenAccount: "3burs6CNFvrQW8US2C5W84do8J1EezWsQfsoBAvHF5q6",
    clientRefId: "418273645512",
    transfer: { visibility: "private", fromBalance: "ephemeral", toBalance: "base", split: 1, exactOut: true, minDelayMs: "0", maxDelayMs: "0", memo: null },
    vault: { program: "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2", vault: "v", vaultTokenAccount: "va", custody: "c" },
    verification: { kind: "magicblock_queue_settlement", commitment: "finalized", checks: [], notVerifiable: ["payer"], public: [], hidden: [] },
    label: "Simulated credit",
    ...overrides,
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake MagicBlock API: records calls, serves balances and builders. */
function fakeMagicBlock({ balances }) {
  const calls = [];
  let i = 0;
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: init.headers?.authorization });
    switch (u.pathname) {
      case "/v1/spl/challenge": return json(200, { challenge: "sign-me" });
      case "/v1/spl/login": return json(200, { token: TOKEN });
      case "/v1/spl/private-balance": return json(200, { balance: String(balances[Math.min(i++, balances.length - 1)]), location: "ephemeral" });
      case "/v1/spl/deposit": return json(200, { kind: "deposit", transactionBase64: "ZGVw", sendTo: "base", recentBlockhash: "bh", lastValidBlockHeight: 1, requiredSigners: [OWNER] });
      case "/v1/spl/transfer": return json(200, { kind: "transfer", transactionBase64: "dHg=", sendTo: "ephemeral", sendRpcEndpoint: "https://devnet-tee.magicblock.app", recentBlockhash: "bh", lastValidBlockHeight: 1, requiredSigners: [OWNER], fees: { lamports: "0", tokens: "0" } });
      case "/v1/transaction/send": return json(200, { signature: "sig-transfer", confirmed: true });
      default: return json(404, { error: { code: "NOT_FOUND", message: "no" } });
    }
  };
  return { calls, fetch: f };
}

const signer = {
  publicKey: OWNER,
  async signMessage() { return new Uint8Array(64).fill(7); },
  async signTransaction(b64) { return `signed:${b64}`; },
};

test("disclosure explains the vault and never claims payer verification", () => {
  const lines = privateRepaymentDisclosure(attempt()).join("\n");
  assert.match(lines, /vault/i);
  assert.match(lines, /\$10\.05/);
  assert.match(lines, /can't check who paid/);
  assert.match(lines, /Devnet test USDC only/);
  assert.doesNotMatch(lines, /zero-knowledge|fully private|anonymous/i);
});

test("only the Devnet USDC private route is payable", () => {
  assert.doesNotThrow(() => assertPayableAttempt(attempt()));
  for (const bad of [
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    { cluster: "mainnet" },
    { apiCluster: "mainnet-private" },
    { state: "mismatch" },
    { clientRefId: "4111111111111111" },
    { transfer: { ...attempt().transfer, visibility: "public" } },
    { transfer: { ...attempt().transfer, split: 3 } },
    { transfer: { ...attempt().transfer, memo: "statement" } },
  ]) {
    assert.throws(() => assertPayableAttempt(attempt(bad)), PrivateRepaymentError, JSON.stringify(bad));
  }
});

test("deposits only the shortfall, then one private transfer tagged with the reference", async () => {
  const mb = fakeMagicBlock({ balances: [50_000, 50_000, 10_050_000] });
  const sent = [];
  const steps = [];
  const out = await payStatementPrivately({
    attempt: attempt(),
    signer,
    magicblock: { fetch: mb.fetch },
    sendBase: async (signed) => { sent.push(signed); return "sig-deposit"; },
    onStep: (s) => steps.push(s.step),
    sleep: async () => {},
  });
  assert.deepEqual(out, { depositSignature: "sig-deposit", transferSignature: "sig-transfer", transferOutcome: "sent" });
  const deposit = mb.calls.find((c) => c.path === "/v1/spl/deposit");
  assert.equal(deposit.body.amount, 10_000_000);
  assert.equal(deposit.body.private, true);
  assert.equal(deposit.body.cluster, "devnet-private");
  const transfer = mb.calls.find((c) => c.path === "/v1/spl/transfer");
  assert.equal(transfer.body.clientRefId, "418273645512");
  assert.equal(transfer.body.visibility, "private");
  assert.equal(transfer.body.to, PARTNER);
  assert.equal(transfer.body.amount, 10_050_000);
  assert.equal(transfer.body.memo, undefined, "no public memo");
  assert.deepEqual(sent, ["signed:ZGVw"]);
  assert.deepEqual(steps, ["login", "balance", "deposit", "deposit", "transfer"]);
  // The MagicBlock token goes to MagicBlock only, never into results.
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test("no deposit when the private balance already covers it; send failure is an unknown outcome", async () => {
  const mb = fakeMagicBlock({ balances: [20_000_000] });
  const failing = async (url, init) => (new URL(url).pathname === "/v1/transaction/send" ? json(502, { error: { code: "RPC_ERROR", message: "block height exceeded" } }) : mb.fetch(url, init));
  const out = await payStatementPrivately({ attempt: attempt(), signer, magicblock: { fetch: failing }, sleep: async () => {} });
  assert.equal(out.transferOutcome, "unknown");
  assert.equal(mb.calls.filter((c) => c.path === "/v1/spl/deposit").length, 0);
});

test("a builder asking for another signer is refused before signing", async () => {
  const mb = fakeMagicBlock({ balances: [20_000_000] });
  let signed = 0;
  const odd = async (url, init) => (new URL(url).pathname === "/v1/spl/transfer"
    ? json(200, { kind: "transfer", transactionBase64: "eA==", sendTo: "ephemeral", recentBlockhash: "b", lastValidBlockHeight: 1, requiredSigners: [OWNER, PARTNER] })
    : mb.fetch(url, init));
  await assert.rejects(
    payStatementPrivately({ attempt: attempt(), signer: { ...signer, signTransaction: async () => { signed++; return ""; } }, magicblock: { fetch: odd } }),
    (e) => e.code === "unexpected_transaction",
  );
  assert.equal(signed, 0);
});

test("ChainPay routes: prepare, submit, and polling past settlement_pending", async () => {
  const calls = [];
  let pending = 2;
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    if (url.endsWith("/repayment/private")) return json(200, attempt());
    if (pending-- > 0) return json(409, { code: "settlement_pending", message: "not yet", retryable: true });
    return json(200, { state: "discharged", statement: {} });
  };
  const opts = { baseUrl: "https://relay.test/", ownerSession: "owner-session", fetch: f };
  const a = await preparePrivateRepayment(opts, "card", "card:000001", "op-1");
  assert.equal(a.attemptId, "p1");
  assert.equal(calls[0].url, "https://relay.test/v1/cards/card/statements/card%3A000001/repayment/private");
  assert.deepEqual(calls[0].body, { clientOperationId: "op-1" });
  await assert.rejects(submitPrivateRepayment(opts, "card", "card:000001", "p1"), (e) => e.code === "settlement_pending" && e.retryable);
  const done = await waitForPrivateRepayment(opts, "card", "card:000001", "p1", { sleep: async () => {}, intervalMs: 1 });
  assert.equal(done.state, "discharged");
  assert.deepEqual(calls.at(-1).body, { method: PRIVATE_REPAYMENT_METHOD, attemptId: "p1", cluster: "devnet" });
  assert.equal(calls.at(-1).auth, "Bearer owner-session");
});
