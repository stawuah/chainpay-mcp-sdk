import type { CardActivityRow, CardView, IssuerFreezeState } from "@chainpayhq/sdk";
import { DECLINE_COPY } from "@chainpayhq/sdk";
import type { StatusIcon, StatusProps, StatusTone } from "../../ui/workspace/Status";

/*
 * Plain words for every card state (ruling K8). Each state has its own label
 * and icon, so nothing depends on color alone. `key` keeps the contract name
 * (contracts §4.1) for tests and data attributes.
 */

export type PillTone = "neutral" | "info" | "positive" | "warning" | "danger";
export type PillIcon = "clock" | "hold" | "check" | "half" | "undo" | "hourglass" | "late" | "refund" | "flag" | "alert" | "x" | "help" | "snow" | "lock" | "dot";

export type StatePill = { key: string; label: string; tone: PillTone; icon: PillIcon; detail?: string };

export const LIFECYCLE_PILLS: Record<string, StatePill> = {
  pending: { key: "pending", label: "Checking", tone: "neutral", icon: "clock", detail: "Waiting for the card's private rules to answer." },
  reserved: { key: "reserved", label: "Held", tone: "info", icon: "hold", detail: "Approved. The money is held until the shop charges it." },
  captured: { key: "captured", label: "Charged", tone: "positive", icon: "check", detail: "The shop charged the full amount." },
  partially_captured: { key: "partially_captured", label: "Partly charged", tone: "positive", icon: "half", detail: "The shop charged part of the hold. The rest stays held until it's charged or released." },
  reversed: { key: "reversed", label: "Released", tone: "neutral", icon: "undo", detail: "The hold was released. Nothing was charged." },
  expired: { key: "expired", label: "Expired", tone: "neutral", icon: "hourglass", detail: "The hold ran out before the shop charged it." },
  late_capture: { key: "late_capture", label: "Late charge", tone: "warning", icon: "late", detail: "The shop charged after the hold ended. It still counts toward the budget." },
  refunded: { key: "refunded", label: "Refunded", tone: "info", icon: "refund", detail: "Money came back to the card. Refunds lower what you owe, not what you've spent this period." },
  forced_capture: { key: "forced_capture", label: "Needs review", tone: "warning", icon: "flag", detail: "The shop charged without an approval. It's counted, flagged and never treated as approved." },
  declined: { key: "declined", label: "Declined", tone: "danger", icon: "x" },
  ambiguous: { key: "ambiguous", label: "Unconfirmed", tone: "warning", icon: "help", detail: "Declined while ChainPay confirms with the card network. Nothing is released until it's confirmed." },
};

export const DISPUTE_PILL: StatePill = { key: "disputed", label: "Disputed", tone: "warning", icon: "alert", detail: "A dispute is open. Any money back arrives as a refund." };
export const EXCEPTION_PILL: StatePill = { key: "exception", label: "Needs review", tone: "warning", icon: "flag" };

const EXCEPTION_COPY: Record<string, string> = {
  forced_capture: "Charged without an approval.",
  over_capture: "Charged more than the approved amount.",
  unpaired_capture: "A charge arrived with no matching purchase.",
};

const KIND_PILLS: Partial<Record<CardActivityRow["kind"], StatePill>> = {
  freeze: { key: "freeze", label: "Frozen", tone: "neutral", icon: "snow" },
  unfreeze: { key: "unfreeze", label: "Unfrozen", tone: "neutral", icon: "check" },
  policy_change: { key: "policy_change", label: "Limits saved", tone: "neutral", icon: "lock" },
  repayment: { key: "repayment", label: "Statement paid", tone: "positive", icon: "check" },
  reversal: LIFECYCLE_PILLS.reversed,
  refund: LIFECYCLE_PILLS.refunded,
  dispute: DISPUTE_PILL,
};

