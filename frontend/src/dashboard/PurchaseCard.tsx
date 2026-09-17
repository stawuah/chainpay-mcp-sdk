import type { AgentCheck } from "../owner/runtime";
import type { PurchaseCardView } from "../owner/purchaseCard";

function RequirementRow({ check }: { check: AgentCheck }) {
  const mark = check.status === "pass" ? "✓" : check.status === "fail" ? "×" : check.status === "missing" ? "!" : "·";
  return (
    <div className={`purchase-card-check purchase-card-check-${check.status}`}>
      <span aria-hidden="true">{mark}</span>
      <div>
        <b>{check.label}</b>
        <small>{check.detail}</small>
      </div>
    </div>
  );
}

export function PurchaseCard({
  purchase,
  compact = false,
  onOpen,
}: {
  purchase: PurchaseCardView;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <div className="purchase-card-heading">
        <div>
          <span className="soft-label">LIVE PURCHASE</span>
          <h3>{purchase.description}</h3>
        </div>
        <span className={`state-pill purchase-card-status purchase-card-status-${purchase.status}`}>
          <i /> {purchase.statusLabel}
        </span>
      </div>
      <dl className="purchase-card-facts">
        <div><dt>Amount</dt><dd>{purchase.amountLabel} {purchase.tokenLabel}</dd></div>
        <div><dt>Recipient</dt><dd className="mono">{purchase.recipientLabel}</dd></div>
      </dl>
      {purchase.limitDetail && (
        <p className="purchase-card-limit">{purchase.limitDetail}</p>
      )}
      {purchase.showChecks && !compact && (
        <div className="purchase-card-checks" aria-label="Policy checks">
          {purchase.checks.map((check) => <RequirementRow check={check} key={check.key} />)}
        </div>
      )}
    </>
  );

  if (onOpen) {
    return (
      <button type="button" className={`purchase-card purchase-card-action ${compact ? "is-compact" : ""}`} onClick={onOpen}>
        {body}
        <span className="purchase-card-open">Review request →</span>
      </button>
    );
  }

  return <article className={`purchase-card ${compact ? "is-compact" : ""}`}>{body}</article>;
}
