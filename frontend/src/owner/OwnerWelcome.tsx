import { BrandLogo, BrandMark } from "../brand/Brand";
import solanaMark from "../assets/brands/solana.svg";
import { useWallet } from "../wallet/context";
import { WalletChoices } from "../ui/WalletChoices";
import { SetupProgress } from "./SetupProgress";
import "./owner-welcome.css";

export function OwnerWelcome() {
  const { walletOptions, connecting, connectWallet, walletConnectionError, refreshWalletOptions } = useWallet();
  return (
    <main className="cp-welcome cp-app">
      <header className="cp-welcome-header">
        <a href="/" aria-label="ChainPay home"><BrandLogo /></a>
        <span className="cp-welcome-network"><img src={solanaMark} alt="" />Solana <span>Devnet</span></span>
      </header>
      <div className="cp-welcome-layout">
        <section className="cp-welcome-world" aria-labelledby="welcome-promise">
          <div className="cp-welcome-world-copy">
            <span className="cp-welcome-eyebrow">A LITTLE AUTONOMY. ON YOUR TERMS.</span>
            <h2 id="welcome-promise">Room to work.<br /><span>Rules you set.</span></h2>
            <p>Give your agent a spending limit.<br />Keep control of what happens next.</p>
          </div>
          <div className="cp-welcome-art" aria-hidden="true">
            <div className="cp-welcome-orbit cp-welcome-orbit-outer" />
            <div className="cp-welcome-orbit cp-welcome-orbit-inner" />
            <div className="cp-welcome-axis" />
            <div className="cp-welcome-emblem"><BrandMark /></div>
            <div className="cp-welcome-node cp-welcome-node-wallet"><span className="cp-welcome-node-icon">↗</span><span>Your wallet<small>You hold the funds</small></span></div>
            <div className="cp-welcome-node cp-welcome-node-rules"><span className="cp-welcome-node-icon">≡</span><span>Your rules<small>Enforced on-chain</small></span></div>
            <div className="cp-welcome-node cp-welcome-node-agent"><span className="cp-welcome-node-icon">✳</span><span>Your agent<small>Works within limits</small></span></div>
            <span className="cp-welcome-orbit-point" />
          </div>
          <p className="cp-welcome-world-foot">Your funds stay yours. Your keys stay in your wallet.</p>
        </section>
        <section className="cp-welcome-action" aria-labelledby="welcome-title">
          <SetupProgress current={0} />
          <div className="cp-welcome-action-body">
            <span className="cp-welcome-eyebrow">YOUR FIRST MANDATE</span>
            <h1 id="welcome-title">Start with<br />your wallet.</h1>
            <p className="cp-welcome-intro">A mandate is the spending permission you give your agent. Connect, sign in, then set its limits.</p>
            <WalletChoices wallets={walletOptions} connecting={connecting} error={walletConnectionError} onSelect={(id) => void connectWallet(id)} onRefresh={refreshWalletOptions} />
            <p className="cp-welcome-consent">Connecting shares your wallet address.<br />Sign-in and spending approval are separate steps.</p>
          </div>
          <footer className="cp-welcome-action-foot"><span>Built for your control.</span><a href="/">Back to ChainPay <span aria-hidden="true">↗</span></a></footer>
        </section>
      </div>
    </main>
  );
}
