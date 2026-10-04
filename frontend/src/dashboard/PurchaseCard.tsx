import type { AgentCheck } from "../owner/runtime";
import type { PurchaseCardView } from "../owner/purchaseCard";
import crossmintMark from "../assets/brands/crossmint.svg";
import { Amount } from "../ui/amount/Amount";

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
        <div><dt>Amount</dt><dd>{purchase.amount ? <Amount baseUnits={purchase.amount.baseUnits} mint={purchase.amount.mint} symbol={purchase.tokenLabel} /> : `${purchase.amountLabel} ${purchase.tokenLabel}`.trim()}</dd></div>
        <div><dt>Recipient</dt>{purchase.recipientBrand === "crossmint"
          ? <dd className="purchase-card-brand"><img src={crossmintMark} alt="Crossmint" /></dd>
          : <dd className="mono">{purchase.recipientLabel}</dd>}</div>
      </dl>
      {purchase.limit ? (
        <div className="purchase-card-limit">This permission allows up to <Amount baseUnits={purchase.limit.perPayment} mint={purchase.limit.mint} symbol={purchase.limit.symbol} /> per payment and <Amount baseUnits={purchase.limit.total} mint={purchase.limit.mint} symbol={purchase.limit.symbol} /> total.</div>
      ) : purchase.limitDetail && (
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
