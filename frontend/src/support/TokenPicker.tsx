// "Other token": search Jupiter's verified token list, with a few popular picks.
import { useEffect, useState } from "react";
import { searchTokens, type SwapToken } from "./swap";

// Popular picks, looked up by mint on open so names, decimals and icons come from Jupiter.
const POPULAR_MINTS = [
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
];

/** Token icons live on third-party hosts (IPFS, Arweave); fall back to a letter if one fails. */
export function TokenIcon({ token, size }: { token: SwapToken; size: number }) {
  const [broken, setBroken] = useState(false);
  if (!token.icon || broken) {
    return <span className="token-blank" style={{ width: size, height: size }} aria-hidden="true">{token.symbol.replace(/^\$/, "").slice(0, 1)}</span>;
  }
  return <img src={token.icon} alt="" width={size} height={size} loading="lazy" onError={() => setBroken(true)} />;
}

export function TokenPicker({ onPick }: { onPick: (token: SwapToken) => void }) {
  const [query, setQuery] = useState("");
  const [popular, setPopular] = useState<SwapToken[]>([]);
  const [results, setResults] = useState<SwapToken[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all(POPULAR_MINTS.map((mint) => searchTokens(mint).then((list) => list.find((t) => t.mint === mint)).catch(() => undefined)))
      .then((found) => alive && setPopular(found.filter((t): t is SwapToken => Boolean(t))));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      searchTokens(query)
        .then((list) => {
          if (!alive) return;
          setResults(list);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const list = results ?? popular;

  return (
    <div className="token-picker">
      <label className="tip-field">
        <span className="sr-only">Search tokens</span>
        <input value={query} autoFocus placeholder="Search a token (e.g. USDT, BONK)" onChange={(event) => setQuery(event.target.value)} />
      </label>
      {!results ? <p className="token-section">Popular</p> : null}
      {failed ? <p className="tip-hint">Search isn't responding. Try again in a moment.</p> : null}
      {results && results.length === 0 ? <p className="tip-hint">No verified token matches that.</p> : null}
      <ul className="token-list">
        {list.map((token) => (
          <li key={token.mint}>
            <button type="button" className="token-row" onClick={() => onPick(token)}>
              <TokenIcon token={token} size={28} />
              <span className="token-names">
                <span className="token-symbol">{token.symbol}</span>
                <span className="token-name">{token.name}</span>
              </span>
              <span className="token-verified" aria-label="Verified">✓</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="tip-hint token-foot">Swapped to USDC by Jupiter in the same transaction. Only verified tokens are listed.</p>
    </div>
  );
}
