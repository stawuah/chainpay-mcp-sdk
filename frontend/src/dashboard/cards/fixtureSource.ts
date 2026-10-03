import { PublicKey } from "@solana/web3.js";
import {
  buildDisclosureBundle,
  cardPolicyView,
  commitmentRoot,
  DEVNET_TEE_VALIDATOR,
  formatUsdCents,
  type CardActivityRow,
  type CardCommitment,
  type CardPeriod,
  type CardPolicy,
  type CardView,
  type StatementView,
} from "@chainpay/sdk";
import type { CardPrivateRead, CardRecoveryView, CardsSource, CreateCardInput, PrivacyCheckResult, ReaderMember, RecoveryReport } from "./source";

/*
 * ILLUSTRATIVE fixture source for the design harness and tests. Never imported
 * by production code. Every view rendered from it carries the "Illustrative
 * data" banner. Nothing here signs, submits or reaches a network.
 */

export type CardsFixtureOptions = {
  empty?: boolean;
  /** Start with private details already shown. */
  unlocked?: boolean;
  /** Statement state for the first card. */
  statement?: StatementView["state"];
  /** Card network has acknowledged the freeze on the frozen card. */
  freezeAck?: boolean;
  /** Milliseconds each fake step waits (0 in tests). */
  delayMs?: number;
};

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill)).toBase58();
export const FIXTURE_OWNER = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const AUTHORIZER = key(31);
const READER = key(33);
const STRANGER = key(77);
const SALT = new Uint8Array(32).fill(42);

export const FIXTURE_CARD_IDS = {
  data: "a1".repeat(32),
  research: "b2".repeat(32),
  travel: "c3".repeat(32),
} as const;

type FixtureCard = { view: CardView; policy: CardPolicy; period: CardPeriod; binding: string };

function policyFor(binding: string, over: Partial<CardPolicy>): CardPolicy {
  return {
    binding, owner: FIXTURE_OWNER, authorizer: AUTHORIZER, policyVersion: 2,
    budgetCents: 50_000n, maxPurchaseCents: 3_000n, maxPurchasesPerPeriod: 40, periodSeconds: 2_592_000,
    currency: "USD", merchantIdHashes: [new Uint8Array(32).fill(7)], mccs: [5734, 7372],
    expiresAt: 0n, recurringAllowed: false, feeBps: 50, frozen: false, freezeReason: "none",
    recoveryState: "normal", statementOutstandingCents: 18_836n, exceptionsOpen: 1,
    members: [{ pubkey: FIXTURE_OWNER, flags: 15 }, { pubkey: AUTHORIZER, flags: 6 }, { pubkey: READER, flags: 6 }],
    ledgerHead: new Uint8Array(32).fill(9), ledgerSeq: 41n, commitSeq: 5n, bump: 254,
    ...over,
  };
}

function periodFor(over: Partial<CardPeriod>): CardPeriod {
  return {
    policy: key(40), periodIndex: 2, periodStart: 1_759_276_800n, periodEnd: 1_761_868_800n,
    capturedCents: 18_742n, reservedCents: 2_500n, refundedCents: 1_299n, purchasesCount: 9, exceptionCents: 1_150n, bump: 253,
    ...over,
  };
}

