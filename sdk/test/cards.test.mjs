import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CARD_ACCOUNT_DISCRIMINATORS,
  CARD_BINDING_LENGTH,
  CARD_COMMITMENT_LENGTH,
  CARD_PERIOD_LENGTH,
  CARD_POLICY_DISCRIMINATORS,
  CARD_POLICY_LENGTH,
  CHECKOUT_INTENT_LENGTH,
  CardsApiClient,
  CardsApiError,
  DEVNET_TEE_VALIDATOR,
  RESERVATION_LENGTH,
  authIdHash,
  availableCents,
  base58Encode,
  buildDelegateCardInstruction,
  buildSetPolicyInstruction,
  buildUpdatePermissionInstruction,
  buildWriteCommitmentInstruction,
  cardIdFromHex,
  cardIdToHex,
  cardPolicyErrorName,
  centsToTokenBaseUnits,
  declineForProgramError,
  decodeCardBinding,
  decodeCardCommitment,
  decodeCardInstructionData,
  decodeCardPeriod,
  decodeCardPolicy,
  decodeCheckoutIntent,
  decodeReservation,
  deriveCardAccounts,
  deriveCardBindingAddress,
  deriveCardEscrowAddress,
  deriveCheckoutIntentAddress,
  derivePermissionAddress,
  deriveReservationAddress,
  describeTeeRead,
  encodeCardBinding,
  encodeCardCommitment,
  encodeCardInstructionData,
  encodeCardPeriod,
  encodeCardPolicy,
  encodeCheckoutIntent,
  encodeReservation,
  feeCents,
  findCardNumberLike,
  formatFeeBps,
  formatUsdCents,
  getTeeSession,
  isCardEvidence,
  isCheckoutCapability,
  keypairSigner,
  luhnValid,
  maxObligationCents,
  mayRenderAsSplSettlement,
  merchantIdHash,
  outstandingAfterCapture,
  outstandingAfterRefund,
  parseCents,
  parseCheckoutCapabilityResponse,
  parseMeasurementAllowlist,
  policyArgsProblems,
  policyReviewSummary,
  readCardPolicy,
  readTeeAccount,
  redactCardData,
  requireVisible,
  statementTotals,
  verifyTee,
  walletAdapterSigner,
} from "../dist/index.js";

const PROGRAM = Keypair.generate().publicKey.toBase58();
const key = () => Keypair.generate().publicKey.toBase58();
const bytes = (n, fill) => new Uint8Array(n).fill(fill);
const sha8 = (s) => [...createHash("sha256").update(s).digest().subarray(0, 8)];
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// ------------------------------------------------------------ discriminators

test("instruction and account discriminators are Anchor sha256 prefixes", () => {
  for (const [name, disc] of Object.entries(CARD_POLICY_DISCRIMINATORS)) {
    assert.deepEqual([...disc], sha8(`global:${snake(name)}`), name);
  }
  for (const [name, disc] of Object.entries(CARD_ACCOUNT_DISCRIMINATORS)) {
    assert.deepEqual([...disc], sha8(`account:${name[0].toUpperCase()}${name.slice(1)}`), name);
  }
  assert.equal(Object.keys(CARD_POLICY_DISCRIMINATORS).length, 27);
  assert.equal(cardPolicyErrorName(6016), "BudgetExceeded");
  assert.equal(cardPolicyErrorName(6032), "DuplicateRepayment");
  assert.equal(cardPolicyErrorName(5999), undefined);
});

// -------------------------------------------------------------------- accounts

function policyFixture(overrides = {}) {
  return {
    binding: key(), owner: key(), authorizer: key(), policyVersion: 3,
    budgetCents: 50_000n, maxPurchaseCents: 3_000n, maxPurchasesPerPeriod: 10, periodSeconds: 2_592_000,
    currency: "USD", merchantIdHashes: [bytes(32, 7), bytes(32, 8)], mccs: [5734, 5045],
    expiresAt: 1_790_000_000n, recurringAllowed: true, feeBps: 50, frozen: false, freezeReason: "none",
    recoveryState: "normal", statementOutstandingCents: 1_206n, exceptionsOpen: 1,
    members: [{ pubkey: key(), flags: 15 }, { pubkey: key(), flags: 10 }],
    ledgerHead: bytes(32, 9), ledgerSeq: 41n, commitSeq: 4n, bump: 254,
    ...overrides,
  };
}

