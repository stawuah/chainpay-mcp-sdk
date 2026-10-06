import type {
  CardActivityRow,
  CardPeriod,
  CardPolicyView,
  CardView,
  DisclosureBundle,
  FreezeResult,
  OpenStatementView,
  StatementState,
  StatementView,
  TeeRead,
} from "@chainpayhq/sdk";
import type { PrivateRepaymentAttempt, PrivateRepaymentResult } from "@chainpayhq/sdk/cards/private-repayment";

/*
 * Everything the Cards area needs, behind one interface. The live source wraps
 * the SDK's Axum client and TEE session; the fixture source (harness and
 * tests only) returns labeled illustrative data. Components never call the
 * SDK or the network directly, so every state renders without a backend.
 */

export type CardPrivateRead = {
  policy: TeeRead<CardPolicyView>;
  period: TeeRead<CardPeriod>;
};

export type RecoveryNumberKey = "budget" | "captured" | "reserved" | "refunded" | "purchases" | "exceptions" | "outstanding";
/** Every counter `restore` writes; Axum's report must show each one (key "exceptions" = exception debits this period). */
export const RECOVERY_NUMBER_KEYS: readonly RecoveryNumberKey[] = ["budget", "captured", "reserved", "refunded", "purchases", "exceptions", "outstanding"];

/** Exact numbers for an owner-assisted restore (contracts §8.2). */
export type RecoveryReport = {
  digest: string;
  detectedAt: string;
  reason: string;
  snapshotLedgerSeq: string;
  issuerEventsReplayed: number;
  /** Every value the restore will write, keyed so the signed values can be checked against what was shown. */
  numbers: { key: RecoveryNumberKey; label: string; cents?: string; count?: number }[];
  /** The card rules the restore writes, when ChainPay's report includes them (shown to the owner and compared before signing). */
  rules?: RecoveryRules;
};

/** Every rule `restore` writes besides the budget (that one is a reviewed number). Cents and seconds as decimal strings. */
export type RecoveryRules = {
  maxPurchaseCents: string;
  maxPurchasesPerPeriod: number;
  periodSeconds: number;
  currency: string;
  /** Lowercase hex. */
  merchantIdHashes: string[];
  mccs: number[];
  /** Unix seconds, "0" = no end date. */
  expiresAt: string;
  recurringAllowed: boolean;
  feeBps: number;
  /** ChainPay's approver key. */
  authorizer: string;
  periodIndex?: number;
};

export type CardRecoveryView = {
  state: "normal" | "recovery_frozen" | "restored_pending_reconcile";
  report?: RecoveryReport;
};

/** A shop a card can be limited to. Live: Axum's registry (`GET /v1/cards/merchants`); fixtures: the SDK's sandbox list. */
export type CardShop = { ref: string; displayName: string; mcc: number; merchantIdHash: string };

export type CardStatements = { closed: StatementView[]; open: OpenStatementView | null };

/** A cards-only agent connection, shown once: the token never comes back. */
export type CardAgentConnection = { id: string; agentName: string; token: string; mcpUrl: string; tools: string[] };

export type CreateCardInput = {
  label: string;
  budgetCents: string;
  maxPurchaseCents: string;
  maxPurchasesPerPeriod: number;
  periodDays: number;
  merchants: string[];
  mccs: number[];
  expiresAt: string | null;
  recurringAllowed: boolean;
  feeBps: number;
};

export type CreateStepId = "prepare" | "base" | "session" | "rules" | "activate";
export type CreateStepState = "waiting" | "active" | "done" | "failed";
export type CreateProgress = (step: CreateStepId, state: CreateStepState, detail?: string) => void;

export type ReadResult = {
  label: string;
  /** What the RPC literally answered, e.g. `value: null`. */
  raw: string;
  state: "visible" | "not_visible" | "rpc_error";
  summary?: string;
};

export type PrivacyCheckResult = {
  checkedAt: string;
  owner: ReadResult[];
  stranger: { wallet: string; reads: ReadResult[] };
  publicChain: { address: string; bytes: number; nonZeroAfterOwnerLink: number; preview: string; state: "empty" | "has_data" | "missing" | "rpc_error" };
  /**
   * TEE attestation from one fresh quote (sdk verifyTee). `verified` = Intel DCAP chain checked;
   * `challenge_bound` = the quote answered our challenge but its chain wasn't checked.
   */
  attestation: {
    hardware: "verified" | "challenge_bound" | "failed" | "not_checked";
    measurements: "matched" | "mismatch" | "pending" | "unavailable";
    label: string;
    /** Where the expected build values come from (shown next to a match or mismatch). */
    provenance?: string;
  };
};

export type RepaymentTarget = {
  /** Simulated partner's USDC token account on Devnet. */
  recipientTokenAccount: string | null;
  mint: string;
  decimals: number;
  cluster: "devnet";
  /** Set when ChainPay's statement and this dashboard disagree on where or in what to repay: nothing is paid. */
  conflict?: string;
};

/** What a cards-only agent connection may call. No freeze, unfreeze, limits, credit or repayment. */
export const CARD_AGENT_TOOLS = ["request_card_checkout", "get_card_activity", "get_statement", "prepare_agent_card"] as const;

/**
 * `confirmed`: the relay confirmed the repayment. `unknown`: the owner signed and it was handed
 * to the relay, but no answer came back, so it may have settled. Both carry the receipt it creates.
 */
export type RepaymentResult =
  | { outcome: "confirmed"; receiptPda: string; mandatePda: string; signature?: string }
  | { outcome: "unknown"; receiptPda: string; mandatePda: string; reason: string };

/**
 * Earlier repayments of one statement, across every spending permission (the receipt address
 * depends on the permission, so another permission would create a second, separate payment).
 * `paid`: a receipt exists on Solana. `unknown`: a signed attempt hasn't resolved yet.
 */
