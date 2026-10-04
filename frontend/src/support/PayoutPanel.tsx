// Ruling P10: shown only when the connected wallet is one of the vault's two
// on-chain recipients. This is a UI convenience, NOT a security boundary: pay_*
// is permissionless on-chain and always pays the recipient, whoever presses it.
import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { ChainPayWallet } from "../wallet/connect";
import { payoutInstructions, type Side, type SupportAccounts, type VaultView } from "./donation";
import { amountLabel } from "./Ledger";
import { friendlyError, sendSigned, signForSupport } from "./send";

export function recipientSide(vault: VaultView | null, address: string | undefined): Side | null {
  if (!vault || !address) return null;
  const index = vault.recipients.indexOf(address);
  return index === 0 || index === 1 ? index : null;
}

export function PayoutPanel({ wallet, vault, accounts, onPaid }: {
  wallet: ChainPayWallet | null;
  vault: VaultView | null;
  accounts: SupportAccounts | null;
  onPaid: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const side = recipientSide(vault, wallet?.address);
  if (side === null || !vault || !accounts || !wallet) return null;

  const owedSol = vault.sol.owed[side];
  const owedUsdc = vault.usdc.owed[side];
  const nothing = owedSol === 0n && owedUsdc === 0n;

  const payOut = async () => {
    setBusy(true);
    setMessage("");
    try {
      const payer = new PublicKey(wallet.address);
      const recipient = new PublicKey(vault.recipients[side]);
      const assets = (["SOL", "USDC"] as const).filter((asset) => (asset === "SOL" ? owedSol : owedUsdc) > 0n);
      const signed = await signForSupport(wallet, assets.flatMap((asset) => payoutInstructions({ asset, side, recipient, payer, accounts })));
      const outcome = await sendSigned(signed);
      setMessage(outcome.status === "confirmed" ? "Paid out." : outcome.status === "failed" ? outcome.message : "Not confirmed yet. Check your wallet history before retrying.");
      onPaid();
    } catch (cause) {
      setMessage(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="payout page-width" aria-label="Your balance">
      <div className="payout-card">
        <div>
          <p className="payout-label">Your balance</p>
          <p className="payout-amount">{amountLabel(owedSol, "SOL")} · {amountLabel(owedUsdc, "USDC")}</p>
        </div>
        <button type="button" className="tip-primary payout-button" disabled={busy || nothing} onClick={() => void payOut()}>
          {busy ? "Paying out…" : "Pay out"}
        </button>
      </div>
      {message ? <p className="payout-message" role="status">{message}</p> : null}
    </section>
  );
}
