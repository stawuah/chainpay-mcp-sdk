import type { UsageRingState } from "./spending";

/*
  The single usage ring (DESIGN.md "Usage ring"): 72px, 6px stroke, blue for
  spent on a border-coloured track, warning colour from 90%. A zero limit or
  unavailable input is a neutral dashed ring with no percentage. The fill is
  drawn in place and never animates. Exact figures always sit beside it; the
  ring is a picture of them, not a replacement.
*/
const SIZE = 72;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function UsageRing({ state, label }: { state: UsageRingState; label: string }) {
  if (state.kind === "unavailable") {
    return (
      <div className="cp-usage-ring is-unavailable" role="img" aria-label={label}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="cp-usage-ring-dashed" strokeDasharray="4 5" />
        </svg>
        <span className="cp-usage-ring-center" aria-hidden="true">—</span>
      </div>
    );
  }
  const filled = CIRCUMFERENCE * state.fraction;
  const percentLabel = state.percent >= 10 || state.percent === 0 ? Math.floor(state.percent).toString() : state.percent.toFixed(1);
  return (
    <div className={`cp-usage-ring${state.warning ? " is-warning" : ""}`} role="img" aria-label={label}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="cp-usage-ring-track" />
        {state.fraction > 0 && (
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="cp-usage-ring-fill"
            strokeLinecap={state.fraction >= 1 ? "butt" : "round"}
            strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        )}
      </svg>
      <span className="cp-usage-ring-center" aria-hidden="true">{percentLabel}<small>%</small></span>
    </div>
  );
}