/** The pills one activity row shows: its state, plus a dispute or review overlay when present. */
export function activityPills(row: CardActivityRow): StatePill[] {
  const pills: StatePill[] = [];
  if (row.needsReview !== false && (row.kind === "exception" || row.exception)) {
    const detail = (row.exception && EXCEPTION_COPY[row.exception]) || "Flagged for your review.";
    pills.push({ ...EXCEPTION_PILL, key: "exception", detail });
  }
  const base = row.lifecycle ? LIFECYCLE_PILLS[row.lifecycle] : KIND_PILLS[row.kind];
  if (base && !(base.key === "forced_capture" && pills.length)) {
    pills.unshift(base.key === "declined" && row.declineReason ? { ...base, detail: DECLINE_COPY[row.declineReason] } : base);
  }
  if (row.kind === "dispute" && !pills.some((pill) => pill.key === "disputed")) pills.push(DISPUTE_PILL);
  if (!pills.length) pills.push({ key: row.kind, label: "Recorded", tone: "neutral", icon: "dot" });
  return pills;
}

/** An exception is never approved, whatever else the row says. */
export function rowNeedsReview(row: CardActivityRow): boolean {
  // Axum marks a resolved exception needsReview:false; only then is it no longer open.
  if (row.needsReview === false) return false;
  return row.kind === "exception" || Boolean(row.exception) || row.needsReview === true || row.lifecycle === "forced_capture";
}

export const ACTIVITY_TITLES: Record<CardActivityRow["kind"], string> = {
  authorization: "Purchase",
  capture: "Charge",
  reversal: "Hold released",
  refund: "Refund",
  dispute: "Dispute",
  exception: "Charge to review",
  freeze: "Card frozen",
  unfreeze: "Card unfrozen",
  policy_change: "Limits saved",
  repayment: "Statement payment",
};

export type CardStatusPill = StatePill & {
  key: "active" | "frozen" | "freeze_pending" | "needs_restore" | "setting_up" | "freeze_failed" | "proof_pending" | "opening" | "limits_failed" | "needs_activation";
};

/** The public commitment read back from Solana and matched to what ChainPay scheduled. A scheduled checkpoint is not this. */
export function commitmentConfirmed(card: CardView): boolean {
  if (card.commitment?.state !== "confirmed") return false;
  // A proof of older limits doesn't prove the limits being turned on.
  const wanted = card.activation?.policyVersion;
  const proven = card.commitment.policyVersion;
  return wanted === undefined || proven === undefined || proven === wanted;
}

/** What each part of turning a card on has actually reached (audit R2). Shown as lines while the card isn't fully on. */
export type ActivationLine = { key: "limits" | "proof" | "issuer"; state: "done" | "pending" | "failed" | "unknown"; text: string };