test("account layouts round-trip and have the contract's fixed sizes", () => {
  const binding = { version: 1, owner: key(), cardId: bytes(32, 1), issuer: 1, issuerCardRefHash: bytes(32, 2), policy: key(), period: key(), commitment: key(), status: "active", createdAt: 1_759_000_000n, bump: 255 };
  const period = { policy: key(), periodIndex: 2, periodStart: 1_759_000_000n, periodEnd: 1_761_592_000n, capturedCents: 2_000n, reservedCents: 500n, refundedCents: 100n, purchasesCount: 3, exceptionCents: 0n, bump: 253 };
  const reservation = { policy: key(), authIdHash: bytes(32, 3), intent: key(), periodIndex: 2, amountReservedCents: 500n, capturedCents: 200n, reversedCents: 0n, refundedCents: 0n, state: 2, disputeState: "open", flags: 0b1001, createdAt: 1n, holdExpiresAt: 604_801n, bump: 250 };
  const intent = { policy: key(), intentId: bytes(16, 4), agent: key(), merchantIdHash: bytes(32, 5), mcc: 5734, maxAmountCents: 2_000n, currency: "USD", policyVersion: 3, expiresAt: 1_759_000_600n, state: "consumed", reservation: key(), bump: 249 };
  const commitment = { binding: key(), seq: 7n, root: bytes(32, 6), policyVersion: 3, periodIndex: 2, writtenSlot: 400_000_000n, bump: 248 };
  const policy = policyFixture();
  const cases = [
    [binding, encodeCardBinding, decodeCardBinding, CARD_BINDING_LENGTH, 212],
    [policy, encodeCardPolicy, decodeCardPolicy, CARD_POLICY_LENGTH, 695],
    [period, encodeCardPeriod, decodeCardPeriod, CARD_PERIOD_LENGTH, 95],
    [reservation, encodeReservation, decodeReservation, RESERVATION_LENGTH, 160],
    [intent, encodeCheckoutIntent, decodeCheckoutIntent, CHECKOUT_INTENT_LENGTH, 179],
    [commitment, encodeCardCommitment, decodeCardCommitment, CARD_COMMITMENT_LENGTH, 97],
  ];
  for (const [value, encode, decode, length, expected] of cases) {
    const data = encode(value);
    assert.equal(length, expected);
    assert.equal(data.length, length);
    assert.deepEqual(decode(data), value);
    // Append-only program changes (extra trailing fields) still decode.
    assert.deepEqual(decode(Uint8Array.from([...data, 1, 2, 3])), value);
    assert.throws(() => decode(data.slice(0, length - 1)), /truncated/);
    const wrong = data.slice(); wrong[0] ^= 0xff;
    assert.throws(() => decode(wrong), /discriminator/);
  }
});

test("CardPolicy field offsets match the contract struct order", () => {
  const p = policyFixture();
  const data = encodeCardPolicy(p);
  const view = new DataView(data.buffer);
  // 8 disc + binding/owner/authorizer (96) = 104 → policy_version u32
  assert.equal(view.getUint32(104, true), 3);
  assert.equal(view.getBigUint64(108, true), 50_000n); // budget_cents
  assert.equal(view.getBigUint64(116, true), 3_000n); // max_purchase_cents
  assert.equal(view.getUint16(124, true), 10); // max_purchases_per_period
  assert.equal(view.getUint32(126, true), 2_592_000); // period_seconds
  assert.equal(String.fromCharCode(data[130], data[131], data[132]), "USD");
  assert.equal(data[133], 2); // merchant_count
  assert.equal(data[134], 7); // first merchant hash byte
  assert.equal(data[134 + 256], 2); // mcc_count after 8 fixed merchant slots
  assert.equal(view.getUint16(134 + 256 + 1, true), 5734);
  assert.equal(data.at(-1), 254); // bump last
  // Zeroed account (pre set_policy) decodes as "not set" with zero authorizer.
  const zero = new Uint8Array(CARD_POLICY_LENGTH); zero.set(CARD_ACCOUNT_DISCRIMINATORS.cardPolicy);
  const decoded = decodeCardPolicy(zero);
  assert.equal(decoded.authorizer, PublicKey.default.toBase58());
  assert.equal(decoded.currency, "");
  assert.deepEqual(decoded.merchantIdHashes, []);
});

test("decoders reject impossible counts and enum values", () => {
  const data = encodeCardPolicy(policyFixture());
  const bad = data.slice(); bad[133] = 9;
  assert.throws(() => decodeCardPolicy(bad), /merchant_count/);
  const badReason = encodeCardPolicy(policyFixture({ frozen: true, freezeReason: "owner" }));
  const offset = 134 + 256 + 1 + 32 + 8 + 1 + 2 + 1; // freeze_reason
  assert.equal(badReason[offset], 1);
  badReason[offset] = 42;
  assert.throws(() => decodeCardPolicy(badReason), /freeze reason/);
});

// ------------------------------------------------------------------------ PDAs

