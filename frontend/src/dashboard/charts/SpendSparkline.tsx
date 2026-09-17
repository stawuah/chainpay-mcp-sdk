/*
  Cumulative spend against a hard limit, as an inline SVG area.

  Hand-built rather than pulled from a chart library: Astryx ships no charting,
  and a dependency on an upstream PR would need its own argument. It is also
  small enough that matching the brand exactly costs less than restyling a
  library's defaults.

  The dashed line is the mandate limit. The point of the picture is the gap
  between the filled area and that line — the headroom the owner still has.
*/
export type SpendPoint = {
  /** Cumulative base units spent at this point, as a Number for geometry only. */
  cumulative: number;
  label: string;
};

export type SpendSparklineProps = {
  points: SpendPoint[];
  limit: number;
  /** Exact, already-formatted figures for the accessible summary. */
  summary: string;
  height?: number;
};

export function SpendSparkline({ points, limit, summary, height = 96 }: SpendSparklineProps) {
  if (points.length < 2 || limit <= 0) {
    return (
      <div className="spend-sparkline is-empty" role="img" aria-label={summary}>
        <p>Not enough settled payments yet to chart.</p>
      </div>
    );
  }

  const W = 320;
  const H = height;
  const pad = 6;
  const top = Math.max(limit, ...points.map((p) => p.cumulative));
  const x = (i: number) => pad + (i * (W - pad * 2)) / (points.length - 1);
  const y = (v: number) => H - pad - (v / top) * (H - pad * 2);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(H - pad).toFixed(1)} L${x(0).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  const limitY = y(limit).toFixed(1);

  return (
    <div className="spend-sparkline">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={summary} preserveAspectRatio="none">
        <defs>
          <linearGradient id="cp-spend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0052ff" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0052ff" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <line
          x1={pad} y1={limitY} x2={W - pad} y2={limitY}
          stroke="#c6d1e6" strokeWidth="1" strokeDasharray="3 3"
        />
        <path d={area} fill="url(#cp-spend-fill)" />
        <path d={line} fill="none" stroke="#0052ff" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="spend-sparkline-axis">
        <span>{points[0].label}</span>
        <span className="spend-sparkline-limit">Limit</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}
