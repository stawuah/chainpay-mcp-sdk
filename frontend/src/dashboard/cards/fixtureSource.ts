import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  buildDisclosureBundle,
  buildRestoreInstruction,
  cardIdFromHex,
  CARD_POLICY_PROGRAM_ID,
  CARD_SANDBOX_MERCHANTS,
  cardPolicyView,
  commitmentRoot,
  formatUsdCents,
  MAGICBLOCK_DEVNET_TEE_MEASUREMENTS,
  merchantIdHash,
  type OpenStatementView,
  type CardActivityRow,
  type CardCommitment,
  type CardPeriod,
  type CardPolicy,
  type CardView,
  type RestoreArgs,
  type StatementView,
} from "@chainpayhq/sdk";
import { CARD_AGENT_TOOLS, LimitsNeededError, type CardPrivateRead, type CardRecoveryView, type CardsSource, type CreateCardInput, type PrivacyCheckResult, type ReaderMember, type RecoveryReport, type RepaymentLookup } from "./source";
import { assertCoSignedRestore, reviewedRestore } from "./signingGuards";

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
  /**
   * Activation state of the first card (audit R2): `proof_pending` limits copied, public
   * proof not on Solana yet, card paused; `opening` proof confirmed, card network not open
   * yet; `limits_failed` the card network refused the limits and still shows the card open.
   */
  activation?: "proof_pending" | "opening" | "limits_failed";
  /** Milliseconds each fake step waits (0 in tests). */
  delayMs?: number;
  /** Privacy-check attestation outcome to show (default: what the live Devnet check returned on 2026-10-04). */
  attestation?: "verified" | "challenge_bound" | "mismatch" | "failed";
  /** `unknown`: a statement repayment is signed but no answer comes back. */
  repay?: "unknown";
  /** `tampered`: ChainPay's co-signed restore changes rules the owner never reviewed (the real guard refuses it). */
  restore?: "tampered";
  /** `unreadable`: private reads fail with an RPC error. */
  reads?: "unreadable";
  /**
   * Adds a fourth card whose setup stopped before it was turned on: `base` one Solana
   * approval short, `limits` before the limits were saved, `saved` after they were.
   */
  setup?: "base" | "limits" | "saved";
};

const FIXTURE_PROVENANCE = MAGICBLOCK_DEVNET_TEE_MEASUREMENTS.provenance;
const FIXTURE_ATTESTATION: Record<NonNullable<CardsFixtureOptions["attestation"]>, PrivacyCheckResult["attestation"]> = {
  verified: { hardware: "verified", measurements: "matched", label: "Genuine TDX hardware and expected MagicBlock build verified (Devnet)", provenance: FIXTURE_PROVENANCE },
  challenge_bound: { hardware: "challenge_bound", measurements: "matched", label: "The private rollup answered a fresh challenge with MagicBlock's expected Devnet build. Intel's hardware signature wasn't checked here.", provenance: FIXTURE_PROVENANCE },
  mismatch: { hardware: "verified", measurements: "mismatch", label: "The private rollup is running a build that isn't MagicBlock's confirmed Devnet build, so approvals are paused", provenance: FIXTURE_PROVENANCE },
  failed: { hardware: "failed", measurements: "unavailable", label: "Couldn't confirm the private rollup runs on genuine secure hardware." },
};

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill)).toBase58();
export const FIXTURE_OWNER = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
// A real keypair, so the fixture restore can be co-signed and run through the real guard.
const AUTHORIZER_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(31));
const AUTHORIZER = AUTHORIZER_KEYPAIR.publicKey.toBase58();
const READER = key(33);
const STRANGER = key(77);
const SALT = new Uint8Array(32).fill(42);

