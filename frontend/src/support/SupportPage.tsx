// /support — council ruling P1–P12: _bmad-output/design-council/support-v2-ruling-2026-10-03.md
import { useCallback, useEffect, useMemo, useState } from "react";
import { UseCaseChrome } from "../use-cases/UseCaseChrome";
import { MAINTAINER_LABELS, SUPPORT_CLUSTER, SUPPORT_PROGRAM_ID, SUPPORT_TRACKER_URL, USDC_MINT, supportReady } from "./config";
import { decodeVault, supportAccounts, type VaultView } from "./donation";
import { Ledger, amountLabel, type TrackerData } from "./Ledger";
import { PayoutPanel } from "./PayoutPanel";
import { supportConnection } from "./send";
import { TipCard } from "./TipCard";
import { useSupportWallet } from "./useSupportWallet";
import "./support.css";

function useTracker(enabled: boolean) {
  const [data, setData] = useState<TrackerData | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    if (!enabled || !SUPPORT_TRACKER_URL) return;
    fetch(SUPPORT_TRACKER_URL)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((json: TrackerData) => {
        setData(json);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [enabled]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  return { data, failed, reload: load };
}

function useVault(enabled: boolean) {
  const [vault, setVault] = useState<VaultView | null>(null);
  const accounts = useMemo(() => (enabled ? supportAccounts(SUPPORT_PROGRAM_ID, USDC_MINT) : null), [enabled]);
  const refresh = useCallback(async () => {
    if (!accounts) return;
    try {
      const info = await supportConnection().getAccountInfo(accounts.vault, "confirmed");
      if (info && info.owner.equals(accounts.programId)) setVault(decodeVault(info.data));
    } catch {
      // Keep the last known state.
    }
  }, [accounts]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { vault, accounts, refresh };
}

function raisedLine(data: TrackerData | null) {
  if (!data) return null;
  if (data.contributionCount === 0) return "Be the first to chip in";
  const parts = [
    BigInt(data.totals.sol.contributed) > 0n ? amountLabel(data.totals.sol.contributed, "SOL") : "",
    BigInt(data.totals.usdc.contributed) > 0n ? amountLabel(data.totals.usdc.contributed, "USDC") : "",
  ].filter(Boolean);
  return `${parts.join(" · ")} raised`;
}

export default function SupportPage() {
  const live = supportReady();
  const tracker = useTracker(live);
  const { vault, accounts, refresh } = useVault(live);
  const walletState = useSupportWallet();
  const raised = raisedLine(tracker.data);

  const afterSend = () => {
    void refresh();
    // The indexer picks it up within a few minutes; ask again soon.
    window.setTimeout(tracker.reload, 20_000);
  };

  return (
    <UseCaseChrome title="Buy us a coffee · ChainPay">
      <div className="support2">
        <header className="s2-hero page-width">
          <div className="s2-hero-copy">
            <p className="s2-eyebrow">Support ChainPay</p>
            <h1 className="s2-h1">Like ChainPay? Buy us a coffee.</h1>
            <p className="s2-lede">
              Tips keep ChainPay free, open source and shipping. Every tip is split 50/50 on-chain and paid to{" "}
              {MAINTAINER_LABELS[0]}'s and {MAINTAINER_LABELS[1]}'s personal wallets.
            </p>
            {live && raised ? <p className="s2-raised">{raised}</p> : null}
          </div>
          <div className="s2-hero-art">
            <img
              src="/support/hero-800.webp"
              srcSet="/support/hero-800.webp 800w, /support/hero-1600.webp 1600w"
              sizes="(max-width: 899px) 100vw, 50vw"
              width={800}
              height={600}
              fetchPriority="high"
              alt="The ChainPay robot next to a tip jar of blue and white tokens and a cup of coffee"
            />
          </div>
        </header>

        <div className="s2-band">
          <div className="s2-band-inner">
            {live ? (
              <TipCard walletState={walletState} onSent={afterSend} />
            ) : (
              <section className="tip-card tip-soon" aria-labelledby="soon-title">
                <h2 id="soon-title" className="tip-title">Opening soon</h2>
                <p className="tip-sub">We're putting the finishing touches on it. Check back shortly.</p>
              </section>
            )}
          </div>
        </div>

        {live ? <Ledger data={tracker.data} failed={tracker.failed} vault={accounts?.vault.toBase58() ?? null} /> : null}
        {live ? <PayoutPanel wallet={walletState.wallet} vault={vault} accounts={accounts} onPaid={() => void refresh()} /> : null}
        {live && SUPPORT_CLUSTER === "devnet" ? (
          <div className="page-width"><p className="s2-devnet">Devnet rehearsal: test tokens only.</p></div>
        ) : null}
      </div>
    </UseCaseChrome>
  );
}
