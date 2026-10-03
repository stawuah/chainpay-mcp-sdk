import type { CardActivityRow, CardCaptureLifecycle, CardEvidence, CardView, StatementView } from "@chainpay/sdk";

/*
 * Activity rows → ReceiptCard evidence (contracts §9). Card evidence is a
 * separate kind from an SPL settlement and is always private. A row that is
 * still being checked has no receipt yet.
 */

const CAPTURE_LIFECYCLES: readonly string[] = ["captured", "partially_captured", "reversed", "expired", "late_capture", "refunded", "forced_capture"];

export function activityEvidence(card: CardView, row: CardActivityRow): CardEvidence | null {
  const merchant = { displayName: row.merchant?.displayName ?? "Unknown shop", mcc: row.merchant?.mcc ?? "" };
  // No amount means no record: never print an invented $0.00.
  if (row.amountCents === undefined) return null;
  const amount = row.amountCents;
  if (row.kind === "authorization" && (row.lifecycle === "reserved" || row.lifecycle === "declined" || row.lifecycle === "ambiguous")) {
    return {
      kind: "card_authorization",
      cardId: card.cardId,
      intentId: row.intentId ?? row.rowId,
      merchant,
      amountCents: amount,
      currency: "USD",
      reservationState: row.lifecycle,
      decision: row.lifecycle === "reserved" ? "approved" : "declined",
      ...(row.declineReason ? { declineReason: row.declineReason } : {}),
      at: row.at,
      private: true,
    };
  }
  const lifecycle = row.lifecycle && CAPTURE_LIFECYCLES.includes(row.lifecycle) ? row.lifecycle as CardCaptureLifecycle : row.kind === "exception" ? "forced_capture" : null;
  if (lifecycle) {
    const released = lifecycle === "reversed" || lifecycle === "expired";
    // The hold equals the row amount only when the row says so by its state: a
    // full charge, or a released/expired hold. Otherwise use Axum's reservedCents
    // or show the hold as not reported.
    const hold = row.reservedCents ?? (lifecycle === "captured" || released ? amount : "");
    const exception = row.exception === "forced_capture" || row.exception === "over_capture" || row.exception === "unpaired_capture" ? row.exception : lifecycle === "forced_capture" ? "forced_capture" : undefined;
    return {
      kind: "card_capture",
      cardId: card.cardId,
      authId: row.rowId,
      merchant,
      capturedCents: released ? "0" : amount,
      reservedCents: hold,
      lifecycle,
      ...(exception ? { exception } : {}),
      ...(card.commitment ? { commitment: card.commitment } : {}),
      private: true,
    };
  }
  return null;
}

export function statementEvidence(statement: StatementView): CardEvidence | null {
  if (!statement.repayment?.receiptPda || !statement.digest) return null;
  const state = statement.state;
  if (state !== "repayment_observed" && state !== "partner_confirmed" && state !== "discharged" && state !== "repayment_mismatch") return null;
  return {
    kind: "statement_repayment",
    cardId: statement.cardId,
    statementId: statement.statementId,
    statementDigest: statement.digest,
    totalCents: statement.totalCents,
    receiptPda: statement.repayment.receiptPda,
    repaymentState: state,
    simulatedCredit: true,
  };
}