test("PDA helpers use the contract seeds and refuse an unconfigured program", () => {
  const owner = key();
  const cardId = bytes(32, 0xab);
  const programKey = new PublicKey(PROGRAM);
  const binding = PublicKey.findProgramAddressSync([Buffer.from("card_binding"), new PublicKey(owner).toBuffer(), Buffer.from(cardId)], programKey)[0].toBase58();
  const accounts = deriveCardAccounts(owner, cardId, PROGRAM);
  assert.equal(accounts.binding, binding);
  assert.equal(accounts.policy, PublicKey.findProgramAddressSync([Buffer.from("card_policy"), new PublicKey(binding).toBuffer()], programKey)[0].toBase58());
  assert.equal(accounts.period, PublicKey.findProgramAddressSync([Buffer.from("card_period"), new PublicKey(binding).toBuffer()], programKey)[0].toBase58());
  assert.equal(accounts.commitment, PublicKey.findProgramAddressSync([Buffer.from("card_commit"), new PublicKey(binding).toBuffer()], programKey)[0].toBase58());
  assert.equal(accounts.escrow, deriveCardEscrowAddress(accounts.policy));
  assert.equal(accounts.policyPermission, derivePermissionAddress(accounts.policy));
  const auth = bytes(32, 3);
  assert.equal(deriveReservationAddress(accounts.policy, auth, PROGRAM), PublicKey.findProgramAddressSync([Buffer.from("res"), new PublicKey(accounts.policy).toBuffer(), Buffer.from(auth)], programKey)[0].toBase58());
  assert.equal(deriveCheckoutIntentAddress(accounts.policy, bytes(16, 1), PROGRAM), PublicKey.findProgramAddressSync([Buffer.from("intent"), new PublicKey(accounts.policy).toBuffer(), Buffer.from(bytes(16, 1))], programKey)[0].toBase58());
  assert.throws(() => deriveCheckoutIntentAddress(accounts.policy, bytes(32, 1), PROGRAM), /16 bytes/);
  assert.throws(() => deriveCardBindingAddress(owner, cardId), /not configured/);
  assert.equal(cardIdToHex(cardIdFromHex("ab".repeat(32))), "ab".repeat(32));
  assert.throws(() => cardIdFromHex("xyz"), /hex/);
});

// --------------------------------------------------------------- instructions

const policyArgs = (o = {}) => ({
  budgetCents: 50_000n, maxPurchaseCents: 3_000n, maxPurchasesPerPeriod: 0, periodSeconds: 2_592_000, currency: "USD",
  merchantIdHashes: [bytes(32, 1)], mccs: [5734], expiresAt: 0n, recurringAllowed: false, feeBps: 50, authorizer: key(), ...o,
});

test("every instruction's data round-trips with exact Borsh sizes", () => {
  const h = (n) => bytes(32, n);
  const samples = {
    initCard: [{ cardId: h(1), issuer: 1, issuerCardRefHash: h(2), prefundLamports: 10_000_000n }, 81],
    delegateCard: [{ validator: DEVNET_TEE_VALIDATOR }, 40],
    initPermission: [{ authorizer: key() }, 40],
    updatePermission: [{ op: { kind: "remove_reader", pubkey: key() } }, 41],
    syncPermission: [{}, 8],
    setPolicy: [{ policy: policyArgs({ merchantIdHashes: [h(1), h(2)], mccs: [1, 2, 3] }) }, 8 + 8 + 8 + 2 + 4 + 3 + 4 + 64 + 4 + 6 + 8 + 1 + 2 + 32],
    openCheckoutIntent: [{ intentId: bytes(16, 1), agent: key(), merchantIdHash: h(3), mcc: 5734, maxAmountCents: 2_000n, currency: "USD", expiresAt: 1_759_000_600n }, 8 + 16 + 32 + 32 + 2 + 8 + 3 + 8],
    cancelCheckoutIntent: [{}, 8],
    authorize: [{ authIdHash: h(4), intentId: bytes(16, 2), amountCents: 2_000n, currency: "USD", merchantIdHash: h(3), mcc: 5734, merchantInitiated: false, singleMessage: true }, 8 + 32 + 16 + 8 + 3 + 32 + 2 + 1 + 1],
    adjustReservation: [{ newAmountCents: 1n }, 16],
    capture: [{ amountCents: 1_999n, captureIdHash: h(5) }, 48],
    reverse: [{ amountCents: 1n, reason: 1, eventIdHash: h(6) }, 49],
    refund: [{ amountCents: 1n, eventIdHash: h(6) }, 48],
    recordDispute: [{ state: 2, eventIdHash: h(6) }, 41],
    recordException: [{ kind: 1, amountCents: 99n, eventIdHash: h(6) }, 49],
    resolveException: [{ eventIdHash: h(6), resolution: 1 }, 41],
    rollPeriod: [{}, 8],
    freeze: [{ reason: 2 }, 9],
    unfreeze: [{}, 8],
    recoveryFreeze: [{ reason: 3 }, 9],
    restore: [{ restore: { policy: policyArgs(), periodIndex: 2, capturedCents: 1n, reservedCents: 2n, refundedCents: 3n, purchasesCount: 4, statementOutstandingCents: 5n, ledgerHead: h(7), ledgerSeq: 6n, reconDigest: h(8) } }, null],
    confirmReconciled: [{ reconDigest: h(8) }, 40],
    checkpoint: [{ masterSalt: h(9), seq: 5n }, 48],
    writeCommitment: [{ root: h(10), seq: 5n, policyVersion: 3, periodIndex: 2 }, 56],
    wipeCard: [{}, 8],
    closeCard: [{}, 8],
    recordRepayment: [{ statementDigest: h(11), amountCents: 50_250n }, 48],
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(CARD_POLICY_DISCRIMINATORS).sort());
  for (const [name, [args, size]] of Object.entries(samples)) {
    const data = encodeCardInstructionData(name, args);
    if (size !== null) assert.equal(data.length, size, name);
    assert.deepEqual([...data.subarray(0, 8)], [...CARD_POLICY_DISCRIMINATORS[name]]);
    assert.deepEqual(decodeCardInstructionData(data), { name, args }, name);
    assert.throws(() => decodeCardInstructionData(Uint8Array.from([...data, 0])), /trailing/);
  }
  assert.throws(() => decodeCardInstructionData(bytes(8, 0)), /Unknown/);
  // Borsh Vec prefix: u32 count before merchant hashes.
  const sp = encodeCardInstructionData("setPolicy", { policy: policyArgs({ merchantIdHashes: [bytes(32, 1), bytes(32, 2)] }) });
  assert.equal(new DataView(sp.buffer).getUint32(8 + 8 + 8 + 2 + 4 + 3, true), 2);
});

