import { formatTokenAmount } from "../../owner/amounts";

/*
  Spend against the authorized limit, with remaining headroom.

  This is the product's whole claim — an agent spending inside a limit the owner
  approved — and it had no visual form anywhere in the dashboard.

  Amounts are never recomputed here. The caller passes bigint base units and the
  mint's decimals; formatTokenAmount does the exact conversion and falls back to
  base units when decimals have not been read. Only the BAR geometry uses
  floating point, and it is clamped — a rounded pixel width cannot misstate a
  number the viewer can read beside it.
*/
export type SpendMeterProps = {
  spent: bigint;
  limit: bigint;
  decimals: number | null;
  symbol: string;
  /** Renders the large headroom figure. Off for compact table rows. */
  showHeadroom?: boolean;
};

function percent(spent: bigint, limit: bigint) {
  if (limit <= 0n) return 0;
  // Scale in bigint first so a large limit cannot lose precision via Number().
  const scaled = Number((spent * 10000n) / limit) / 100;
  return Math.max(0, Math.min(100, scaled));
}

export function SpendMeter({ spent, limit, decimals, symbol, showHeadroom = true }: SpendMeterProps) {
  const used = percent(spent, limit);
  const remaining = limit > spent ? limit - spent : 0n;
  const spentLabel = formatTokenAmount(spent, decimals);
  const limitLabel = formatTokenAmount(limit, decimals);
  const remainingLabel = formatTokenAmount(remaining, decimals);
  const exhausted = remaining === 0n && limit > 0n;

  return (
    <div className="spend-meter">
      {showHeadroom && (
        <div className={`spend-meter-headroom${decimals === null ? " is-raw" : ""}`}>
          <span className="soft-label">REMAINING</span>
          <strong className="t-num">{remainingLabel}</strong>
          <span className="spend-meter-symbol">{symbol}</span>
        </div>
      )}
      {decimals === null && (
        <p className="spend-meter-raw-note">
          Token decimals have not been read, so these are exact on-chain base units.
        </p>
      )}
      <div
        className={`spend-meter-track${exhausted ? " is-exhausted" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={`${spentLabel} of ${limitLabel} ${symbol} spent, ${remainingLabel} ${symbol} remaining`}
      >
        <span className="spend-meter-fill" style={{ width: `${used}%` }} />
      </div>
      <div className="spend-meter-legend">
        <span>
          <b className="t-num">{spentLabel}</b> / <span className="t-num">{limitLabel}</span> {symbol} spent
        </span>
        <span className="spend-meter-percent t-num">{used.toFixed(1)}%</span>
      </div>
    </div>
  );
}
