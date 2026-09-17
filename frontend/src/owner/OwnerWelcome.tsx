import { Wallet } from "lucide-react";
import { BrandLogo } from "../brand/Brand";
import { useWallet } from "../wallet/context";
import { WalletChoices } from "../ui/WalletChoices";
import "../dashboard/owner-dashboard.css";

export function OwnerWelcome() {
  const { walletOptions, connecting, connectWallet, walletConnectionError, refreshWalletOptions } = useWallet();
  return <main className="dashboard-app cp-app owner-entry">
    <header><a href="/" aria-label="ChainPay home"><BrandLogo /></a><span className="owner-muted">Solana Devnet</span></header>
    <section className="owner-entry-card" aria-labelledby="welcome-title">
      <span className="owner-entry-icon"><Wallet /></span><p className="owner-caption">Your wallet · Your workspace</p>
      <h1 id="welcome-title">Connect your wallet</h1><p>Manage your agents, set spending limits, and keep track of every payment.</p>
      <WalletChoices wallets={walletOptions} connecting={connecting} error={walletConnectionError} onSelect={(id) => void connectWallet(id)} onRefresh={refreshWalletOptions} />
      <p className="owner-caption">Connecting shares your wallet address. You’ll sign in next. Spending requires a separate approval.</p>
    </section>
  </main>;
}
