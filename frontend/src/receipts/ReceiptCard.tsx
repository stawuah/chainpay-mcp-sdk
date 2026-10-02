import { BrandLogo } from "../brand/Brand";
import { useRef, useState } from "react";
import { Arrow } from "../ui/marks";
import {
  amountLabel,
  estimateSlotDate,
  formatMandatePaymentCount,
  formatTokenUnits,
  orderMatch,
  policyAtPayment,
  purchaseAuditPath,
  todayCheck,
  type OrderMatchAudience,
  type PurchaseLineItemView,
  type PurchaseProofState,
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

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** Today's limits, for a receipt whose limits at payment were not recorded. */
function TodayLimits({ receipt }: { receipt: ReceiptView }) {
  const current = receipt.currentMandate;
  if (current.status !== "present") {
    return (
      <p className="receipt-policy-note">
        Today’s limits could not be read{current.status === "unavailable" ? `: ${current.reason}` : "."} Paid is unchanged.
      </p>
    );
  }
  const fields = current.fields;
  const token = (baseUnits: string | undefined, fallback: string) => (
    baseUnits === undefined ? fallback : formatTokenUnits(baseUnits, receipt.amount.decimals, receipt.tokenLabel)
  );
  const expiry = estimateSlotDate(fields.expiresAtSlot, receipt.currentSlot, Date.now());
  return (
    <>
      <dl className="receipt-policy-today-limits">
        <Field label="Status today" value={capitalize(fields.status)} />
        <Field label="Per payment" value={token(fields.baseUnits?.maxPerPayment, fields.maxPerPayment)} />
        <Field label="Total allowance" value={token(fields.baseUnits?.totalLimit, fields.totalLimit)} />
        <Field label="Used so far" value={token(fields.baseUnits?.amountSpent, fields.amountSpent)} />
        <Field label="Payments" value={formatMandatePaymentCount(fields.paymentCount, fields.maxPaymentCount)} />
        <Field label="Expires" value={expiry ? `≈ ${expiry}` : `Slot ${fields.expiresAtSlot}`} />
      </dl>
      <p className="receipt-policy-note">Changing or pausing this permission does not undo Paid.</p>
    </>
  );
}

function SpendingPermissionAtPayment({ receipt }: { receipt: ReceiptView }) {
  const display = policyAtPayment(receipt);
  const check = todayCheck(receipt);
  const showTodayLine = !(display.source === "not-recorded" && check.status === "unknown");
  return (
    <section className="receipt-section receipt-policy" aria-labelledby={`receipt-policy-${receipt.address}`} data-policy-source={display.source}>
      <h4 id={`receipt-policy-${receipt.address}`}>Spending permission at payment</h4>
      {display.rows.length > 0 && (
        <ul className="receipt-policy-rows">
          {display.rows.map((row) => <li key={row}>{row}</li>)}
        </ul>
      )}
      <p className="receipt-section-caption">{display.caption}</p>
      {display.source === "not-recorded" && <TodayLimits receipt={receipt} />}
      {showTodayLine && <p className="receipt-policy-today" data-today={check.status}>{check.line}</p>}
    </section>
  );
}

function lineItemText(item: PurchaseLineItemView): string {
  return [
    item.label,
    item.quantity === undefined ? "" : `× ${item.quantity}`,
    item.amount === undefined ? "" : `· ${item.amount}`,
  ].filter(Boolean).join(" ");
}

function OrderMatch({ receipt, purchase, audience }: { receipt: ReceiptView; purchase?: PurchaseProofState; audience: OrderMatchAudience }) {
  const match = orderMatch(purchase, audience);
  if (!match) return null;
  return (
    <section className="receipt-section receipt-order-match" aria-labelledby={`receipt-match-${receipt.address}`} data-match={match.pill}>
      <div className="receipt-section-head">
        <h4 id={`receipt-match-${receipt.address}`}>Order match</h4>
        <span className="receipt-pill" data-pill={match.pill}>{match.pill}</span>
      </div>
      <p className="receipt-section-caption">order · invoice · payment</p>
      <ul className="receipt-match-rows">
        {match.rows.map((row) => (
          <li key={row.key} data-row={row.key} data-tone={row.tone}>
            <span className="receipt-match-mark" aria-hidden="true">{row.tone === "yes" ? "✓" : "×"}</span>
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
      {match.details && (
        <dl className="receipt-match-details">
          <Field label="Seller’s invoice reference" value={match.details.invoice} />
          {match.details.description && <Field label="What was bought" value={match.details.description} />}
          {match.details.lineItems && (
            <>
              <dt>Items</dt>
              <dd><ul className="receipt-line-items">{match.details.lineItems.map((item, index) => <li key={`${item.label}-${index}`}>{lineItemText(item)}</li>)}</ul></dd>
            </>
          )}
        </dl>
      )}
      {audience === "link" && match.details && (
        <p className="receipt-policy-note">Details from the link you opened. They match this receipt’s invoice hash and the seller’s signature.</p>
      )}
    </section>
  );
}

function policyTechnicalFields(receipt: ReceiptView) {
  const policy = receipt.policy;
  if (!policy || policy.source === "not-recorded") return null;
  const limits = policy.limits;
  const laterCounted = policy.source === "relay-observed" && policy.includesLaterPayments;
  return (
    <>
      <Field label="Limits source" value={policy.source} />
      <Field label="Per-payment limit at payment (base units)" value={limits.maxPerPayment} />
      <Field label="Total limit at payment (base units)" value={limits.totalLimit} />
      <Field
        label={laterCounted ? "Spent when the relay read it (base units, includes later payments)" : "Spent after this payment (base units)"}
        value={limits.amountSpentAfter}
      />
      <Field label={laterCounted ? "Payment count when the relay read it" : "Payment count after this payment"} value={limits.paymentCountAfter} />
      <Field label="Payment-count cap" value={limits.maxPaymentCount === "0" ? "None" : limits.maxPaymentCount} />
      <Field label="Expiry slot" value={limits.expiresAtSlot} />
      <Field label="Cooldown slots" value={limits.cooldownSlots} />
      {policy.source === "relay-observed" && <Field label="Relay read at slot" value={policy.observedAtSlot} />}
    </>
  );
}

export function ReceiptCard({
  receipt,
  onShare,
  shareMode = "public",
  preparedInRequests = false,
  purchase,
}: {
  receipt: ReceiptView;
  onShare?: () => void;
  shareMode?: "public" | "dashboard";
  preparedInRequests?: boolean;
  /** Merchant-signed request checked against this receipt, if any. */
  purchase?: PurchaseProofState;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const receiptUrl = publicReceiptUrl(receipt.address, typeof window !== "undefined" ? window.location.origin : "");
  const [shareMessage, setShareMessage] = useState("");
  const amount = amountLabel(receipt.amount);
  const stamps = receiptStamps(receipt);
  const seller = receipt.seller;
  // The owner's dashboard sees request content. /verify sees it only from an
  // audit link the owner shared, and only after it verified here.
  const audience: OrderMatchAudience = shareMode === "dashboard"
    ? "owner"
    : purchase && purchase.status !== "none" && purchase.via === "link" ? "link" : "public";
  const auditFragment = shareMode === "dashboard" && purchase?.status === "verified" && purchase.via === "owner"
    ? purchase.shareFragment
    : undefined;

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

  async function shareWithDetails() {
    if (!auditFragment) return;
    const result = await sharePublicReceipt({
      amountLabel: amount,
      tokenLabel: receipt.tokenLabel,
      receiptPda: receipt.address,
      path: purchaseAuditPath(receipt.address, auditFragment),
    });
    setShareMessage(shareStatusCopy(result, true));
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
      <SpendingPermissionAtPayment receipt={receipt} />
      <OrderMatch receipt={receipt} purchase={purchase} audience={audience} />
      <details className="receipt-technical">
        <summary>Technical details</summary>
        <p className="receipt-identifier-note">These identifiers come from the on-chain receipt account. They are not Axum operation IDs or x402 job IDs.</p>
        <dl>
          <Field label="Receipt PDA (on-chain account)" value={receipt.address} />
          <Field label="Spending permission (mandate PDA)" value={receipt.mandate} />
          <Field label="Mint" value={receipt.mint} />
          <Field label="Source token account" value={receipt.sourceTokenAccount} />
          <Field label="On-chain invoice hash" value={receipt.invoiceHash} />
          <Field label="On-chain payment ID" value={receipt.paymentId} />
          <Field label="Signature reference (replay lock)" value={receipt.signatureReference} />
          <Field label="On-chain status" value={receipt.onChainStatus} />
          <Field label="Bump" value={receipt.bump} />
          {receipt.transactionSignature && <Field label="Solana activity signature" value={receipt.transactionSignature} />}
          {policyTechnicalFields(receipt)}
          {receipt.currentSlot && <Field label="Slot when read" value={receipt.currentSlot} />}
        </dl>
      </details>
      <div className="receipt-card-actions">
        <button type="button" className="button button-secondary-light button-small" onClick={() => void share()}>
          {shareMode === "public" ? "Copy receipt link" : "Share receipt"} <Arrow />
        </button>
        <a className="button button-secondary-light button-small" href={publicReceiptPath(receipt.address)}>
          Open public receipt <Arrow />
        </a>
        {auditFragment && (
          <button type="button" className="button button-secondary-light button-small" onClick={() => void shareWithDetails()} aria-describedby={`receipt-share-details-${receipt.address}`}>
            Share with details <Arrow />
          </button>
        )}
        <button type="button" className="button button-secondary-light button-small" onClick={() => { if (cardRef.current) printReceipt(cardRef.current); }}>
          Print / Save as PDF
        </button>
      </div>
      {auditFragment && (
        <p className="receipt-share-details-note" id={`receipt-share-details-${receipt.address}`}>
          Share with details adds the seller’s invoice to the link. Anyone with that link can read what was bought.
        </p>
      )}
      <p className="receipt-public-url">Public receipt: <a href={receiptUrl}>{receiptUrl}</a></p>
      {shareMessage && <p className="receipt-share-status" role="status">{shareMessage}</p>}
    </article>
  );
}

export function ReceiptPageState({
  state,
  purchase,
  onRetry,
  editableAddress,
  onAddressChange,
  onEditAddress,
}: {
  state: PublicReceiptPageState;
  purchase?: PurchaseProofState;
  onRetry?: () => void;
  editableAddress?: string;
  onAddressChange?: (value: string) => void;
  onEditAddress?: () => void;
}) {
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
        <ReceiptCard receipt={state.receipt} purchase={purchase} />
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
  const canRetry = state.kind === "rpc_error" || state.kind === "not_found";
  return (
    <div className="receipt-page-state" role="alert" data-kind={state.kind}>
      <h2 className="t-xl">{copy.title}</h2>
      <p className="t-body">{copy.body}</p>
      {editableAddress !== undefined && onAddressChange && (
        <div className="verify-entry-form">
          <label className="verify-entry-label" htmlFor="verify-receipt-edit">Receipt address</label>
          <input
            id="verify-receipt-edit"
            className="verify-entry-input mono"
            value={editableAddress}
            onChange={(event) => onAddressChange(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {onEditAddress && (
            <button type="button" className="button button-secondary" onClick={onEditAddress}>Check this address</button>
          )}
        </div>
      )}
      {canRetry && onRetry && (
        <button type="button" className="button button-primary" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}
