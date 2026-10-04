import type { CardPolicyErrorName } from "./constants.js";
import { cardPolicyErrorName } from "./constants.js";

/*
 * ReceiptCard evidence union (contracts.md §9). Card kinds can never render
 * the SPL settlement layout or claim "settled on Solana". There is no single
 * `paid` flag: chain, issuer and statement state stay separate.
 */

export type CardDeclineReason =
  | "frozen"
  | "merchant_not_allowed"
  | "over_budget"
  | "over_max"
  | "velocity"
  | "intent_missing"
  | "internal";

export type CardMerchantView = { displayName: string; mcc: string };

export type SplSettlementEvidence = { kind: "spl_settlement"; receiptPda: string };

export type CardAuthorizationEvidence = {
  kind: "card_authorization";
  cardId: string;
  intentId: string;
  merchant: CardMerchantView;
  amountCents: string;
  currency: "USD";
  reservationState: "reserved" | "declined" | "ambiguous";
  decision: "approved" | "declined";
  declineReason?: CardDeclineReason;
  at: string;
  private: true;
};

export type CardCaptureLifecycle =
  | "captured"
  | "partially_captured"
  | "reversed"
  | "expired"
  | "late_capture"
  | "refunded"
  | "forced_capture";

export type CardCaptureEvidence = {
  kind: "card_capture";
  cardId: string;
  authId: string;
  merchant: CardMerchantView;
  capturedCents: string;
  reservedCents: string;
  lifecycle: CardCaptureLifecycle;
  exception?: "forced_capture" | "over_capture" | "unpaired_capture";
  commitment?: { seq: string; root: string; slot: string };
  private: true;
};

export type StatementRepaymentState = "repayment_observed" | "partner_confirmed" | "discharged" | "repayment_mismatch";

export type StatementRepaymentEvidence = {
  kind: "statement_repayment";
  cardId: string;
  statementId: string;
  statementDigest: string;
  totalCents: string;
  receiptPda: string;
  repaymentState: StatementRepaymentState;
  simulatedCredit: true;
};

export type CardEvidence = CardAuthorizationEvidence | CardCaptureEvidence | StatementRepaymentEvidence;
export type ReceiptEvidence = SplSettlementEvidence | CardEvidence;
export type ReceiptEvidenceKind = ReceiptEvidence["kind"];

export const CARD_EVIDENCE_KINDS = ["card_authorization", "card_capture", "statement_repayment"] as const;

export function isCardEvidence(evidence: ReceiptEvidence): evidence is CardEvidence {
  return (CARD_EVIDENCE_KINDS as readonly string[]).includes(evidence.kind);
}

/** Only `spl_settlement` may use the on-chain settlement layout and wording. */
export function mayRenderAsSplSettlement(evidence: ReceiptEvidence): boolean {
  return evidence.kind === "spl_settlement";
}

/** Reservation lifecycle (contracts.md §4.1). `pending` and `ambiguous` are off-chain only. */
export type CardReservationLifecycle =
  | "pending"
  | "reserved"
  | "captured"
  | "partially_captured"
  | "reversed"
  | "expired"
  | "declined"
  | "ambiguous";

/** Statement lifecycle (contracts.md §4.2). Every statement is simulated credit. */
export type StatementState =
  | "open"
  | "closed"
  | "repayment_observed"
  | "partner_confirmed"
  | "discharged"
  | "repayment_mismatch"
  | "overdue";

export type AsaResult = "APPROVED" | "CARD_PAUSED" | "UNAUTHORIZED_MERCHANT" | "INSUFFICIENT_FUNDS" | "VELOCITY_EXCEEDED" | "SUSPECTED_FRAUD";

const DECLINES: Partial<Record<CardPolicyErrorName, { asa: AsaResult; reason: CardDeclineReason }>> = {
  CardFrozen: { asa: "CARD_PAUSED", reason: "frozen" },
  RecoveryFrozen: { asa: "CARD_PAUSED", reason: "frozen" },
  PolicyExpired: { asa: "CARD_PAUSED", reason: "frozen" },
  MerchantMismatch: { asa: "UNAUTHORIZED_MERCHANT", reason: "merchant_not_allowed" },
  MerchantNotAllowed: { asa: "UNAUTHORIZED_MERCHANT", reason: "merchant_not_allowed" },
  MccNotAllowed: { asa: "UNAUTHORIZED_MERCHANT", reason: "merchant_not_allowed" },
  CurrencyMismatch: { asa: "UNAUTHORIZED_MERCHANT", reason: "merchant_not_allowed" },
  RecurringNotAllowed: { asa: "UNAUTHORIZED_MERCHANT", reason: "merchant_not_allowed" },
  IntentInvalid: { asa: "UNAUTHORIZED_MERCHANT", reason: "intent_missing" },
  IntentExpired: { asa: "UNAUTHORIZED_MERCHANT", reason: "intent_missing" },
  IntentStale: { asa: "UNAUTHORIZED_MERCHANT", reason: "intent_missing" },
  BudgetExceeded: { asa: "INSUFFICIENT_FUNDS", reason: "over_budget" },
  AmountExceedsIntent: { asa: "INSUFFICIENT_FUNDS", reason: "over_max" },
  AmountExceedsMax: { asa: "INSUFFICIENT_FUNDS", reason: "over_max" },
  VelocityExceeded: { asa: "VELOCITY_EXCEEDED", reason: "velocity" },
};

/** Map a program error code to the ASA decision and the receipt decline reason (contracts.md §3.1). */
export function declineForProgramError(code: number): { asa: AsaResult; reason: CardDeclineReason } {
  const name = cardPolicyErrorName(code);
  return (name && DECLINES[name]) || { asa: "SUSPECTED_FRAUD", reason: "internal" };
}

/** Plain-language decline copy for owners and agents. Never reveals the limit itself. */
export const DECLINE_COPY: Record<CardDeclineReason, string> = {
  frozen: "The card is frozen, so the purchase was declined.",
  merchant_not_allowed: "This shop isn't on the card's list.",
  over_budget: "This purchase would go over what's left this period.",
  over_max: "This purchase is bigger than the card allows in one go.",
  velocity: "The card has hit its number of purchases for this period.",
  intent_missing: "No matching checkout was opened for this purchase.",
  internal: "ChainPay couldn't confirm this purchase in time, so it was declined.",
};