function buildCards(options: CardsFixtureOptions): FixtureCard[] {
  const data = key(11), research = key(12), travel = key(13);
  return [
    {
      binding: data,
      view: {
        cardId: FIXTURE_CARD_IDS.data, label: "Data API credits", lastFour: "4242", issuerState: "OPEN",
        mirror: { state: "acknowledged", acknowledgedAt: "2026-10-01T09:12:00Z", policyVersionMirrored: 2 },
        freeze: { onChain: false, issuer: "confirmed" },
        commitment: { seq: "5", root: "", slot: "412883104" },
        recovery: { state: "normal" },
      },
      policy: policyFor(data, {}),
      period: periodFor({}),
    },
    {
      binding: research,
      view: {
        cardId: FIXTURE_CARD_IDS.research, label: "Research subscriptions", lastFour: "1881", issuerState: options.freezeAck ? "PAUSED" : "OPEN",
        mirror: { state: "acknowledged", acknowledgedAt: "2026-09-30T16:40:00Z", policyVersionMirrored: 1 },
        freeze: { onChain: true, issuer: options.freezeAck ? "confirmed" : "pending_issuer_confirmation" },
        commitment: { seq: "3", root: "", slot: "412880511" },
        recovery: { state: "normal" },
      },
      policy: policyFor(research, { policyVersion: 1, budgetCents: 12_000n, maxPurchaseCents: 2_500n, recurringAllowed: true, frozen: true, freezeReason: "owner", statementOutstandingCents: 4_221n, exceptionsOpen: 0, members: [{ pubkey: FIXTURE_OWNER, flags: 15 }, { pubkey: AUTHORIZER, flags: 6 }] }),
      period: periodFor({ capturedCents: 4_200n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 3, exceptionCents: 0n }),
    },
    {
      binding: travel,
      view: {
        cardId: FIXTURE_CARD_IDS.travel, label: "Travel booking", lastFour: "0057", issuerState: "PAUSED",
        mirror: { state: "acknowledged", acknowledgedAt: "2026-09-28T08:00:00Z", policyVersionMirrored: 4 },
        freeze: { onChain: true, issuer: "confirmed" },
        commitment: { seq: "11", root: "", slot: "412870020" },
        recovery: { state: "recovery_frozen" },
      },
      policy: policyFor(travel, { policyVersion: 4, budgetCents: 200_000n, maxPurchaseCents: 60_000n, frozen: true, freezeReason: "recovery", recoveryState: "recovery_frozen", statementOutstandingCents: 0n, exceptionsOpen: 0 }),
      period: periodFor({ capturedCents: 0n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 0, exceptionCents: 0n }),
    },
  ];
}

const AGENT = "AgEnT111111111111111111111111111111111111111";
const shop = { displayName: "ChainPay demo shop", mcc: "5734" };
const data = (n: number) => `act-${String(n).padStart(3, "0")}`;

function activityFor(cardId: string): CardActivityRow[] {
  if (cardId !== FIXTURE_CARD_IDS.data) {
    return [
      { rowId: data(90), cardId, at: "2026-10-03T18:02:00Z", kind: "freeze" },
      { rowId: data(91), cardId, at: "2026-10-02T11:30:00Z", kind: "capture", lifecycle: "captured", amountCents: "1400", merchant: { displayName: "Paper index", mcc: "5942" }, agent: AGENT },
    ];
  }
  return [
    { rowId: data(1), cardId, at: "2026-10-03T21:14:00Z", kind: "authorization", lifecycle: "pending", amountCents: "1200", merchant: shop, agent: AGENT },
    { rowId: data(2), cardId, at: "2026-10-03T20:51:00Z", kind: "authorization", lifecycle: "reserved", amountCents: "2500", merchant: shop, agent: AGENT, intentId: "int-7f2a" },
    { rowId: data(3), cardId, at: "2026-10-03T17:05:00Z", kind: "capture", lifecycle: "captured", amountCents: "1999", merchant: shop, agent: AGENT },
    { rowId: data(4), cardId, at: "2026-10-03T12:40:00Z", kind: "capture", lifecycle: "partially_captured", amountCents: "1800", reservedCents: "3000", merchant: { displayName: "ChainPay demo shop", mcc: "7372" }, agent: AGENT },
    { rowId: data(5), cardId, at: "2026-10-02T22:10:00Z", kind: "reversal", lifecycle: "reversed", amountCents: "2200", merchant: shop, agent: AGENT },
    { rowId: data(6), cardId, at: "2026-10-02T15:31:00Z", kind: "refund", lifecycle: "refunded", amountCents: "1299", merchant: shop, agent: AGENT },
    { rowId: data(7), cardId, at: "2026-10-02T09:02:00Z", kind: "dispute", lifecycle: "captured", amountCents: "2750", merchant: shop, agent: AGENT },
    { rowId: data(8), cardId, at: "2026-10-01T19:44:00Z", kind: "exception", lifecycle: "forced_capture", exception: "forced_capture", amountCents: "1150", merchant: { displayName: "Unlisted test shop", mcc: "5999" }, needsReview: true },
    { rowId: data(9), cardId, at: "2026-10-01T14:20:00Z", kind: "authorization", lifecycle: "declined", declineReason: "merchant_not_allowed", amountCents: "900", merchant: { displayName: "Unlisted test shop", mcc: "5999" }, agent: AGENT },
    { rowId: data(10), cardId, at: "2026-10-01T10:05:00Z", kind: "authorization", lifecycle: "declined", declineReason: "over_max", amountCents: "4500", merchant: shop, agent: AGENT },
    { rowId: data(11), cardId, at: "2026-09-30T23:58:00Z", kind: "authorization", lifecycle: "ambiguous", amountCents: "1600", merchant: shop, agent: AGENT },
    { rowId: data(12), cardId, at: "2026-09-30T08:15:00Z", kind: "capture", lifecycle: "late_capture", amountCents: "640", merchant: shop, agent: AGENT },
    { rowId: data(13), cardId, at: "2026-09-29T07:00:00Z", kind: "authorization", lifecycle: "expired", amountCents: "1000", merchant: shop, agent: AGENT },
    { rowId: data(14), cardId, at: "2026-09-28T12:00:00Z", kind: "policy_change" },
  ];
}

