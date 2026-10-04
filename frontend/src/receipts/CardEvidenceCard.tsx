import { useRef } from "react";
import { Lock, Printer, Share2 } from "lucide-react";
import { BrandLogo } from "../brand/Brand";
import { DECLINE_COPY, formatUsdCents, mccLabel, type CardEvidence } from "@chainpay/sdk";
import { LIFECYCLE_PILLS, STATEMENT_STATE_LABEL } from "../dashboard/cards/lifecycle";
import { Pill } from "../dashboard/cards/ui";
import { printReceipt } from "./print";
import "./receipt-card.css";

/*
 * Card evidence (contracts §9, ruling K15). Deliberately NOT the payment
 * receipt layout: no "PAYMENT RECEIPT" kicker, no network chip, no public
 * receipt link and never "settled on Solana". Card records are private by
 * default; sharing goes through an explicit field picker.
 */

/** A receipt line with a dotted leader. Long values (addresses, digests) stack under their label. */
function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const long = value.length > 30;
  return (
    <div className={`cp-receipt-row${long ? " is-long" : ""}`}>
      <dt>{label}</dt>
      {!long && <span className="cp-receipt-leader" aria-hidden="true" />}
      <dd className={mono ? "is-mono" : undefined}>{value}</dd>
    </div>
  );
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

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

/*
 * The receipt object (premium ruling P4): a paper slip with a perforation
 * (notches cut from both edges) and a torn bottom edge. The evidence kind is a
 * visible chip, not a `.section-kicker` (the dashboard hides those).
 */
export function CardEvidenceCard({ evidence, onShare, label }: { evidence: CardEvidence; onShare?: () => void; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  const isStatement = evidence.kind === "statement_repayment";
  const pill = evidence.kind === "card_authorization"
    ? LIFECYCLE_PILLS[evidence.reservationState]
    : evidence.kind === "card_capture"
      ? LIFECYCLE_PILLS[evidence.lifecycle]
      : undefined;
  const kicker = cardEvidenceKicker(evidence);
  const tone = kicker.includes("REVIEW") || kicker.includes("DECLINE") ? "attention" : "default";
  const paidOff = isStatement && evidence.repaymentState === "discharged";
  return (
    <article ref={ref} className="cp-receipt cp-card-evidence" data-evidence-kind={evidence.kind} data-private="yes">
      <div className="cp-receipt-paper">
        <div className="cp-receipt-stub">
          <div className="cp-receipt-brand-row">
            <span className="receipt-brand"><BrandLogo size="compact" /></span>
            <span className="cp-evidence-private"><Lock size={13} aria-hidden="true" /> Private</span>
          </div>
          <span className="cp-receipt-kind" data-tone={tone}>{kicker}</span>
          <h3 className="cp-receipt-amount">{headline(evidence)}<small>{label ?? "USD · exact cents"}</small></h3>
          {pill && <p className="cp-evidence-state"><Pill pill={pill} withDetail />{!(evidence.kind === "card_capture" && evidence.exception) && <span>{pill.detail}</span>}</p>}
          {evidence.kind === "card_authorization" && evidence.decision === "declined" && evidence.declineReason && (
            <p className="cp-evidence-note" data-decline={evidence.declineReason}>{DECLINE_COPY[evidence.declineReason]}</p>
          )}
          {evidence.kind === "card_capture" && evidence.exception && <p className="cp-evidence-note" data-exception={evidence.exception}>{EXCEPTION_COPY[evidence.exception]}</p>}
          {isStatement && <p className="cp-sim-strip" data-testid="sim-strip">Simulated credit — no credit extended</p>}
          {paidOff && <span className="cp-paid-stamp cp-receipt-stamp" aria-hidden="true">Paid off</span>}
        </div>
        <div className="cp-receipt-body">
          <dl className="cp-receipt-rows">
            {evidence.kind !== "statement_repayment" && <>
              <Row label="Shop" value={evidence.merchant.displayName} />
              <Row label="Category" value={evidence.merchant.mcc ? mccLabel(Number(evidence.merchant.mcc)) : "Not given"} />
            </>}
            {evidence.kind === "card_authorization" && <>
              <Row label="Decision" value={evidence.decision === "approved" ? "Approved and held" : "Declined"} />
              <Row label="When" value={when(evidence.at)} />
            </>}
            {evidence.kind === "card_capture" && <>
              <Row label="Charged" value={formatUsdCents(evidence.capturedCents)} />
              <Row label="Approved hold" value={evidence.reservedCents ? formatUsdCents(evidence.reservedCents) : evidence.lifecycle === "forced_capture" ? "None, there was no approval" : "Not reported"} />
              {evidence.commitment && <Row label="Public checkpoint" value={`#${evidence.commitment.seq} at slot ${evidence.commitment.slot}`} />}
            </>}
            {evidence.kind === "statement_repayment" && <>
              <Row label="Statement total" value={formatUsdCents(evidence.totalCents)} />
              <Row label="Status" value={STATEMENT_STATE_LABEL[evidence.repaymentState] ?? evidence.repaymentState} />
              <Row label="Statement reference" value={evidence.statementDigest} mono />
              <Row label="Repayment receipt" value={evidence.receiptPda} mono />
            </>}
          </dl>
          <p className="cp-receipt-note">
            {isStatement
              ? "Paid off means both checks passed: the repayment receipt matched this statement and the simulated partner confirmed it."
              : "This is a card record, not a Solana payment. ChainPay proves it later against the card's public checkpoint, if you choose to share it."}
          </p>
          <div className="receipt-card-actions cp-receipt-actions">
            {onShare && <button type="button" className="cp-receipt-button is-primary" onClick={onShare}><Share2 size={15} aria-hidden="true" /> Share proof</button>}
            <button type="button" className="cp-receipt-button" onClick={() => { if (ref.current) printReceipt(ref.current); }}><Printer size={15} aria-hidden="true" /> Print / Save as PDF</button>
          </div>
          {onShare && <p className="cp-receipt-share-note">You pick the fields. Whoever gets the link checks them on ChainPay's card check page.</p>}
        </div>
      </div>
    </article>
  );
}