test("owner builders validate before anything is signed", () => {
  const owner = key();
  const cardId = bytes(32, 5);
  const ix = buildSetPolicyInstruction({ owner, cardId, policy: policyArgs() }, PROGRAM);
  assert.equal(ix.programId, PROGRAM);
  assert.equal(ix.keys[0].address, owner);
  assert.equal(ix.keys[0].isSigner, true);
  assert.throws(() => buildSetPolicyInstruction({ owner, cardId, policy: policyArgs({ maxPurchaseCents: 60_000n }) }, PROGRAM), /more than the budget/);
  assert.throws(() => buildSetPolicyInstruction({ owner, cardId, policy: policyArgs({ merchantIdHashes: [], mccs: [] }) }, PROGRAM), /at least one shop/);
  assert.deepEqual(policyArgsProblems(policyArgs({ budgetCents: 2_000_000n, maxPurchaseCents: 1n, currency: "EUR", feeBps: 2_000, periodSeconds: 60, mccs: [1, 1] })).length, 5);
  assert.throws(() => buildDelegateCardInstruction({ owner, cardId, validator: key() }, PROGRAM), /allowed TEE validator/);
  assert.throws(() => buildUpdatePermissionInstruction({ owner, cardId, op: { kind: "make_public", pubkey: key() } }, PROGRAM), /Only add_reader/);
  assert.throws(() => buildSetPolicyInstruction({ owner, cardId, policy: policyArgs() }), /not configured/);
});

test("write_commitment keeps the contract's fixed account order", () => {
  const owner = key();
  const cardId = bytes(32, 6);
  const a = deriveCardAccounts(owner, cardId, PROGRAM);
  const ix = buildWriteCommitmentInstruction({ owner, cardId, root: bytes(32, 1), seq: 2n, policyVersion: 1, periodIndex: 1 }, PROGRAM);
  assert.deepEqual(ix.keys.map((k) => k.address), [a.commitment, a.binding, PROGRAM, a.policy, a.escrow]);
  assert.deepEqual(ix.keys.map((k) => [k.isWritable, k.isSigner]), [[true, false], [false, false], [false, false], [false, false], [false, true]]);
});

// ------------------------------------------------------------------------ math