export const FIXTURE_STATEMENT_DIGEST = "5f1c0e9b8a7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605f4e3";

function statementFor(cardId: string, state: StatementView["state"]): StatementView[] {
  if (cardId !== FIXTURE_CARD_IDS.data) return [];
  return [{
    statementId: `stmt:${cardId}:1`,
    cardId,
    periodIndex: 1,
    state,
    closedAt: "2026-10-01T00:00:00Z",
    dueAt: "2026-10-22T00:00:00Z",
    totalCents: "18836",
    feeCents: "95",
    digest: FIXTURE_STATEMENT_DIGEST,
    lines: [
      { kind: "purchase", amountCents: "1999", feeCents: "10", at: "2026-09-29T17:05:00Z", merchant: shop },
      { kind: "purchase", amountCents: "12850", feeCents: "65", at: "2026-09-21T11:12:00Z", merchant: { displayName: "ChainPay demo shop", mcc: "7372" } },
      { kind: "purchase", amountCents: "2750", feeCents: "14", at: "2026-09-18T09:02:00Z", merchant: shop },
      { kind: "purchase", amountCents: "1150", feeCents: "6", at: "2026-09-12T19:44:00Z", merchant: { displayName: "Unlisted test shop", mcc: "5999" }, exception: "forced_capture" },
      { kind: "refund", amountCents: "1299", feeCents: "-7", at: "2026-09-10T15:31:00Z", merchant: shop },
      { kind: "adjustment_debit", amountCents: "1291", feeCents: "7", at: "2026-09-05T08:00:00Z" },
    ],
    repayment: state === "repayment_mismatch"
      ? { receiptPda: "3Rcpt2v2SnapshotFixture111111111111111111", mandatePda: "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mismatch: ["amount", "reference"] }
      : ["repayment_observed", "partner_confirmed", "discharged"].includes(state)
        ? { receiptPda: "4RcptStatementFixture11111111111111111111", mandatePda: "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", verifiedAt: "2026-10-04T10:00:00Z" }
        : undefined,
    partner: ["partner_confirmed", "discharged"].includes(state) ? { confirmedAt: "2026-10-04T10:02:00Z", ref: "sim-partner-0042" } : undefined,
    simulatedCredit: true,
  }];
}

const RECOVERY_REPORT: RecoveryReport = {
  digest: "8e1f4a0c9d2b7e6f5a4c3b2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f",
  detectedAt: "2026-10-03T06:41:00Z",
  reason: "The private records stopped answering for this card.",
  snapshotLedgerSeq: "118",
  issuerEventsReplayed: 2,
  numbers: [
    { key: "budget", label: "Budget per period", cents: "200000" },
    { key: "captured", label: "Charged this period", cents: "41260" },
    { key: "reserved", label: "Held right now", cents: "0" },
    { key: "refunded", label: "Refunded this period", cents: "0" },
    { key: "purchases", label: "Purchases this period", count: 3 },
    { key: "outstanding", label: "Owed on the statement", cents: "41467" },
  ],
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFixtureCardsSource(options: CardsFixtureOptions = {}): CardsSource & { commitmentFor(binding: string): Promise<CardCommitment | null> } {
  const cards = options.empty ? [] : buildCards(options);
  let unlocked = Boolean(options.unlocked);
  const delay = options.delayMs ?? 450;
  const statements = new Map(cards.map((card) => [card.view.cardId, statementFor(card.view.cardId, options.statement ?? "closed")]));
  const activity = new Map(cards.map((card) => [card.view.cardId, activityFor(card.view.cardId)]));
  const find = (cardId: string) => {
    const card = cards.find((item) => item.view.cardId === cardId);
    if (!card) throw new Error("No card with that id in this workspace");
    return card;
  };
  const commitments = new Map<string, Promise<CardCommitment>>();
  const commitmentFor = async (binding: string): Promise<CardCommitment | null> => {
    const card = cards.find((item) => item.binding === binding);
    if (!card) return null;
    if (!commitments.has(binding)) {
      commitments.set(binding, commitmentRoot(card.policy, card.period, SALT).then((root) => ({
        binding, seq: BigInt(card.view.commitment?.seq ?? "1"), root, policyVersion: card.policy.policyVersion, periodIndex: card.period.periodIndex, writtenSlot: BigInt(card.view.commitment?.slot ?? "0"), bump: 255,
      })));
    }
    return commitments.get(binding)!;
  };

  return {
    mode: "fixture",
    commitmentFor,
    async listCards() { await wait(delay / 3); return cards.map((card) => card.view); },
    async getCard(cardId) { return find(cardId).view; },
    async activity(cardId) { await wait(delay / 3); return activity.get(cardId) ?? []; },
    async statements(cardId) { await wait(delay / 3); return statements.get(cardId) ?? []; },
    recovery(card): CardRecoveryView {
      const state = (card.recovery?.state ?? "normal") as CardRecoveryView["state"];
      return state === "normal" ? { state } : { state, report: RECOVERY_REPORT };
    },
    async unlock() { await wait(delay); unlocked = true; },
    isUnlocked() { return unlocked; },
    async readPrivate(card): Promise<CardPrivateRead> {
      const found = find(card.cardId);
      if (!unlocked) return { policy: { state: "not_visible", slot: null }, period: { state: "not_visible", slot: null } };
      return {
        policy: { state: "visible", slot: 412_883_200n, account: cardPolicyView(found.policy) },
        period: { state: "visible", slot: 412_883_200n, account: found.period },
      };
    },
    members(card): ReaderMember[] {
      return find(card.cardId).policy.members.map((member) => ({
        pubkey: member.pubkey,
        role: member.pubkey === FIXTURE_OWNER ? "owner" : member.pubkey === AUTHORIZER ? "approver" : "reader",
      }));
    },
    async createCard(_input: CreateCardInput, progress, _attemptId: string) {
      for (const step of ["prepare", "base", "session", "rules", "activate"] as const) {
        progress(step, "active");
        await wait(delay);
        progress(step, "done");
      }
      unlocked = true;
      return FIXTURE_CARD_IDS.data;
    },
    async freeze(cardId) {
      const card = find(cardId);
      await wait(delay);
      card.view = { ...card.view, freeze: { onChain: true, issuer: "pending_issuer_confirmation" } };
      card.policy = { ...card.policy, frozen: true, freezeReason: "owner" };
      return { freezeOperationId: "fixture-freeze-1", onChain: "submitted", issuer: "pending_issuer_confirmation" };
    },
    async unfreeze(card) {
      const found = find(card.cardId);
      await wait(delay);
      found.view = { ...found.view, freeze: { onChain: false, issuer: "confirmed" }, issuerState: "OPEN" };
      found.policy = { ...found.policy, frozen: false, freezeReason: "none" };
      return found.view;
    },
    async addReader(card, pubkey) {
      const found = find(card.cardId);
      new PublicKey(pubkey);
      await wait(delay);
      found.policy = { ...found.policy, members: [...found.policy.members, { pubkey, flags: 6 }] };
    },
    async removeReader(card, pubkey) {
      const found = find(card.cardId);
      await wait(delay);
      found.policy = { ...found.policy, members: found.policy.members.filter((member) => member.pubkey !== pubkey) };
    },
    async resolveException(card, row) {
      await wait(delay);
      activity.set(card.cardId, (activity.get(card.cardId) ?? []).map((item) => item.rowId === row.rowId ? { ...item, needsReview: false, exception: undefined, kind: "capture", lifecycle: "captured" } : item));
      const found = find(card.cardId);
      found.policy = { ...found.policy, exceptionsOpen: Math.max(0, found.policy.exceptionsOpen - 1) };
    },
    repaymentTarget() {
      return { recipientTokenAccount: "SimPartnerUsdc11111111111111111111111111111", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, cluster: "devnet" };
    },
    async payStatement(_card, _statement, mandateAddress) {
      await wait(delay * 2);
      return { receiptPda: "4RcptStatementFixture11111111111111111111", mandatePda: mandateAddress, signature: "FixtureRepaymentSignature" };
    },
    async submitRepayment(cardId, statementId) {
      await wait(delay);
      const list = statements.get(cardId) ?? [];
      statements.set(cardId, list.map((item) => item.statementId === statementId ? { ...item, state: "repayment_observed", repayment: { receiptPda: "4RcptStatementFixture11111111111111111111", mandatePda: "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", verifiedAt: new Date().toISOString() } } : item));
      return { state: "repayment_observed" };
    },
    async restore(card) {
      const found = find(card.cardId);
      await wait(delay);
      found.view = { ...found.view, recovery: { state: "restored_pending_reconcile" } };
    },
    async confirmReconciled(card) {
      const found = find(card.cardId);
      await wait(delay);
      found.view = { ...found.view, recovery: { state: "normal" } };
      found.policy = { ...found.policy, recoveryState: "normal" };
    },
    async privacyCheck(card): Promise<PrivacyCheckResult> {
      const found = find(card.cardId);
      await wait(delay * 2);
      const view = cardPolicyView(found.policy);
      return {
        checkedAt: "2026-10-04T10:15:00Z",
        owner: [
          { label: "Card rules", state: "visible", raw: `value: { owner: …, data: [${695} bytes] }`, summary: `Budget ${formatUsdCents(view.budgetCents)} · version ${view.policyVersion}` },
          { label: "This period", state: "visible", raw: "value: { owner: …, data: [95 bytes] }", summary: `Charged ${formatUsdCents(found.period.capturedCents)}` },
        ],
        stranger: {
          wallet: STRANGER,
          reads: [
            { label: "Card rules", state: "not_visible", raw: "value: null" },
            { label: "This period", state: "not_visible", raw: "value: null" },
          ],
        },
        publicChain: { address: key(41), bytes: 695, nonZeroAfterOwnerLink: 0, preview: "card + owner link, then 623 zero bytes", state: "empty" },
        attestation: { hardware: "verified", measurements: "pending", label: `Validator ${DEVNET_TEE_VALIDATOR.slice(0, 4)}…` },
      };
    },
    async disclose(card, indices) {
      const found = find(card.cardId);
      return buildDisclosureBundle({ policy: found.policy, period: found.period, masterSalt: SALT, commitmentSeq: BigInt(found.view.commitment?.seq ?? "1"), indices });
    },
  };
}
