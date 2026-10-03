// Ruling P8–P9: public ledger of contributions + the on-chain footnote.
import { explorerAddress, explorerTx } from "./config";
import { decimalsFor, formatUnits, shortAddress, type SupportAsset } from "./donation";

export type TrackerContribution = {
  signature: string;
  asset: SupportAsset;
  amount: string;
  donor: string | null;
  note: string | null;
  blockTime: number | null;
};

export type TrackerData = {
  totals: { sol: { contributed: string }; usdc: { contributed: string } };
  contributionCount: number;
  recent: TrackerContribution[];
};

export function amountLabel(units: string | bigint, asset: SupportAsset) {
  return `${formatUnits(BigInt(units), decimalsFor(asset))} ${asset}`;
}

export function timeAgo(seconds: number | null, now = Date.now()) {
  if (!seconds) return "";
  const diff = Math.max(0, now / 1000 - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

/** Deterministic two-stop gradient from an address, in brand-adjacent blues. */
export function avatarGradient(address: string) {
  let hash = 0;
  for (const char of address) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const a = 205 + (hash % 30);
  const b = 190 + ((hash >> 8) % 50);
  return `linear-gradient(135deg, hsl(${a} 95% 62%), hsl(${b} 85% 82%))`;
}

export function Ledger({ data, failed, vault }: { data: TrackerData | null; failed: boolean; vault: string | null }) {
  return (
    <section className="ledger page-width" aria-labelledby="ledger-title">
      <div className="ledger-head">
        <h2 id="ledger-title" className="ledger-title">Supporters</h2>
        {data && data.contributionCount > 0 ? <span className="ledger-count">{data.contributionCount.toLocaleString("en-US")}</span> : null}
      </div>

      {!data ? (
        <p className="ledger-muted">{failed ? "The ledger is taking a moment. Everything is on-chain if you want to check." : "Loading…"}</p>
      ) : data.recent.length === 0 ? (
        <div className="ledger-empty">
          <img src="/support/empty-400.webp" srcSet="/support/empty-400.webp 400w, /support/empty-800.webp 800w" sizes="200px" width={200} height={150} loading="lazy" alt="An empty tip jar" />
          <p>Be the first to buy us a coffee.</p>
        </div>
      ) : (
        <ul className="ledger-list">
          {data.recent.slice(0, 25).map((item) => (
            <li key={item.signature} className="ledger-row">
              {item.donor ? (
                <span className="ledger-avatar" style={{ background: avatarGradient(item.donor) }} aria-hidden="true" />
              ) : (
                <span className="ledger-avatar is-anon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 6h8v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Zm8 1h1a1.5 1.5 0 0 1 0 3h-1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                </span>
              )}
              <div className="ledger-who">
                <span className={item.donor ? "ledger-addr" : "ledger-anon"}>{item.donor ? shortAddress(item.donor) : "Anonymous supporter"}</span>
                {item.note ? <span className="ledger-note">{item.note}</span> : null}
              </div>
              <div className="ledger-meta">
                <span className="ledger-amount">{amountLabel(item.amount, item.asset)}</span>
                <a className="ledger-time" href={explorerTx(item.signature)} target="_blank" rel="noreferrer" aria-label={`View transaction from ${timeAgo(item.blockTime)}`}>
                  {timeAgo(item.blockTime)} <span aria-hidden="true">↗</span>
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {vault ? (
        <p className="ledger-foot">
          Tips are held by an open-source program on Solana.{" "}
          <a href={explorerAddress(vault)} target="_blank" rel="noreferrer">Verify on-chain ↗</a>
        </p>
      ) : null}
    </section>
  );
}