export type RepaymentLookup =
  | { state: "none" }
  | { state: "paid" | "unknown"; receiptPda: string; mandatePda: string };

/** MagicBlock Private Payments repayment (contracts §7.3). The payer is not verifiable; deposit and payout timing are public. */
export type PrivateRepayActions = {
  prepare: () => Promise<PrivateRepaymentAttempt>;
  check: (attempt: PrivateRepaymentAttempt) => Promise<PrivateRepaymentResult>;
  /** `onSigned` runs once the wallet has returned the signed private transfer, before it is sent. */
  pay: (attempt: PrivateRepaymentAttempt, onSigned: (signature: string) => void) => Promise<{ transferOutcome: "sent" | "unknown" }>;
  wait: (attempt: PrivateRepaymentAttempt) => Promise<PrivateRepaymentResult>;
};

export type ReaderMember = { pubkey: string; role: "owner" | "approver" | "reader" };

export interface CardsSource {
  readonly mode: "live" | "fixture";
  /** Cards API answered 404/501: the routes aren't deployed. */
  listCards(): Promise<CardView[]>;
  getCard(cardId: string): Promise<CardView>;
  activity(cardId: string): Promise<CardActivityRow[]>;
  statements(cardId: string): Promise<CardStatements>;
  /** Owner only: close the running statement now (interim close; the budget period is untouched). */
  closeStatement(cardId: string, operationId: string): Promise<void>;
  /** Shops a card can be limited to, with the allowlist hash the owner signs. */
  merchants(): Promise<CardShop[]>;
  /** Owner only: connect an agent that may check out with this card (and read its activity and statements). Never unfreeze, limits or repayment. */
  connectAgent(cardId: string, agentName: string): Promise<CardAgentConnection>;
  recovery(card: CardView): CardRecoveryView;
  /** Ask ChainPay to rebuild the recovery report (numbers to review) when the card has none yet. */
  requestRecoveryReport(card: CardView): Promise<void>;

  /** Opens the owner's private session (one message signature). */
  unlock(): Promise<void>;
  isUnlocked(): boolean;
  readPrivate(card: CardView): Promise<CardPrivateRead>;
  members(card: CardView, read: CardPrivateRead | undefined): ReaderMember[];

  /**
   * `attemptId` is stable across "Try again": a retry resumes the same card
   * (same Axum operation ids, finished steps skipped) instead of making a new one.
   */
  createCard(input: CreateCardInput, progress: CreateProgress, attemptId: string): Promise<string>;
  /**
   * Re-drive a card's persisted activation (same policy version): copy limits, read the
   * public proof back from Solana, open the card. Answers the state Axum actually reached.
   */
  finishActivation(card: CardView, operationId: string): Promise<CardView>;
  /** `operationId` is reused when the owner retries the same freeze. */
  freeze(cardId: string, reason: string, operationId: string): Promise<FreezeResult>;
  unfreeze(card: CardView, policyVersion: number, operationId: string): Promise<CardView>;
  addReader(card: CardView, pubkey: string): Promise<void>;
  removeReader(card: CardView, pubkey: string): Promise<void>;
  resolveException(card: CardView, row: CardActivityRow): Promise<void>;

  /** Where a statement is repaid: the statement's own instructions when ChainPay sent them, checked against this build. */
  repaymentTarget(statement?: StatementView): RepaymentTarget;
  /** The card's repay agent (card_policy PDA `["repay_agent", binding]`): the approved agent of a repayment permission. */
  repayAgent(card: CardView): string;
  /** Owner signs a one-payment ChainPay permission for this statement's amount, approved for the card's repay agent. */
  createRepaymentPermission(card: CardView, statement: StatementView): Promise<string>;
  /** card_policy `repay_statement`: the repay agent pays the statement through ChainPay `execute_payment` under `mandateAddress`. */
  payStatement(card: CardView, statement: StatementView, mandateAddress: string): Promise<RepaymentResult>;
  /** Has this statement been paid, or is an attempt unresolved, under any of these permissions? Throws when it can't tell. */
  repaymentStatus(statement: StatementView, mandateAddresses: string[]): Promise<RepaymentLookup>;
  submitRepayment(cardId: string, statementId: string, input: { receiptPda: string; mandatePda: string }): Promise<{ state: StatementState }>;
  /** Opt-in private repayment for one statement; null when ChainPay doesn't offer it for this statement. */
  privateRepay(card: CardView, statement: StatementView): PrivateRepayActions | null;

  restore(card: CardView, report: RecoveryReport): Promise<void>;
  confirmReconciled(card: CardView, report: RecoveryReport): Promise<void>;

  privacyCheck(card: CardView): Promise<PrivacyCheckResult>;
  /**
   * Owner only: a single-use Lithic embedded-card session. `embedUrl` is framed
   * as-is and never read by ChainPay code; null in fixtures (no card number exists).
   */
  cardNumberSession(cardId: string): Promise<{ embedUrl: string | null; expiresAt: string }>;
  /** Builds a disclosure bundle for the picked fields. */
  disclose(card: CardView, indices: number[]): Promise<DisclosureBundle>;
}

export class CardsNotEnabledError extends Error {
  constructor() {
    super("Cards aren't switched on for this workspace yet.");
    this.name = "CardsNotEnabledError";
  }
}

export function newOperationId(what: string): string {
  return `card-${what}-${globalThis.crypto.randomUUID()}`;
}

let override: CardsSource | null = null;

/** Harness and tests only: replace the live source with fixtures. */
export function setCardsSourceOverride(source: CardsSource | null) {
  override = source;
}

export function cardsSourceOverride(): CardsSource | null {
  return override;
}