test("budget and statement math is exact integer cents", () => {
  assert.equal(maxObligationCents(50_000n, 50), 50_250n);
  assert.equal(formatUsdCents(maxObligationCents(50_000n, 50)), "$502.50");
  assert.equal(feeCents(1n, 50), 1n); // ceil, never rounds down to free
  assert.equal(feeCents(0n, 50), 0n);
  assert.equal(feeCents(19_999n, 50), 100n);
  assert.equal(feeCents(20_001n, 50), 101n);
  assert.equal(availableCents(50_000n, 49_000n, 2_000n), 0n);
  assert.equal(availableCents(50_000n, 10_000n, 2_000n), 38_000n);
  assert.equal(outstandingAfterCapture(0n, 2_000n, 50), 2_010n);
  assert.equal(outstandingAfterRefund(2_010n, 2_000n, 50), 0n);
  assert.equal(outstandingAfterRefund(5_000n, 1_000n, 50), 3_995n);
  const totals = statementTotals([{ kind: "purchase", amountCents: 2_000n }, { kind: "purchase", amountCents: 1n }, { kind: "refund", amountCents: 500n }], 50);
  assert.deepEqual(totals, { purchasesCents: 2_001n, refundsCents: 500n, feeCents: 10n + 1n - 3n, totalCents: 2_001n - 500n + 8n });
  assert.equal(statementTotals([{ kind: "refund", amountCents: 100n }], 0).totalCents, -100n);
  assert.equal(formatUsdCents("123456789"), "$1,234,567.89");
  assert.equal(formatUsdCents(5n), "$0.05");
  assert.equal(formatFeeBps(50), "0.5%");
  assert.equal(formatFeeBps(125), "1.25%");
  assert.equal(formatFeeBps(0), "0%");
  assert.equal(centsToTokenBaseUnits(50_250n, 6), 502_500_000n);
  for (const bad of ["5.00", "-1", "01", "", " 1", 5, "1e3", "12345678901234567"]) assert.throws(() => parseCents(bad), /cents/);
  assert.equal(parseCents("0"), 0n);
  assert.throws(() => feeCents(1n, 1_001), /feeBps/);
  const review = policyReviewSummary(50_000n, 3_000n, 50);
  assert.equal(review.maxObligationCents, "50250");
  assert.equal(review.display.maxObligation, "$502.50");
  assert.equal(review.display.fee, "0.5%");
});

// ----------------------------------------------------------------- hashes etc.

test("domain-separated hashes match the contract formulas", async () => {
  const merchant = await merchantIdHash("  demo-merchant-approved ");
  assert.deepEqual([...merchant], [...createHash("sha256").update("chainpay-merchant:v1\nDEMO-MERCHANT-APPROVED").digest()]);
  const auth = await authIdHash(1, "txn_abc");
  assert.deepEqual([...auth], [...createHash("sha256").update(Buffer.concat([Buffer.from("chainpay-auth-id:v1\n"), Buffer.from([1]), Buffer.from("txn_abc")])).digest()]);
  assert.equal(isCheckoutCapability(`cpcap_v1_${randomBytes(32).toString("base64url")}`), true);
  assert.equal(isCheckoutCapability("cpcap_v1_short"), false);
  assert.equal(isCheckoutCapability("4111111111111111"), false);
});

test("card-number detection catches PANs and ignores addresses and digests", () => {
  assert.deepEqual(findCardNumberLike("card 4111 1111 1111 1111 ok"), ["4111 1111 1111 1111"]);
  assert.deepEqual(findCardNumberLike("4111-1111-1111-1111"), ["4111-1111-1111-1111"]);
  assert.equal(findCardNumberLike("1234567890123").length, 1); // 13 digits
  assert.equal(findCardNumberLike("123456789012").length, 0); // 12 digits
  assert.equal(findCardNumberLike(key()).length, 0);
  assert.equal(findCardNumberLike("a1234567890123456789b").length, 0);
  assert.equal(luhnValid("4111111111111111"), true);
  assert.equal(luhnValid("4111111111111112"), false);
  const { value, redactions } = redactCardData({ ok: "50250", nested: [{ pan: "4111111111111111", note: "use 5555555555554444 now" }], cvv: "123" });
  assert.deepEqual(value, { ok: "50250", nested: [{ note: "use [redacted] now" }] });
  assert.equal(redactions, 3);
});

test("card evidence never renders as SPL settlement and declines map to plain reasons", () => {
  const card = { kind: "card_authorization", cardId: "c", intentId: "i", merchant: { displayName: "Data API", mcc: "5734" }, amountCents: "2000", currency: "USD", reservationState: "reserved", decision: "approved", at: "2026-10-03T00:00:00Z", private: true };
  assert.equal(isCardEvidence(card), true);
  assert.equal(mayRenderAsSplSettlement(card), false);
  assert.equal(mayRenderAsSplSettlement({ kind: "spl_settlement", receiptPda: key() }), true);
  assert.deepEqual(declineForProgramError(6016), { asa: "INSUFFICIENT_FUNDS", reason: "over_budget" });
  assert.deepEqual(declineForProgramError(6004), { asa: "CARD_PAUSED", reason: "frozen" });
  assert.deepEqual(declineForProgramError(6010), { asa: "UNAUTHORIZED_MERCHANT", reason: "merchant_not_allowed" });
  assert.deepEqual(declineForProgramError(6017), { asa: "VELOCITY_EXCEEDED", reason: "velocity" });
  assert.deepEqual(declineForProgramError(6030), { asa: "SUSPECTED_FRAUD", reason: "internal" });
});

