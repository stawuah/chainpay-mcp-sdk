import { Button } from "@astryxdesign/core/Button";
import { Wallet } from "lucide-react";
import { BrandLogo } from "../brand/Brand";
import { shortAddress } from "../ui/marks";

export function OwnerEntry({ wallet, walletName, signing, error, onSignIn, onChangeWallet }: { wallet: string; walletName: string; signing: boolean; error: string; onSignIn: () => void; onChangeWallet: () => void }) {
  return <main className="dashboard-app cp-app owner-entry"><header><a href="/" aria-label="ChainPay home"><BrandLogo /></a><span className="owner-muted">Solana Devnet</span></header><section className="owner-entry-card"><span className="owner-entry-icon"><Wallet /></span><p className="owner-caption">Wallet connected · Sign in next</p><h1>Welcome to your workspace</h1><p>Sign a login message to confirm this wallet is yours. Signing in does not authorize spending.</p><div className="owner-entry-wallet"><strong>{walletName || "Solana wallet"}</strong><span>{shortAddress(wallet)}</span></div>{error && <p className="builder-error" role="alert">{error}</p>}<Button label={signing ? "Waiting for wallet…" : "Sign in"} variant="primary" isDisabled={signing} onClick={onSignIn} /><Button label="Use a different wallet" variant="ghost" isDisabled={signing} onClick={onChangeWallet} /></section></main>;
}
