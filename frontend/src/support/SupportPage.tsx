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

export type SupportMode = "closed" | "devnet" | "mainnet";

export function supportMode(live: boolean, cluster: typeof SUPPORT_CLUSTER): SupportMode {
  if (!live) return "closed";
  return cluster === "devnet" ? "devnet" : "mainnet";
}

/** Hero words per state. Closed and Devnet never ask for real money. */
export const SUPPORT_HERO: Record<SupportMode, { eyebrow: string; title: string; lede: (a: string, b: string) => string }> = {
  closed: {
    eyebrow: "Support ChainPay",
    title: "Tips are opening soon.",
    lede: () => "Nothing can be sent from this page yet. When it opens, every tip splits 50/50 on-chain between the two maintainers.",
  },
  devnet: {
    eyebrow: "Support ChainPay · Devnet test",
    title: "Try a test tip.",
    lede: (a, b) => `This runs on Devnet test tokens, so nothing here has real value. Each test tip splits 50/50 on-chain to ${a}'s and ${b}'s wallets.`,
  },
  mainnet: {
    eyebrow: "Support ChainPay",
    title: "Like ChainPay? Buy us a coffee.",
    lede: (a, b) => `Tips keep ChainPay free, open source and shipping. Every tip is split 50/50 on-chain and paid to ${a}'s and ${b}'s personal wallets.`,
  },
};

function raisedLine(data: TrackerData | null, mode: SupportMode) {
  if (!data) return null;
  if (data.contributionCount === 0) return mode === "devnet" ? "No test tips yet" : "Be the first to chip in";
  const parts = [
    BigInt(data.totals.sol.contributed) > 0n ? amountLabel(data.totals.sol.contributed, "SOL") : "",
    BigInt(data.totals.usdc.contributed) > 0n ? amountLabel(data.totals.usdc.contributed, "USDC") : "",
  ].filter(Boolean);
  return mode === "devnet" ? `${parts.join(" · ")} in Devnet test tokens` : `${parts.join(" · ")} raised`;
}

export default function SupportPage() {
  const live = supportReady();
  const mode = supportMode(live, SUPPORT_CLUSTER);
  const hero = SUPPORT_HERO[mode];
  const tracker = useTracker(live);
  const { vault, accounts, refresh } = useVault(live);
  const walletState = useSupportWallet();
  const raised = raisedLine(tracker.data, mode);

  const afterSend = () => {
    void refresh();
    // The indexer picks it up within a few minutes; ask again soon.
    window.setTimeout(tracker.reload, 20_000);
  };

  return (
    <UseCaseChrome title={mode === "mainnet" ? "Buy us a coffee · ChainPay" : "Support · ChainPay"} headerAction={live ? "dashboard" : "home"}>
      <div className="support2">
        <header className="s2-hero page-width">
          <div className="s2-hero-copy">
            <p className="s2-eyebrow">{hero.eyebrow}</p>
            <h1 className="s2-h1">{hero.title}</h1>
            <p className="s2-lede">{hero.lede(MAINTAINER_LABELS[0], MAINTAINER_LABELS[1])}</p>
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
                <p className="tip-sub">Nothing to send yet. Check back once it's open.</p>
                <a className="tip-secondary" href="/" data-testid="support-back">Back to ChainPay</a>
              </section>
            )}
          </div>
        </div>

        {live ? <Ledger data={tracker.data} failed={tracker.failed} vault={accounts?.vault.toBase58() ?? null} /> : null}
        {live ? <PayoutPanel wallet={walletState.wallet} vault={vault} accounts={accounts} onPaid={() => void refresh()} /> : null}
        {live && SUPPORT_CLUSTER === "devnet" ? (
          <div className="page-width"><p className="s2-devnet">Devnet test tokens only. Nothing sent here has real value.</p></div>
        ) : null}
      </div>
    </UseCaseChrome>
  );
}