export function activationLines(card: CardView): ActivationLine[] {
  const steps = card.activation?.steps;
  const mirrorFailed = card.activation?.state === "mirror_failed" || card.mirror.state === "failed";
  const limits: ActivationLine = card.mirror.state === "acknowledged" && !mirrorFailed
    ? { key: "limits", state: "done", text: card.mirror.allMerchantsMirrored === false ? "Limits copied to the card network. Some allowed shops aren't in its shop lock; ChainPay still checks every purchase against your full list." : "Limits copied to the card network." }
    : mirrorFailed
      ? { key: "limits", state: "failed", text: "The card network didn't take the limits." }
      : { key: "limits", state: "pending", text: "Copying limits to the card network." };
  const proof: ActivationLine = commitmentConfirmed(card)
    ? { key: "proof", state: "done", text: `Public proof on Solana${card.commitment?.seq ? ` (checkpoint #${card.commitment.seq})` : ""}.` }
    : card.commitment?.state === "confirmed"
      ? { key: "proof", state: "pending", text: "The public proof on Solana is for the previous limits. The new one isn't there yet." }
      : card.commitment?.state === "mismatch"
        ? { key: "proof", state: "pending", text: "The proof on Solana doesn't match these limits yet. ChainPay is writing a new one." }
        : { key: "proof", state: "pending", text: "Public proof isn't on Solana yet." };
  const issuerStep = typeof steps?.issuer === "string" ? steps.issuer : "";
  const issuer: ActivationLine = card.issuerState === "OPEN"
    ? { key: "issuer", state: "done", text: "Card network: open." }
    : issuerStep === "unknown"
      ? { key: "issuer", state: "unknown", text: "Card network: ChainPay couldn't read the card's state. Freeze it to be sure." }
      : card.activation?.detail === "new_activation_disabled"
        ? { key: "issuer", state: "pending", text: "Card network: paused. New cards are switched off on ChainPay right now." }
        : limits.state === "done" && proof.state === "done"
          ? { key: "issuer", state: "pending", text: `Card network: ${card.issuerState === "PAUSED" ? "still paused" : "not open yet"}. ChainPay is asking it to open the card.` }
          : { key: "issuer", state: "pending", text: card.issuerState === "PAUSED" ? "Card network: paused until the steps above are done." : "Card network: waiting to open." };
  return [limits, proof, issuer];
}

/** One status per card (ruling K2). Recovery outranks freeze; freeze is "pending" until the card network confirms.
 *  Active needs all three: the card network shows it open, the limits were copied for this policy, and the
 *  public proof read back from Solana. Anything less is shown as the partial state it is. */
export function cardStatus(card: CardView): CardStatusPill {
  const recovery = typeof card.recovery?.state === "string" ? card.recovery.state : "normal";
  if (recovery === "recovery_frozen" || recovery === "restored_pending_reconcile") {
    return { key: "needs_restore", label: "Needs restore", tone: "warning", icon: "alert" };
  }
  if (card.freeze.onChain) {
    if (card.freeze.issuer === "pending_issuer_confirmation") return { key: "freeze_pending", label: "Freeze pending", tone: "info", icon: "clock" };
    if (card.freeze.issuer === "failed") return { key: "freeze_failed", label: "Freeze not confirmed", tone: "danger", icon: "alert" };
    return { key: "frozen", label: "Frozen", tone: "neutral", icon: "snow" };
  }
  const activation = card.activation?.state;
  const open = card.issuerState === "OPEN";
  const mirrored = card.mirror.state === "acknowledged";
  const proof = commitmentConfirmed(card);
  if (activation === "mirror_failed" || card.mirror.state === "failed") {
    return {
      key: "limits_failed", label: "Limits not copied", tone: "danger", icon: "alert",
      detail: open
        ? "The card network didn't take the new limits and still shows this card open. Freeze it, then turn it on again."
        : card.activation?.steps?.issuer === "unknown"
          ? "The card network didn't take the limits, and ChainPay couldn't read the card's state. Freeze it to be sure, then try again."
          : "The card network didn't take the limits. Try turning the card on again.",
    };
  }
  if (activation === "superseded") {
    return { key: "needs_activation", label: "Needs turning on", tone: "warning", icon: "alert", detail: "The limits changed after this card was turned on. Turn it on again to copy the new limits." };
  }
  if (open && mirrored && proof && (!activation || activation === "active")) {
    return { key: "active", label: "Active", tone: "positive", icon: "check" };
  }
  if (mirrored && !proof) {
    return {
      key: "proof_pending", label: "Proof pending", tone: "info", icon: "clock",
      detail: open
        ? "Open with its limits copied. The public proof of these limits isn't on Solana yet."
        : "Limits copied. The card opens once its public proof is on Solana.",
    };
  }
  if (mirrored && proof && !open) {
    return {
      key: "opening", label: "Opening", tone: "info", icon: "clock",
      detail: card.activation?.detail === "new_activation_disabled"
        ? "The public proof is on Solana, but new cards are switched off on ChainPay right now, so this one stays paused."
        : "The public proof is on Solana. Waiting for the card network to open the card.",
    };
  }
  return { key: "setting_up", label: "Setting up", tone: "neutral", icon: "clock" };
}

/*
 * One appearance per state, shared by the Cards area and Overview's Cards
 * summary, on the workspace Status contract (DESIGN.md 2026-10-04): positive
 * check-circle, pending clock, paused pause, needs-review alert-triangle,
 * expired calendar-x, failed x-circle, unknown help-circle. Labels stay each
 * state's own words; only tone and icon come from here.
 */
type Appearance = { tone: StatusTone; icon: StatusIcon };
const POSITIVE: Appearance = { tone: "positive", icon: "check-circle" };
const PENDING: Appearance = { tone: "info", icon: "clock" };
const PAUSED: Appearance = { tone: "neutral", icon: "pause" };
const REVIEW: Appearance = { tone: "warning", icon: "alert-triangle" };
const EXPIRED: Appearance = { tone: "neutral", icon: "calendar-x" };
const FAILED: Appearance = { tone: "critical", icon: "x-circle" };
const UNKNOWN: Appearance = { tone: "unknown", icon: "help-circle" };

const STATE_APPEARANCE: Record<string, Appearance> = {
  // Card status
  active: POSITIVE,
  frozen: PAUSED,
  freeze_pending: PENDING,
  setting_up: PENDING,
  proof_pending: PENDING,
  opening: PENDING,
  limits_failed: FAILED,
  needs_activation: REVIEW,
  freeze_failed: FAILED,
  needs_restore: REVIEW,
  // Activity lifecycle
  pending: PENDING,
  reserved: PENDING,
  captured: POSITIVE,
  partially_captured: POSITIVE,
  reversed: POSITIVE,
  expired: EXPIRED,
  late_capture: REVIEW,
  refunded: POSITIVE,
  forced_capture: REVIEW,
  declined: FAILED,
  ambiguous: UNKNOWN,
  disputed: REVIEW,
  exception: REVIEW,
  // Activity kinds without a lifecycle
  freeze: PAUSED,
  unfreeze: POSITIVE,
  policy_change: POSITIVE,
  repayment: POSITIVE,
};

/** Tone and icon for a card or activity state key. An unrecognised key reads as unknown, never as fine. */
export function stateAppearance(key: string): Appearance {
  return STATE_APPEARANCE[key] ?? UNKNOWN;
}

/** Props for the shared workspace Status. `describe` adds the state's detail for assistive technology. */
export function pillStatusProps(pill: StatePill, describe = true): StatusProps {
  return { ...stateAppearance(pill.key), label: pill.label, description: describe ? pill.detail : undefined };
}

export const ISSUER_FREEZE_COPY: Record<IssuerFreezeState, string> = {
  pending_issuer_confirmation: "Card network: waiting for confirmation",
  confirmed: "Card network: confirmed",
  failed: "Card network: didn't confirm. ChainPay keeps declining every purchase.",
};

export const STATEMENT_STEPS = [
  { key: "closed", label: "Closed" },
  { key: "repayment_observed", label: "Payment seen" },
  { key: "partner_confirmed", label: "Partner confirmed" },
  { key: "discharged", label: "Paid off" },
] as const;

export const STATEMENT_STATE_LABEL: Record<string, string> = {
  open: "Open",
  closed: "Ready to pay",
  repayment_observed: "Payment seen",
  partner_confirmed: "Partner confirmed",
  discharged: "Paid off",
  repayment_mismatch: "Payment didn't match",
  overdue: "Past due",
};

/** Mismatch field codes from Axum (contracts §7.2) in plain words. */
export const MISMATCH_COPY: Record<string, string> = {
  mint: "Paid with a different token than Devnet USDC.",
  amount: "The amount isn't exactly the statement total.",
  reference: "The payment doesn't carry this statement's reference.",
  network: "The payment isn't on Solana Devnet.",
  recipient: "The payment went to a different account than the partner's.",
  owner: "The spending permission belongs to another wallet.",
  receipt: "The receipt couldn't be found or isn't a ChainPay receipt.",
  derivation: "The receipt address doesn't match the permission and reference.",
  mandate: "The spending permission isn't the one that made this payment.",
  payer: "The payment came from a wallet other than the card owner's.",
  program: "The receipt isn't from the ChainPay program.",
  receipt_status: "The receipt isn't in a settled state.",
};
