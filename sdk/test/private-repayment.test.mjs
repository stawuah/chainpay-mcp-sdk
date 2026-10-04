import assert from "node:assert/strict";
import test from "node:test";
import { getAddressEncoder } from "@solana/addresses";
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

// ---- MagicBlock-shaped transactions (ephemeral-spl-token instruction layouts)
const ESPL = "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MAGIC = "Magic11111111111111111111111111111111111111";
const FILLER = ["SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "So11111111111111111111111111111111111111112", "Stake11111111111111111111111111111111111111", "Vote111111111111111111111111111111111111111", "Config1111111111111111111111111111111111111"];
const addressBytes = (a) => Uint8Array.from(getAddressEncoder().encode(a));
const le = (value, bytes) => Array.from({ length: bytes }, (_, i) => Number((BigInt(value) >> BigInt(8 * i)) & 0xffn));
const compact = (n) => { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };

/** A legacy transaction with one signer (the fee payer) and zeroed signature. */
function legacyTx(signer, instructions) {
  const keys = [signer];
  for (const ix of instructions) for (const k of [...ix.accounts, ix.program]) if (!keys.includes(k)) keys.push(k);
  const out = [...compact(1), ...new Array(64).fill(0), 1, 0, 0, ...compact(keys.length)];
  for (const k of keys) out.push(...addressBytes(k));
  out.push(...new Array(32).fill(1), ...compact(instructions.length));
  for (const ix of instructions) {
    out.push(keys.indexOf(ix.program), ...compact(ix.accounts.length), ...ix.accounts.map((k) => keys.indexOf(k)), ...compact(ix.data.length), ...ix.data);
  }
  return Buffer.from(out).toString("base64");
}

function depositTx({ owner = OWNER, amount, mint = PRIVATE_REPAYMENT_DEVNET_USDC, extra = [] }) {
  return legacyTx(owner, [
    ...extra,
    { program: ESPL, accounts: [FILLER[0], FILLER[1], mint, FILLER[2], FILLER[3], owner, SPL_TOKEN], data: [2, ...le(amount, 8)] },
  ]);
}

function transferTx({ owner = OWNER, amount, to = PARTNER, mint = PRIVATE_REPAYMENT_DEVNET_USDC, ref = "418273645512", split = 1, extra = [] }) {
  const data = [16, ...le(amount, 8), 0, 0, 0, ...le(0, 8), ...le(0, 8), ...le(split, 4), 0, ...le(ref, 8)];
  return legacyTx(owner, [
    ...extra,
    { program: ESPL, accounts: [FILLER[0], FILLER[1], mint, FILLER[2], FILLER[3], to, owner, SPL_TOKEN, FILLER[4], FILLER[5], FILLER[1], MAGIC], data },
  ]);
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake MagicBlock API: records calls, serves balances and honest builders (or `tamper`ed ones). */
function fakeMagicBlock({ balances, tamper = {} }) {
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
      case "/v1/spl/deposit": return json(200, { kind: "deposit", transactionBase64: depositTx({ amount: body.amount, ...tamper.deposit }), sendTo: "base", recentBlockhash: "bh", lastValidBlockHeight: 1, requiredSigners: [OWNER] });
      case "/v1/spl/transfer": return json(200, { kind: "transfer", transactionBase64: transferTx({ amount: body.amount, to: body.to, ref: body.clientRefId, ...tamper.transfer }), sendTo: "ephemeral", sendRpcEndpoint: "https://devnet-tee.magicblock.app", recentBlockhash: "bh", lastValidBlockHeight: 1, requiredSigners: [OWNER], fees: { lamports: "0", tokens: "0" } });
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
  assert.deepEqual(sent, [`signed:${depositTx({ amount: 10_000_000 })}`]);
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

/** Review F1: the owner never signs a built transaction that disagrees with the statement. */
test("a MagicBlock transaction that moves the wrong amount, recipient, mint or reference is never signed", async () => {
  const cases = {
    "transfer amount": { transfer: { amount: 999_999_990_000 } },
    "transfer recipient": { transfer: { to: OWNER } },
    "transfer mint": { transfer: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } },
    "transfer reference": { transfer: { ref: "1" } },
    "transfer split": { transfer: { split: 3 } },
    "top-level token transfer": { transfer: { extra: [{ program: SPL_TOKEN, accounts: [FILLER[2], PARTNER, OWNER], data: [3, ...le(5_000_000, 8)] }] } },
    "withdrawal": { transfer: { extra: [{ program: ESPL, accounts: [FILLER[0]], data: [3, ...le(1, 8)] }] } },
    "deposit amount": { deposit: { amount: 99_000_000 } },
    "deposit mint": { deposit: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } },
    "SOL drain": { deposit: { extra: [{ program: "11111111111111111111111111111111", accounts: [OWNER, PARTNER], data: [2, 0, 0, 0, ...le(1_000_000_000, 8)] }] } },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    // Fix every builder field honestly except the tampered one.
    const honest = { deposit: { amount: 10_000_000 }, transfer: { amount: 10_050_000, to: PARTNER, ref: "418273645512" } };
    const mb = fakeMagicBlock({ balances: [50_000, 50_000, 10_050_000], tamper: { deposit: { ...honest.deposit, ...tamper.deposit }, transfer: { ...honest.transfer, ...tamper.transfer } } });
    let signed = 0;
    await assert.rejects(
      payStatementPrivately({ attempt: attempt(), signer: { ...signer, signTransaction: async (b64) => { signed++; return `signed:${b64}`; } }, magicblock: { fetch: mb.fetch }, sendBase: async () => "sig", sleep: async () => {} }),
      (e) => e.code === "unexpected_transaction",
      name,
    );
    // A tampered deposit is refused before any signature; a tampered transfer after the honest deposit only.
    assert.equal(signed, tamper.deposit ? 0 : 1, name);
  }
});

test("an attempt whose two amounts disagree, or with a bad recipient, is not payable", () => {
  assert.throws(() => assertPayableAttempt(attempt({ amountBaseUnits: "999999990000" })), /amount/);
  assert.throws(() => assertPayableAttempt(attempt({ amountCents: "1006" })), /amount/);
  assert.throws(() => assertPayableAttempt(attempt({ recipientWallet: "not-a-wallet" })), /recipient/);
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