export const FIXTURE_CARD_IDS = {
  data: "a1".repeat(32),
  research: "b2".repeat(32),
  travel: "c3".repeat(32),
  setup: "d4".repeat(32),
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

const ACTIVE_STEPS = { mirror: "acknowledged", rules: "retired", checkpoint: { seq: "5", state: "confirmed" }, commitment: "confirmed", issuer: "OPEN" };

/** The data card's activation fields: active by default, or one honest partial state. */
function dataActivation(state: CardsFixtureOptions["activation"]): Pick<CardView, "issuerState" | "mirror" | "commitment" | "activation"> {
  const mirror = { state: "acknowledged", acknowledgedAt: "2026-10-01T09:12:00Z", policyVersionMirrored: 2, allMerchantsMirrored: true };
  const confirmed = { seq: "5", root: "", slot: "412883104", state: "confirmed", checkpoint: "confirmed", policyVersion: 2, periodIndex: 2, source: "recorded" as const };
  switch (state) {
    case "proof_pending":
      return {
        issuerState: "PAUSED", mirror,
        commitment: { seq: "5", state: "pending", checkpoint: "scheduled", policyVersion: 2, periodIndex: 2, source: "recorded" },
        activation: { state: "pending_commitment", policyVersion: 2, steps: { mirror: "acknowledged", rules: "retired", checkpoint: { seq: "5", state: "scheduled" }, commitment: "pending", issuer: "pending" }, updatedAt: "2026-10-05T09:12:04Z" },
      };
    case "opening":
      return {
        issuerState: "PAUSED", mirror, commitment: confirmed,
        activation: { state: "issuer_pending", policyVersion: 2, steps: { ...ACTIVE_STEPS, issuer: "PAUSED" }, detail: "issuer_not_open", updatedAt: "2026-10-05T09:12:40Z" },
      };
    case "limits_failed":
      return {
        issuerState: "OPEN", mirror: { state: "failed", policyVersionMirrored: 2 },
        commitment: { ...confirmed, policyVersion: 1 },
        activation: { state: "mirror_failed", policyVersion: 2, steps: { mirror: "failed", rules: "pending", checkpoint: "pending", commitment: "pending", issuer: "OPEN" }, updatedAt: "2026-10-05T09:12:02Z" },
      };
    default:
      return { issuerState: "OPEN", mirror, commitment: confirmed, activation: { state: "active", policyVersion: 2, steps: ACTIVE_STEPS, completedAt: "2026-10-01T09:12:30Z" } };
  }
}

/** A card ChainPay issued whose setup stopped before activation: paused, nothing copied, no activation. */
function setupCard(saved: boolean): FixtureCard {
  const binding = key(14);
  return {
    binding,
    view: {
      cardId: FIXTURE_CARD_IDS.setup, label: "Crossmint", lastFour: "7256", issuerState: "PAUSED",
      mirror: { state: "pending" }, freeze: { onChain: false, issuer: "confirmed" }, recovery: { state: "normal" },
    },
    policy: saved
      ? policyFor(binding, { policyVersion: 1, budgetCents: 20_000n, maxPurchaseCents: 2_500n, statementOutstandingCents: 0n, exceptionsOpen: 0, members: [{ pubkey: FIXTURE_OWNER, flags: 15 }, { pubkey: AUTHORIZER, flags: 6 }] })
      : policyFor(binding, { policyVersion: 0, budgetCents: 0n, maxPurchaseCents: 0n, merchantIdHashes: [], mccs: [], statementOutstandingCents: 0n, exceptionsOpen: 0, members: [] }),
    period: periodFor({ capturedCents: 0n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 0, exceptionCents: 0n }),
  };
}

function buildCards(options: CardsFixtureOptions): FixtureCard[] {
  return options.setup ? [...baseCards(options), setupCard(options.setup === "saved")] : baseCards(options);
}

function baseCards(options: CardsFixtureOptions): FixtureCard[] {
  const data = key(11), research = key(12), travel = key(13);
  return [
    {
      binding: data,
      view: {
        cardId: FIXTURE_CARD_IDS.data, label: "Data API credits", lastFour: "4242",
        freeze: { onChain: false, issuer: "confirmed" },
        ...dataActivation(options.activation),
        recovery: { state: "normal" },
        // Axum's own check, as it serves it (`match`, report mode by default).
        attestation: { mode: "report", hardware: "verified", measurements: "match", checkedAt: "2026-10-04T10:12:00Z", label: "Genuine TDX hardware and allowlisted workload verified" },
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
        commitment: { seq: "3", root: "", slot: "412880511", state: "confirmed", policyVersion: 1, source: "recorded" },
        activation: { state: "active", policyVersion: 1, steps: { mirror: "acknowledged", rules: "retired", checkpoint: { seq: "3", state: "confirmed" }, commitment: "confirmed", issuer: "OPEN" } },
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
        commitment: { seq: "11", root: "", slot: "412870020", state: "confirmed", policyVersion: 4, source: "recorded" },
        activation: { state: "active", policyVersion: 4, steps: { mirror: "acknowledged", rules: "retired", checkpoint: { seq: "11", state: "confirmed" }, commitment: "confirmed", issuer: "OPEN" } },
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
  if (cardId === FIXTURE_CARD_IDS.setup) return [];
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
      { kind: "refund", amountCents: "-1299", feeCents: "-7", at: "2026-09-10T15:31:00Z", merchant: shop },
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

/** Running statement for the first card: what posted since the last close (never a due amount). */
function openStatementFor(cardId: string): OpenStatementView | null {
  if (cardId !== FIXTURE_CARD_IDS.data) return null;
  return {
    lineCount: 2,
    purchasesCents: "3399",
    refundsCents: "0",
    feeCents: "17",
    runningTotalCents: "3416",
    carriedCreditCents: "0",
    lines: [
      { kind: "purchase", amountCents: "1999", feeCents: "10", postedAt: "2026-10-03T17:05:00Z", merchant: shop },
      { kind: "purchase", amountCents: "1400", feeCents: "7", postedAt: "2026-10-02T11:30:00Z", merchant: { displayName: "Paper index" } },
    ],
  };
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
    { key: "exceptions", label: "Needs-review charges this period", cents: "0" },
    { key: "outstanding", label: "Owed on the statement", cents: "41467" },
  ],
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFixtureCardsSource(options: CardsFixtureOptions = {}): CardsSource & { commitmentFor(binding: string): Promise<CardCommitment | null> } {
  const cards = options.empty ? [] : buildCards(options);
  let unlocked = Boolean(options.unlocked);
  const delay = options.delayMs ?? 450;
  // The stopped card's setup, as far as it got.
  let setupBaseLeft = options.setup === "base" ? 1 : 0;
  let setupLimitsSaved = options.setup === "saved";
  const statements = new Map(cards.map((card) => [card.view.cardId, statementFor(card.view.cardId, options.statement ?? "closed")]));
  const activity = new Map(cards.map((card) => [card.view.cardId, activityFor(card.view.cardId)]));
  const openStatements = new Map(cards.map((card) => [card.view.cardId, openStatementFor(card.view.cardId)]));
  const find = (cardId: string) => {
    const card = cards.find((item) => item.view.cardId === cardId);
    if (!card) throw new Error("No card with that id in this workspace");
    return card;
  };
  const repayments = new Map<string, RepaymentLookup>();
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
    async statements(cardId) { await wait(delay / 3); return { closed: statements.get(cardId) ?? [], open: openStatements.get(cardId) ?? null }; },
    async closeStatement(cardId) {
      await wait(delay);
      const open = openStatements.get(cardId);
      if (!open || open.lineCount === 0) throw new Error("Nothing has posted since the last statement.");
      const list = statements.get(cardId) ?? [];
      const seq = list.length + 1;
      statements.set(cardId, [{
        statementId: `${cardId}:${String(seq).padStart(6, "0")}`, cardId, statementSeq: seq, periodIndex: 2, closeKind: "interim", state: "closed",
        closedAt: new Date().toISOString(), dueAt: new Date(Date.now() + 21 * 86_400_000).toISOString(),
        totalCents: open.runningTotalCents, feeCents: open.feeCents, amountDueCents: open.runningTotalCents, digest: FIXTURE_STATEMENT_DIGEST.replace(/^5f/, "6a"),
        lines: open.lines, simulatedCredit: true,
      }, ...list]);
      openStatements.set(cardId, { ...open, lineCount: 0, lines: [], purchasesCents: "0", feeCents: "0", runningTotalCents: "0" });
    },
    async merchants() {
      return Promise.all(CARD_SANDBOX_MERCHANTS.map(async (m) => ({ ref: m.ref, displayName: m.displayName, mcc: m.mcc, merchantIdHash: Array.from(await merchantIdHash(m.acceptorId), (b) => b.toString(16).padStart(2, "0")).join("") })));
    },
    async connectAgent(cardId, agentName) {
      find(cardId);
      await wait(delay);
      return { id: "fixture-connection-1", agentName: agentName.trim() || "Research agent", token: "cp_fixture_token_shown_once", mcpUrl: "https://chainpay-mcp.example/mcp", tools: [...CARD_AGENT_TOOLS] };
    },
    recovery(card): CardRecoveryView {
      const state = (card.recovery?.state ?? "normal") as CardRecoveryView["state"];
      return state === "normal" ? { state } : { state, report: RECOVERY_REPORT };
    },
    async requestRecoveryReport() { await wait(delay); },
    async unlock() { await wait(delay); unlocked = true; },
    isUnlocked() { return unlocked; },
    async readPrivate(card): Promise<CardPrivateRead> {
      const found = find(card.cardId);
      if (options.reads === "unreadable") { await wait(delay / 3); throw new Error("The private rollup didn't answer. Nothing was changed."); }
      if (!unlocked) return { policy: { state: "not_visible", slot: null }, period: { state: "not_visible", slot: null } };
      if (card.cardId === FIXTURE_CARD_IDS.setup && !setupLimitsSaved) return { policy: { state: "not_visible", slot: 412_883_200n }, period: { state: "not_visible", slot: 412_883_200n } };
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
    async setupProgress(card) {
      find(card.cardId);
      await wait(delay / 3);
      return { baseLeft: setupBaseLeft, rulesSaved: setupBaseLeft > 0 ? false : unlocked ? setupLimitsSaved : null };
    },
    async finishSetup(card, input, progress) {
      const found = find(card.cardId);
      progress("base", "active");
      for (; setupBaseLeft > 0; setupBaseLeft -= 1) {
        progress("base", "active", `Approval ${4 - setupBaseLeft} of 3`);
        await wait(delay);
      }
      progress("base", "done");
      progress("session", "active");
      if (!unlocked) { await wait(delay); unlocked = true; }
      progress("session", "done");
      progress("rules", "active");
      if (!setupLimitsSaved) {
        if (!input) throw new LimitsNeededError();
        await wait(delay);
        found.policy = { ...found.policy, policyVersion: 1, budgetCents: BigInt(input.budgetCents), maxPurchaseCents: BigInt(input.maxPurchaseCents), maxPurchasesPerPeriod: input.maxPurchasesPerPeriod, mccs: input.mccs, recurringAllowed: input.recurringAllowed, feeBps: input.feeBps, members: [{ pubkey: FIXTURE_OWNER, flags: 15 }, { pubkey: AUTHORIZER, flags: 6 }] };
        setupLimitsSaved = true;
      }
      progress("rules", "done");
      progress("activate", "active");
      await wait(delay);
      const on = dataActivation(undefined);
      found.view = {
        ...found.view, ...on,
        mirror: { ...on.mirror, policyVersionMirrored: 1 },
        commitment: on.commitment && { ...on.commitment, seq: "1", policyVersion: 1, periodIndex: 0 },
        activation: { state: "active", policyVersion: 1, steps: ACTIVE_STEPS, completedAt: new Date().toISOString() },
      };
      progress("activate", "done");
      return card.cardId;
    },
    async cardNumberSession(cardId) {
      find(cardId);
      await wait(delay / 3);
      return { embedUrl: null, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    async finishActivation(card) {
      const found = find(card.cardId);
      await wait(delay);
      if (found.view.activation?.state !== "mirror_failed") found.view = { ...found.view, ...dataActivation(undefined) };
      return found.view;
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
    repayAgent() {
      return "RepayAgentFixture111111111111111111111111111";
    },
    async createRepaymentPermission() {
      await wait(delay);
      return "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    },
    async payStatement(_card, statement, mandateAddress) {
      await wait(delay * 2);
      const receiptPda = "4RcptStatementFixture11111111111111111111";
      if (options.repay === "unknown") {
        repayments.set(statement.digest ?? statement.statementId, { state: "unknown", receiptPda, mandatePda: mandateAddress });
        return { outcome: "unknown", receiptPda, mandatePda: mandateAddress, reason: "No response from the relay (timed out after 90s), so this payment may have settled or may never have been sent." };
      }
      return { outcome: "confirmed", receiptPda, mandatePda: mandateAddress, signature: "FixtureRepaymentSignature" };
    },
    async repaymentStatus(statement) {
      await wait(delay / 3);
      return repayments.get(statement.digest ?? statement.statementId) ?? { state: "none" };
    },
    privateRepay() { return null; },
    async submitRepayment(cardId, statementId) {
      await wait(delay);
      const list = statements.get(cardId) ?? [];
      statements.set(cardId, list.map((item) => item.statementId === statementId ? { ...item, state: "repayment_observed", repayment: { receiptPda: "4RcptStatementFixture11111111111111111111", mandatePda: "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", verifiedAt: new Date().toISOString() } } : item));
      return { state: "repayment_observed" };
    },
    async restore(card, report) {
      const found = find(card.cardId);
      await wait(delay);
      // The same owner-side check the live source runs, on a co-signed restore built here.
      const reviewed = reviewedRestore(report, { policy: cardPolicyView(found.policy), period: found.period });
      const cardId = cardIdFromHex(card.cardId);
      const number = (k: string) => { const row = report.numbers.find((item) => item.key === k); return BigInt(row?.cents ?? String(row?.count ?? 0)); };
      const p = found.policy;
      const args: RestoreArgs = {
        policy: { budgetCents: number("budget"), maxPurchaseCents: p.maxPurchaseCents, maxPurchasesPerPeriod: p.maxPurchasesPerPeriod, periodSeconds: p.periodSeconds, currency: p.currency, merchantIdHashes: p.merchantIdHashes, mccs: p.mccs, expiresAt: p.expiresAt, recurringAllowed: p.recurringAllowed, feeBps: p.feeBps, authorizer: p.authorizer },
        periodIndex: found.period.periodIndex, capturedCents: number("captured"), reservedCents: number("reserved"), refundedCents: number("refunded"), purchasesCount: Number(number("purchases")),
        exceptionCents: number("exceptions"), statementOutstandingCents: number("outstanding"), ledgerHead: new Uint8Array(32).fill(9), ledgerSeq: BigInt(report.snapshotLedgerSeq) + 2n,
        reconDigest: Uint8Array.from(report.digest.match(/../g)!, (pair) => parseInt(pair, 16)),
      };
      if (options.restore === "tampered") args.policy = { ...args.policy, maxPurchaseCents: 500_000n, feeBps: 1_000, merchantIdHashes: [] };
      const ix = buildRestoreInstruction({ owner: FIXTURE_OWNER, cardId, authorizer: AUTHORIZER, restore: args }, CARD_POLICY_PROGRAM_ID);
      const tx = new Transaction({ feePayer: new PublicKey(FIXTURE_OWNER), recentBlockhash: "11111111111111111111111111111111" })
        .add(new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.address), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) }));
      tx.partialSign(AUTHORIZER_KEYPAIR);
      assertCoSignedRestore(Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), { owner: FIXTURE_OWNER, cardId, programId: CARD_POLICY_PROGRAM_ID, report, reviewed });
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
        attestation: FIXTURE_ATTESTATION[options.attestation ?? "verified"],
      };
    },
    async disclose(card, indices) {
      const found = find(card.cardId);
      return buildDisclosureBundle({ policy: found.policy, period: found.period, masterSalt: SALT, commitmentSeq: BigInt(found.view.commitment?.seq ?? "1"), indices });
    },
  };
}
