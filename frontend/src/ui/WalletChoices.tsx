import { useState } from "react";
import phantom from "../assets/brands/phantom.svg";
import solflare from "../assets/brands/solflare.svg";
import jupiter from "../assets/brands/jupiter.svg";
import metamask from "../assets/brands/metamask.svg";
import type { WalletPickerOption } from "./WalletPickerDialog";
import "./wallet-choices.css";

const walletDirectory = [
  { name: "Phantom", icon: phantom, href: "https://phantom.com/download", description: "Browser & mobile" },
  { name: "Solflare", icon: solflare, href: "https://www.solflare.com/", description: "Browser & mobile" },
  { name: "Jupiter", icon: jupiter, href: "https://jup.ag/mobile", description: "Mobile wallet" },
  { name: "MetaMask", icon: metamask, href: "https://metamask.io/download/", description: "Browser & mobile" },
];

export function WalletChoices({ wallets, connecting, error, onSelect, onRefresh }: {
  wallets: WalletPickerOption[];
  connecting: boolean;
  error: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const [more, setMore] = useState(false);
  const missingWallets = walletDirectory.filter((item) => !wallets.some((wallet) => wallet.name.toLowerCase() === item.name.toLowerCase()));
  const directory = more ? missingWallets : missingWallets.slice(0, 2);

  return (
    <div className="cp-wallet-choices">
      {wallets.length > 0 && (
        <div className="cp-wallet-detected">
          <p className="cp-wallet-list-label">Available in this browser</p>
          <div className="cp-wallet-rows">
            {wallets.map((wallet) => {
              const icon = wallet.icon || walletDirectory.find((item) => item.name.toLowerCase() === wallet.name.toLowerCase())?.icon;
              return <button type="button" className="cp-wallet-row" key={wallet.id} disabled={connecting} onClick={() => { setSelected(wallet.id); onSelect(wallet.id); }}>
                <span className="cp-wallet-logo">{icon ? <img src={icon} alt="" /> : <span aria-hidden="true">↗</span>}</span>
                <span className="cp-wallet-row-copy"><strong>{wallet.name}</strong><small>{connecting && selected === wallet.id ? "Waiting for your wallet…" : "Connect wallet"}</small></span>
                <span className="cp-wallet-row-end" aria-hidden="true">{connecting && selected === wallet.id ? "…" : "→"}</span>
              </button>;
            })}
          </div>
        </div>
      )}
      {wallets.length === 0 && <p className="cp-wallet-list-label">Choose a wallet to install or open</p>}
      {wallets.length > 0 && missingWallets.length > 0 ? (
        <details className="cp-wallet-install">
          <summary>Use another wallet</summary>
          <WalletInstallRows wallets={missingWallets} />
        </details>
      ) : wallets.length === 0 ? (
        <>
          <WalletInstallRows wallets={directory} />
          {missingWallets.length > 2 && <button type="button" className="cp-wallet-text-button" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Fewer wallets" : "More wallets"}<span aria-hidden="true">{more ? "−" : "+"}</span></button>}
        </>
      ) : null}
      <div className="cp-wallet-refresh">
        <p role="status">{connecting ? "Continue in your wallet." : wallets.length === 0 ? refreshed ? "Still no wallet detected. Open your wallet, then refresh." : "No wallet detected in this browser yet." : refreshed ? "Wallet list refreshed." : "Don’t see your wallet?"}</p>
        <button type="button" disabled={connecting} onClick={() => { onRefresh(); setRefreshed(true); }}>Refresh<span className="cp-wallet-sr-only"> wallets</span></button>
      </div>
      {error && <div className="cp-wallet-error" role="alert"><strong>Wallet connection didn’t complete</strong><p>{error}</p><span>You can choose a wallet to try again.</span></div>}
    </div>
  );
}

function WalletInstallRows({ wallets }: { wallets: typeof walletDirectory }) {
  return <div className="cp-wallet-rows">{wallets.map((wallet) => (
    <a className="cp-wallet-row cp-wallet-install-row" href={wallet.href} target="_blank" rel="noopener noreferrer" key={wallet.name} aria-label={`Get ${wallet.name} — official website (opens in a new tab)`}>
      <span className="cp-wallet-logo"><img src={wallet.icon} alt="" /></span>
      <span className="cp-wallet-row-copy"><strong>{wallet.name}</strong><small>{wallet.description}</small></span>
      <span className="cp-wallet-row-end">Get wallet <span aria-hidden="true">↗</span></span>
    </a>
  ))}</div>;
}
