import { useRef } from "react";
import { Lock } from "lucide-react";
import { BrandLogo } from "../brand/Brand";
import { DECLINE_COPY, formatUsdCents, mccLabel, type CardEvidence } from "@chainpay/sdk";
import { LIFECYCLE_PILLS, STATEMENT_STATE_LABEL } from "../dashboard/cards/lifecycle";
import { Pill } from "../dashboard/cards/ui";
import { printReceipt } from "./print";
import { Arrow } from "../ui/marks";
import "./receipt-card.css";

/*
 * Card evidence (contracts §9, ruling K15). Deliberately NOT the payment
 * receipt layout: no "PAYMENT RECEIPT" kicker, no network chip, no public
 * receipt link and never "settled on Solana". Card records are private by
 * default; sharing goes through an explicit field picker.
 */

function Row({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

const EXCEPTION_COPY: Record<string, string> = {
  forced_capture: "The shop charged without an approval. It's counted and flagged, never treated as approved.",
  over_capture: "The shop charged more than was approved. The extra is flagged for your review.",
  unpaired_capture: "A charge arrived with no matching purchase. It's flagged for your review.",
};

export function cardEvidenceKicker(evidence: CardEvidence): string {
  if (evidence.kind === "card_authorization") return evidence.decision === "approved" ? "CARD HOLD" : "CARD DECLINE";
  if (evidence.kind === "card_capture") return evidence.exception ? "CARD CHARGE · NEEDS REVIEW" : "CARD CHARGE";
  return "STATEMENT PAYMENT";
}

function headline(evidence: CardEvidence): string {
  if (evidence.kind === "card_authorization") return formatUsdCents(evidence.amountCents);
  if (evidence.kind === "card_capture") return formatUsdCents((evidence.lifecycle === "reversed" || evidence.lifecycle === "expired") && evidence.reservedCents ? evidence.reservedCents : evidence.capturedCents);
  return formatUsdCents(evidence.totalCents);
}

export function CardEvidenceCard({ evidence, onShare, label }: { evidence: CardEvidence; onShare?: () => void; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  const isStatement = evidence.kind === "statement_repayment";
  const pill = evidence.kind === "card_authorization"
    ? LIFECYCLE_PILLS[evidence.reservationState]
    : evidence.kind === "card_capture"
      ? LIFECYCLE_PILLS[evidence.lifecycle]
      : undefined;
  return (
    <article ref={ref} className="receipt-card cp-card-evidence" data-evidence-kind={evidence.kind} data-private="yes">
      <div className="receipt-brand"><BrandLogo /></div>
      <div className="receipt-card-heading">
        <div>
          <span className="section-kicker">{cardEvidenceKicker(evidence)}</span>
          <h3 className="receipt-card-amount">{headline(evidence)} <small>{label ?? "US dollars, exact cents"}</small></h3>
        </div>
        <span className="cp-evidence-private"><Lock size={14} aria-hidden="true" /> Private</span>
      </div>
      {pill && <p className="cp-evidence-state"><Pill pill={pill} withDetail />{!(evidence.kind === "card_capture" && evidence.exception) && <span>{pill.detail}</span>}</p>}
      {evidence.kind === "card_authorization" && evidence.decision === "declined" && evidence.declineReason && (
        <p className="cp-evidence-note" data-decline={evidence.declineReason}>{DECLINE_COPY[evidence.declineReason]}</p>
      )}
      {evidence.kind === "card_capture" && evidence.exception && <p className="cp-evidence-note" data-exception={evidence.exception}>{EXCEPTION_COPY[evidence.exception]}</p>}
      {isStatement && <p className="cp-sim-strip" data-testid="sim-strip">Simulated credit — no credit extended</p>}
      <dl className="receipt-summary">
        {evidence.kind !== "statement_repayment" && <>
          <Row label="Shop" value={evidence.merchant.displayName} />
          <Row label="Category" value={evidence.merchant.mcc ? mccLabel(Number(evidence.merchant.mcc)) : "Not given"} />
        </>}
        {evidence.kind === "card_authorization" && <>
          <Row label="Decision" value={evidence.decision === "approved" ? "Approved and held" : "Declined"} />
          <Row label="When" value={new Date(evidence.at).toUTCString()} />
        </>}
        {evidence.kind === "card_capture" && <>
          <Row label="Charged" value={formatUsdCents(evidence.capturedCents)} />
          <Row label="Approved hold" value={evidence.reservedCents ? formatUsdCents(evidence.reservedCents) : evidence.lifecycle === "forced_capture" ? "None, there was no approval" : "Not reported"} />
          {evidence.commitment && <Row label="Public checkpoint" value={`#${evidence.commitment.seq} at slot ${evidence.commitment.slot}`} />}
        </>}
        {evidence.kind === "statement_repayment" && <>
          <Row label="Statement total" value={formatUsdCents(evidence.totalCents)} />
          <Row label="Status" value={STATEMENT_STATE_LABEL[evidence.repaymentState] ?? evidence.repaymentState} />
          <Row label="Statement reference" value={evidence.statementDigest} />
          <Row label="Repayment receipt" value={evidence.receiptPda} />
        </>}
      </dl>
      <p className="receipt-identifier-note">
        {isStatement
          ? "Paid off means both checks passed: the repayment receipt matched this statement and the simulated partner confirmed it."
          : "This is a card record, not a Solana payment. ChainPay proves it later against the card's public checkpoint, if you choose to share it."}
      </p>
      <div className="receipt-card-actions">
        {onShare && <button type="button" className="button button-secondary-light button-small" onClick={onShare}>Share <Arrow /></button>}
        <button type="button" className="button button-secondary-light button-small" onClick={() => { if (ref.current) printReceipt(ref.current); }}>Print / Save as PDF</button>
      </div>
    </article>
  );
}
