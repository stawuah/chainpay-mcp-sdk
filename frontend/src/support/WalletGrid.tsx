// Ruling P5 (+ Dre, 2026-10-03): featured wallets with "Detected" chips and
// install links, plus an "Other wallet" tile that connects any Solana wallet the
// browser exposes (Wallet Standard or an injected provider).
import { useState } from "react";
import type { ChainPayWalletOption } from "../wallet/connect";
import { resolveConnectedWalletIcon } from "../wallet/icons";
import { arrangeWallets } from "./wallets";

export function WalletGrid({ options, connectingId, onPick, onRefresh }: {
  options: ChainPayWalletOption[];
  connectingId: string;
  onPick: (optionId: string) => void;
  onRefresh: () => void;
}) {
  const { featured, others } = arrangeWallets(options);
  const [othersOpen, setOthersOpen] = useState(false);
  const busy = connectingId !== "";

  return (
    <div className="wallet-grid-wrap">
      <ul className="wallet-grid">
        {featured.map(({ wallet, option }) => (
          <li key={wallet.key}>
            {option ? (
              <button
                type="button"
                className="wallet-tile"
                disabled={busy}
                aria-label={`${wallet.name}, detected`}
                onClick={() => onPick(option.id)}
              >
                <img src={option.icon ?? wallet.logo} alt="" width={40} height={40} />
                <span className="wallet-tile-name">{connectingId === option.id ? "Connecting…" : wallet.name}</span>
                <span className="wallet-chip">Detected</span>
              </button>
            ) : (
              <a className="wallet-tile is-missing" href={wallet.installUrl} target="_blank" rel="noreferrer" aria-label={`Get ${wallet.name} (opens in a new tab)`}>
                <img src={wallet.logo} alt="" width={40} height={40} />
                <span className="wallet-tile-name">{wallet.name}</span>
                <span className="wallet-chip is-get">Get ↗</span>
              </a>
            )}
          </li>
        ))}
        <li>
          <button
            type="button"
            className="wallet-tile is-other"
            aria-expanded={othersOpen}
            aria-controls="wallet-others"
            onClick={() => {
              onRefresh();
              setOthersOpen((open) => !open);
            }}
          >
            <span className="wallet-other-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 22 22"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h9A2.5 2.5 0 0 1 18 7.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 14.5v-7Z M14 11h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </span>
            <span className="wallet-tile-name">Other wallet</span>
            {others.length ? <span className="wallet-chip">{others.length} found</span> : null}
          </button>
        </li>
      </ul>

      {othersOpen ? (
        <div className="wallet-others" id="wallet-others">
          {others.length ? (
            others.map((option) => {
              const icon = resolveConnectedWalletIcon(option.name, option.icon);
              return (
                <button key={option.id} type="button" className="wallet-row" disabled={busy} onClick={() => onPick(option.id)}>
                  {icon ? <img src={icon} alt="" width={24} height={24} /> : <span className="wallet-row-blank" aria-hidden="true" />}
                  <span>{connectingId === option.id ? "Connecting…" : option.name}</span>
                </button>
              );
            })
          ) : (
            <div className="wallet-none">
              <p>No other wallet found in this browser. Any Solana wallet extension shows up here once it's installed and unlocked.</p>
              <button type="button" className="tip-link-button" onClick={onRefresh}>Check again</button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
