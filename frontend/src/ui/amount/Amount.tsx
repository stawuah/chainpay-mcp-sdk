import { ChevronRight, TriangleAlert } from "lucide-react";
import { formatDisplayAmount } from "./formatDisplayAmount";
import { useMintMetadata } from "./useMintMetadata";
import type { MintMetadataState } from "./mintMetadataStore";

/*
  A token amount in the workspace (DESIGN.md "Amount presentation").

  - Loading: an amount-width skeleton; nothing that could be read as a number.
  - Verified: grouped, exact, at least two fraction digits, tabular figures.
  - Unavailable: "Amount unavailable" and a retry. The raw base units exist
    only inside a technical disclosure labelled "raw units".

  Decimals come from the mint's on-chain metadata only, never from the symbol.
  Do not place inside <p>: the raw-units disclosure is a <details>.
*/
export type AmountProps = {
  baseUnits: bigint | string;
  mint: string;
  symbol?: string;
  /** Off when a section shows one shared retry for every amount it holds. */
  showRetry?: boolean;
  /** "lead" is the 28px Overview figure. */
  size?: "default" | "lead";
  className?: string;
};

export function displayAmountText(baseUnits: bigint | string, state: MintMetadataState, symbol?: string): string | null {
  if (state.status !== "verified") return null;
  return `${formatDisplayAmount(baseUnits, state.decimals)}${symbol ? ` ${symbol}` : ""}`;
}

export function useDisplayAmount(baseUnits: bigint | string, mint: string, symbol?: string) {
  const metadata = useMintMetadata(mint);
  return { ...metadata, text: displayAmountText(baseUnits, metadata.state, symbol) };
}

export function Amount({ baseUnits, mint, symbol, showRetry = true, size = "default", className }: AmountProps) {
  const { state, retry } = useMintMetadata(mint);
  const classes = `cp-amount${size === "lead" ? " is-lead" : ""}${className ? ` ${className}` : ""}`;
  const raw = baseUnits.toString();

  if (state.status === "loading") {
    // Width follows the digit count, so the row does not jump when it resolves.
    const width = Math.min(18, Math.max(4, raw.length - 2)) + (symbol ? symbol.length + 1 : 0);
    return (
      <span className={`${classes} is-loading`} aria-busy="true">
        <span className="cp-amount-skeleton" style={{ width: `${width}ch` }} aria-hidden="true" />
        <span className="sr-only">Loading amount</span>
      </span>
    );
  }

  if (state.status === "unavailable") {
    return (
      <span className={`${classes} is-unavailable`} data-amount-state="unavailable">
        <span className="cp-amount-unavailable">Amount unavailable</span>
        {showRetry && <button type="button" className="cp-amount-retry" onClick={(event) => { event.stopPropagation(); retry(); }}>Retry</button>}
        <details className="cp-amount-raw" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <RawUnitsSummary />
          <code>{raw}</code>
        </details>
      </span>
    );
  }

  return (
    <span className={classes} data-amount-state="verified">
      <span className="cp-amount-value">{formatDisplayAmount(baseUnits, state.decimals)}</span>
      {symbol ? <span className="cp-amount-symbol">{symbol}</span> : null}
    </span>
  );
}

/** A disclosure that looks like one: a chevron that turns when open, beside "raw units". */
function RawUnitsSummary() {
  return <summary><ChevronRight className="cp-amount-raw-cue" aria-hidden="true" size={14} strokeWidth={2} />raw units</summary>;
}

/** One retry for every unavailable mint in a section. */
export function MintMetadataNotice({ unavailable, onRetry, symbolFor, rawHint = "Raw units are in each amount’s details." }: { unavailable: string[]; onRetry: () => void; symbolFor: (mint: string) => string; rawHint?: string }) {
  if (!unavailable.length) return null;
  const names = unavailable.map(symbolFor).join(", ");
  return (
    <div className="cp-collection-notice cp-metadata-notice" role="status" data-state="metadata-unavailable">
      <TriangleAlert aria-hidden="true" size={16} />
      <div>
        <strong>{names} token details couldn’t be read</strong>
        <p>Amounts stay hidden until the token’s decimals load. {rawHint}</p>
      </div>
      <button type="button" className="cp-amount-retry is-block" onClick={onRetry}>Retry</button>
    </div>
  );
}

/**
 * Several amounts of one mint whose metadata is unavailable: one message and
 * one "raw units" disclosure instead of a repeated message per figure.
 */
export function AmountsUnavailable({ values, label = "Amounts unavailable", showRaw = true, onRetry }: { values: [string, bigint | string][]; label?: string; /** Off inside a clickable row whose detail view shows the raw units. */ showRaw?: boolean; /** One retry for the group, beside its message. */ onRetry?: () => void }) {
  return (
    <span className="cp-amount is-unavailable" data-amount-state="unavailable">
      <span className="cp-amount-unavailable">{label}</span>
      {onRetry && <button type="button" className="cp-amount-retry" onClick={(event) => { event.stopPropagation(); onRetry(); }}>Retry</button>}
      {showRaw && <details className="cp-amount-raw" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <RawUnitsSummary />
        <code>{values.map(([name, value]) => `${name} ${value.toString()}`).join(" · ")}</code>
      </details>}
    </span>
  );
}