// ------------------------------------------------------------------------- TEE

function mockTee({ accountValue = null, rpcError = null, failFirstWith401 = false, expiresAt } = {}) {
  const calls = [];
  let tokens = 0;
  let rejectedOnce = false;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, token: u.searchParams.get("token"), body: init.body });
    if (u.pathname === "/auth/challenge") return Response.json({ challenge: `challenge-for-${u.searchParams.get("pubkey")}` });
    if (u.pathname === "/auth/login") {
      const body = JSON.parse(init.body);
      calls.at(-1).signature = body.signature;
      tokens += 1;
      return Response.json({ token: `secret-token-${tokens}`, ...(expiresAt ? { expiresAt } : {}) });
    }
    if (failFirstWith401 && !rejectedOnce) { rejectedOnce = true; return new Response("{}", { status: 401 }); }
    if (rpcError) return Response.json({ jsonrpc: "2.0", id: 1, error: rpcError });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 99 }, value: accountValue } });
  };
  return { fetch, calls, tokens: () => tokens };
}

test("TEE session signs the challenge, hides the token and treats null as not visible", async () => {
  const kp = Keypair.generate();
  const signer = await keypairSigner(kp.secretKey);
  assert.equal(signer.publicKey, kp.publicKey.toBase58());
  const tee = mockTee();
  const session = await getTeeSession(signer, { fetch: tee.fetch, teeUrl: "https://tee.test" });
  const login = tee.calls.find((c) => c.path === "/auth/login");
  assert.equal(login.signature.length > 80, true);
  assert.equal(JSON.stringify(session).includes("secret-token"), false);
  assert.equal(inspect(session).includes("secret-token"), false);
  const read = await readTeeAccount(session, key());
  assert.deepEqual(read, { state: "not_visible", slot: 99n });
  assert.match(describeTeeRead(read), /Not visible/);
  assert.doesNotMatch(describeTeeRead(read), /missing|not found|doesn't exist/i);
  assert.throws(() => requireVisible(read, "Card policy"), /not visible.*failing closed/);
  const policy = await readCardPolicy(session, key());
  assert.equal(policy.state, "not_visible");
});

test("TEE reads decode visible accounts and surface RPC errors without guessing", async () => {
  const signer = await keypairSigner(Keypair.generate().secretKey);
  const data = encodeCardPolicy(policyFixture());
  const visible = mockTee({ accountValue: { owner: PROGRAM, lamports: 1, data: [Buffer.from(data).toString("base64"), "base64"], executable: false } });
  const s1 = await getTeeSession(signer, { fetch: visible.fetch, teeUrl: "https://tee.test" });
  const read = await readCardPolicy(s1, key(), PROGRAM);
  assert.equal(read.state, "visible");
  assert.equal(read.account.budgetCents, "50000");
  assert.equal(read.account.maxObligationCents, "50250");
  assert.equal((await readCardPolicy(s1, key(), key())).code, "wrong_owner_program");
  const broken = mockTee({ rpcError: { code: -32602, message: "bad" } });
  const s2 = await getTeeSession(signer, { fetch: broken.fetch, teeUrl: "https://tee.test" });
  assert.deepEqual(await readTeeAccount(s2, key()), { state: "rpc_error", code: "rpc_-32602" });
  const offline = await getTeeSession(signer, { fetch: async (url, init) => (new URL(url).pathname.startsWith("/auth") ? visible.fetch(url, init) : Promise.reject(new Error(`boom ${url}`))), teeUrl: "https://tee.test" });
  assert.deepEqual(await readTeeAccount(offline, key()), { state: "rpc_error", code: "network" });
});

test("TEE session refreshes on 401 and inside the 24h window", async () => {
  const signer = await keypairSigner(Keypair.generate().secretKey);
  const tee = mockTee({ failFirstWith401: true });
  const session = await getTeeSession(signer, { fetch: tee.fetch, teeUrl: "https://tee.test" });
  await readTeeAccount(session, key());
  assert.equal(tee.tokens(), 2);
  assert.equal(tee.calls.filter((c) => c.path === "/").at(-1).token, "secret-token-2");
  let now = 1_000_000;
  const soon = mockTee({ expiresAt: now + 3_600_000 });
  const s2 = await getTeeSession(signer, { fetch: soon.fetch, teeUrl: "https://tee.test", now: () => now });
  assert.equal(s2.needsRefresh(), true);
  await readTeeAccount(s2, key());
  assert.equal(soon.tokens(), 2);
});

test("wallet-adapter signer accepts adapter and wallet-standard shapes and rejects a wrong signature", async () => {
  const kp = Keypair.generate();
  const real = await keypairSigner(kp.secretKey);
  const adapter = walletAdapterSigner({ publicKey: kp.publicKey, signMessage: async (m) => real.signMessage(m) });
  const standard = walletAdapterSigner({ publicKey: kp.publicKey.toBase58(), signMessage: async (m) => [{ signature: await real.signMessage(m) }] });
  for (const signer of [adapter, standard]) {
    const tee = mockTee();
    await getTeeSession(signer, { fetch: tee.fetch, teeUrl: "https://tee.test" });
    assert.equal(tee.tokens(), 1);
  }
  const imposter = await keypairSigner(Keypair.generate().secretKey);
  const lying = walletAdapterSigner({ publicKey: kp.publicKey, signMessage: (m) => imposter.signMessage(m) });
  await assert.rejects(getTeeSession(lying, { fetch: mockTee().fetch, teeUrl: "https://tee.test" }), /doesn't match/);
  assert.throws(() => walletAdapterSigner({ publicKey: null }), /Connect a wallet/);
  assert.throws(() => walletAdapterSigner({ publicKey: kp.publicKey }), /can't sign messages/);
  assert.equal(base58Encode(Uint8Array.of(0, 0, 1)), "112");
});

test("attestation reports 'hardware verified, measurements pending' until an allowlist exists", async () => {
  const ok = { verifyRpcIntegrity: async () => {}, verifyIntegrity: async () => {} };
  const pending = await verifyTee({ mode: "report", provider: ok });
  assert.equal(pending.label, "Hardware verified, measurements pending");
  assert.equal(pending.measurements, "pending");
  assert.equal(pending.ok, true);
  const m = { mrTd: "a".repeat(96), rtMr0: "b".repeat(96), rtMr1: "c".repeat(96), rtMr2: "d".repeat(96) };
  const other = { ...m, mrTd: "e".repeat(96) };
  const reading = { ...ok, readMeasurements: async () => m };
  assert.equal((await verifyTee({ mode: "enforce", provider: reading, allowlist: [m] })).measurements, "matched");
  const enforceMismatch = await verifyTee({ mode: "enforce", provider: reading, allowlist: [other] });
  assert.equal(enforceMismatch.ok, false);
  assert.equal(enforceMismatch.measurements, "mismatch");
  const reportMismatch = await verifyTee({ mode: "report", provider: reading, allowlist: [other] });
  assert.equal(reportMismatch.ok, true);
  assert.equal((await verifyTee({ mode: "enforce", provider: ok, allowlist: [m] })).ok, false); // can't read measurements
  const failed = await verifyTee({ mode: "report", provider: { verifyRpcIntegrity: async () => { throw new Error("bad quote"); } } });
  assert.equal(failed.hardware, "failed");
  assert.equal(failed.ok, false);
  assert.deepEqual(parseMeasurementAllowlist(JSON.stringify([m])), [m]);
  assert.deepEqual(parseMeasurementAllowlist(""), []);
  assert.throws(() => parseMeasurementAllowlist(JSON.stringify([{ mrTd: "zz" }])), /48 bytes/);
});

// ------------------------------------------------------------------- API client

test("card API client sends the bearer, validates checkout capabilities and maps errors", async () => {
  const cardId = "ab".repeat(32);
  const seen = [];
  const capability = `cpcap_v1_${randomBytes(32).toString("base64url")}`;
  const fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith("/checkout-intents")) return Response.json({ capability, expiresAt: "2026-10-03T00:10:00Z", merchant: { displayName: "Data API" }, amountCents: "2000", currency: "USD", intentId: "int_1", status: "ready" });
    return Response.json({ code: "card_frozen", message: "Card is frozen", retryable: false, evidenceState: "none" }, { status: 409 });
  };
  const client = new CardsApiClient({ baseUrl: "https://axum.test/", authToken: "conn-token-xyz", fetch });
  const result = await client.requestCardCheckout({ cardId, merchantRef: "demo-approved", amountCents: "2000", currency: "USD", clientOperationId: "op-12345678" });
  assert.equal(result.capability, capability);
  assert.equal(seen[0].url, `https://axum.test/v1/cards/${cardId}/checkout-intents`);
  assert.equal(seen[0].init.headers.Authorization, "Bearer conn-token-xyz");
  assert.equal(JSON.stringify(client).includes("conn-token-xyz"), false);
  await assert.rejects(client.freezeCard(cardId, "lost", "op-12345678"), (error) => error instanceof CardsApiError && error.status === 409 && error.code === "card_frozen");
  await assert.rejects(client.requestCardCheckout({ cardId, merchantRef: "x", amountCents: "20.00", currency: "USD", clientOperationId: "op-12345678" }), /cents/);
  await assert.rejects(client.getCard("not-a-card"), /64 lowercase hex/);
  assert.throws(() => parseCheckoutCapabilityResponse({ capability: "4111111111111111", status: "ready" }), /format/);
});

test("program-appended tails decode when present and account lists match the card_policy structs", async () => {
  const { reservationStateName, buildCloseCardInstruction, buildFreezeInstruction, buildUnfreezeInstruction, buildInitPermissionInstruction, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID } = await import("../dist/index.js");
  // CardPolicy + recon_digest[32] + repayment_digests[8][32] + repayment_count u8 = 984 bytes on chain
  const base = encodeCardPolicy(policyFixture());
  const tail = new Uint8Array(32 + 256 + 1); tail.fill(4, 0, 32); tail.fill(5, 32, 64); tail[288] = 1;
  const full = Uint8Array.from([...base, ...tail]);
  assert.equal(full.length, 984);
  const decoded = decodeCardPolicy(full);
  assert.deepEqual(decoded.tail, { reconDigest: bytes(32, 4), repaymentDigests: [bytes(32, 5)] });
  assert.equal(decodeCardPolicy(base).tail, undefined);
  assert.equal(reservationStateName(1), "reserved");
  assert.equal(reservationStateName(2), "partially_captured");
  assert.equal(reservationStateName(5), "expired");
  assert.equal(reservationStateName(0), undefined);

  const owner = key();
  const cardId = bytes(32, 7);
  const a = deriveCardAccounts(owner, cardId, PROGRAM);
  // CardPermissions (init_permission, update_permission, set_policy)
  const perms = [owner, a.policy, a.period, a.policyPermission, a.periodPermission, EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID];
  assert.deepEqual(buildInitPermissionInstruction({ owner, cardId, authorizer: key() }, PROGRAM).keys.map((k) => k.address), perms);
  assert.deepEqual(buildSetPolicyInstruction({ owner, cardId, policy: policyArgs() }, PROGRAM).keys.map((k) => k.address), perms);
  // OwnerCardEvent / FreezeCard / CloseCard
  assert.deepEqual(buildUnfreezeInstruction({ owner, cardId }, PROGRAM).keys.map((k) => [k.address, k.isWritable, k.isSigner]), [[owner, false, true], [a.policy, true, false], [a.period, true, false]]);
  assert.deepEqual(buildFreezeInstruction({ owner, cardId }, PROGRAM).keys.map((k) => [k.address, k.isWritable]), [[owner, false], [a.policy, true], [a.period, false]]);
  assert.deepEqual(buildCloseCardInstruction({ owner, cardId }, PROGRAM).keys.map((k) => k.address), [owner, a.binding, a.policy, a.period]);
  // DelegateCard: validator is an argument, not an account
  const delegate = buildDelegateCardInstruction({ owner, cardId, validator: DEVNET_TEE_VALIDATOR }, PROGRAM);
  assert.equal(delegate.keys.length, 13);
  assert.equal(delegate.keys.some((k) => k.address === DEVNET_TEE_VALIDATOR), false);
  assert.equal(delegate.keys[5].address, a.policy);
  assert.equal(delegate.keys[9].address, a.period);
});

test("review fixes: identifiers survive redaction, enforce fails closed, credits stay negative, wipe closes ephemerals", async () => {
  const { redactCardNumbers, parseSignedCents, buildWipeCardInstruction, cardPolicyView } = await import("../dist/index.js");
  const uuid = "550e8400-e29b-41d4-8716-446655440000";
  assert.equal(redactCardNumbers(uuid), uuid);
  assert.equal(redactCardNumbers("cpcap_v1_abc-1234567890123"), "cpcap_v1_abc-1234567890123");
  assert.equal(redactCardNumbers("id_1234567890123456"), "id_1234567890123456");
  assert.equal(redactCardNumbers("pay 4111-1111-1111-1111."), "pay [redacted].");
  const empty = await verifyTee({ mode: "enforce", provider: { verifyRpcIntegrity: async () => {} } });
  assert.equal(empty.ok, false);
  assert.equal(parseSignedCents("-1005"), -1005n);
  assert.equal(formatUsdCents("-1005"), "-$10.05");
  assert.throws(() => parseSignedCents("--5"), /cents/);
  assert.equal(cardPolicyView(policyFixture({ expiresAt: 9_223_372_036_854_775_807n })).expiresAt, "unix:9223372036854775807");
  const owner = key();
  const eph = [key(), key()];
  const ix = buildWipeCardInstruction({ owner, cardId: bytes(32, 1), ephemeralAccounts: eph }, PROGRAM);
  assert.equal(ix.keys.length, 9 + 4);
  assert.deepEqual(ix.keys.slice(9).map((k) => k.address), [eph[0], derivePermissionAddress(eph[0]), eph[1], derivePermissionAddress(eph[1])]);
});
