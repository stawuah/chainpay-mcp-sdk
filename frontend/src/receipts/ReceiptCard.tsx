import { BrandLogo } from "../brand/Brand";
import { useRef, useState } from "react";
import { Arrow } from "../ui/marks";
import {
  amountLabel,
  pageAllowsSuccessChrome,
  publicReceiptPath,
  publicReceiptUrl,
  receiptStamps,
  type PublicReceiptPageState,
  type ReceiptView,
} from "./model";
import "./receipt-card.css";
import { printReceipt } from "./print";
import { sharePublicReceipt, shareStatusCopy } from "./share";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function CurrentMandate({ receipt }: { receipt: ReceiptView }) {
  const current = receipt.currentMandate;
  return (
    <details className="receipt-current-mandate">
      <summary>Current mandate</summary>
      {current.status === "present" ? (
        <>
          <p>These limits are the mandate’s current on-chain state. They are not a historical snapshot from settlement. Changing or pausing the mandate does not undo Paid.</p>
          <dl>
            <Field label="Current status" value={current.fields.status} />
            <Field label="Max per payment" value={current.fields.maxPerPayment} />
            <Field label="Total limit" value={current.fields.totalLimit} />
            <Field label="Amount spent" value={current.fields.amountSpent} />
            <Field label="Payment count" value={`${current.fields.paymentCount} / ${current.fields.maxPaymentCount}`} />
            <Field label="Cooldown slots" value={current.fields.cooldownSlots} />
            <Field label="Expires at slot" value={current.fields.expiresAtSlot} />
          </dl>
        </>
      ) : current.status === "unavailable" ? (
        <p>Current mandate details are unavailable. {current.reason} Paid is unchanged.</p>
      ) : (
        <p>Current mandate details are not available. Paid is unchanged.</p>
      )}
    </details>
  );
}

export function ReceiptCard({
  receipt,
  onShare,
  shareMode = "public",
  preparedInRequests = false,
}: {
  receipt: ReceiptView;
  onShare?: () => void;
  shareMode?: "public" | "dashboard";
  preparedInRequests?: boolean;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const receiptUrl = publicReceiptUrl(receipt.address, typeof window !== "undefined" ? window.location.origin : "");
  const [shareMessage, setShareMessage] = useState("");
  const amount = amountLabel(receipt.amount);
  const stamps = receiptStamps(receipt);
  const seller = receipt.seller;

  async function share() {
    if (onShare) {
      onShare();
      return;
    }
    const result = await sharePublicReceipt({
      amountLabel: amount,
      tokenLabel: receipt.tokenLabel,
      receiptPda: receipt.address,
    });
    setShareMessage(shareStatusCopy(result));
  }

  return (
    <article ref={cardRef} className="receipt-card" data-paid="yes">
      <div className="receipt-brand"><BrandLogo /></div>
      <div className="receipt-card-heading">
        <div>
          <span className="section-kicker">PAYMENT RECEIPT</span>
          <h3 className="receipt-card-amount">
            {amount} {receipt.tokenLabel}
            <small>
              {receipt.amount.displayKind === "base-units"
                ? "Mint decimals could not be verified. Showing exact base units."
                : `${receipt.amount.baseUnits} base units`}
            </small>
          </h3>
        </div>
        <span className="receipt-card-network">Solana Devnet</span>
      </div>
      {preparedInRequests && shareMode === "dashboard" && (
        <p className="receipt-prepared-note">Prepared in Requests. Private invoice text and attachments stay in your authenticated request history.</p>
      )}
      <dl className="receipt-summary">
        <Field label="Agent signing address" value={receipt.agent} />
        <Field label="Recipient token account" value={receipt.recipientTokenAccount} />
        <Field label="Executed slot" value={receipt.executedAtSlot} />
        <Field label="Spending permission" value={receipt.mandate} />
      </dl>
      <div className="receipt-stamps">
        {stamps.map((stamp) => (
          <div className={`receipt-stamp receipt-stamp-${stamp.tone}`} key={stamp.key} data-stamp={stamp.key} data-tone={stamp.tone}>
            <span className="receipt-stamp-mark" aria-hidden="true">{stamp.tone === "yes" ? "✓" : stamp.tone === "no" ? "×" : "·"}</span>
            <div>
              <b>{stamp.label}</b>
              <p>{stamp.detail}</p>
              {stamp.key === "seller" && seller.status === "valid" && (
                <p>Hash {seller.contentHash} · Served {seller.servedAt}</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <CurrentMandate receipt={receipt} />
      <details className="receipt-technical">
        <summary>Technical details</summary>
        <dl>
          <Field label="Receipt PDA" value={receipt.address} />
          <Field label="Mandate" value={receipt.mandate} />
          <Field label="Mint" value={receipt.mint} />
          <Field label="Source token account" value={receipt.sourceTokenAccount} />
          <Field label="Invoice hash" value={receipt.invoiceHash} />
          <Field label="Payment ID" value={receipt.paymentId} />
          <Field label="Signature reference" value={receipt.signatureReference} />
          <Field label="On-chain status" value={receipt.onChainStatus} />
          <Field label="Bump" value={receipt.bump} />
          {receipt.transactionSignature && <Field label="Activity signature" value={receipt.transactionSignature} />}
        </dl>
      </details>
      <div className="receipt-card-actions">
        <button type="button" className="button button-secondary-light button-small" onClick={() => void share()}>
          {shareMode === "public" ? "Copy receipt link" : "Share receipt"} <Arrow />
        </button>
        <a className="button button-secondary-light button-small" href={publicReceiptPath(receipt.address)}>
          Open public receipt <Arrow />
        </a>
        <button type="button" className="button button-secondary-light button-small" onClick={() => { if (cardRef.current) printReceipt(cardRef.current); }}>
          Print / Save as PDF
        </button>
      </div>
      <p className="receipt-public-url">Public receipt: <a href={receiptUrl}>{receiptUrl}</a></p>
      {shareMessage && <p className="receipt-share-status" role="status">{shareMessage}</p>}
    </article>
  );
}

export function ReceiptPageState({ state, onRetry }: { state: PublicReceiptPageState; onRetry?: () => void }) {
  if (state.kind === "loading") {
    return (
      <div className="receipt-page-state" aria-busy="true">
        <p className="t-body">Reading the finalized receipt…</p>
      </div>
    );
  }
  if (state.kind === "verified") {
    return (
      <div className="receipt-page-state" data-verified={pageAllowsSuccessChrome(state) ? "yes" : "no"}>
        <ReceiptCard receipt={state.receipt} />
      </div>
    );
  }
  const copy = state.kind === "malformed"
    ? { title: "This address is not a valid Solana account.", body: "Check the receipt PDA and try again." }
    : state.kind === "not_found"
      ? { title: "No ChainPay receipt exists at this address.", body: "The account is missing on Solana Devnet." }
      : state.kind === "rpc_error"
        ? { title: "Receipt verification is unavailable.", body: state.message }
        : { title: "This account is not a verified ChainPay receipt.", body: state.reason };
  return (
    <div className="receipt-page-state" role="alert" data-kind={state.kind}>
      <h2 className="t-xl">{copy.title}</h2>
      <p className="t-body">{copy.body}</p>
      {state.kind === "rpc_error" && onRetry && (
        <button type="button" className="button button-primary" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}
