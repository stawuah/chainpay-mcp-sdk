export function Arrow() {
  return <span aria-hidden="true">→</span>;
}

export function Shield() {
  return <span className="shield-icon" aria-hidden="true">◇</span>;
}

export function MiniChart({ color }: { color: string }) {
  return (
    <svg className={`mini-chart ${color}`} viewBox="0 0 180 56" aria-hidden="true">
      <path className="chart-fill" d="M2 43 C15 38 22 42 33 33S53 39 63 29S82 35 92 24S113 27 124 18S145 22 158 12S172 13 178 5V56H2Z" />
      <path className="chart-line" d="M2 43 C15 38 22 42 33 33S53 39 63 29S82 35 92 24S113 27 124 18S145 22 158 12S172 13 178 5" />
    </svg>
  );
}

export function shortAddress(value: string) {
  // Without the length guard a short value repeats its own characters: an
  // 8-character id rendered as "AgEn…T111", which reads as a truncation of
  // something longer and is not reversible by eye.
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
