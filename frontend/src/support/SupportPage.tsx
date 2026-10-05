// /support — council ruling P1–P12: _bmad-output/design-council/support-v2-ruling-2026-10-03.md
import { useCallback, useEffect, useRef, useState } from "react";
import { UseCaseChrome } from "../use-cases/UseCaseChrome";
import { MAINTAINER_LABELS, SUPPORT_TRACKER_URL, supportReady } from "./config";
import { Ledger, amountLabel, type TrackerData } from "./Ledger";
import { PayoutPanel } from "./PayoutPanel";
import { checkSupportChain, type Readiness } from "./readiness";
import { isIndexed } from "./recovery";
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

/**
 * Reads the chain and decides whether signing is allowed. "checking" and
 * "blocked" both keep the tip form away; only "ready" shows it.
 */
function useReadiness(enabled: boolean) {
  const [readiness, setReadiness] = useState<Readiness | { state: "checking" }>({ state: "checking" });
  const generation = useRef(0);
  const check = useCallback(async (): Promise<Readiness | null> => {
    if (!enabled) return null;
    const mine = ++generation.current;
    const result = await checkSupportChain(supportConnection());
    if (mine === generation.current) setReadiness(result);
    return result;
  }, [enabled]);
  const retry = useCallback(() => {
    setReadiness({ state: "checking" });
    void check();
  }, [check]);
  /** After a send: refresh balances, but don't pull the card away mid-result on a hiccup. */
  const refreshQuietly = useCallback(async () => {
    if (!enabled) return;
    const result = await checkSupportChain(supportConnection());
    if (result.state === "ready") setReadiness(result);
  }, [enabled]);
  useEffect(() => {
    void check();
  }, [check]);
  return { readiness, check, retry, refreshQuietly };
}

export type SupportMode = "closed" | "devnet";

/** Devnet is the only state that opens. Anything else stays closed. */
export function supportMode(ready: boolean): SupportMode {
  return ready ? "devnet" : "closed";
}

/** Hero words per state. Neither asks for real money. */
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
};

function raisedLine(data: TrackerData | null) {
  if (!data) return null;
  if (data.contributionCount === 0) return "No test tips yet";
  const parts = [
    BigInt(data.totals.sol.contributed) > 0n ? amountLabel(data.totals.sol.contributed, "SOL") : "",
    BigInt(data.totals.usdc.contributed) > 0n ? amountLabel(data.totals.usdc.contributed, "USDC") : "",
  ].filter(Boolean);
  return `${parts.join(" · ")} in Devnet test tokens`;
}

function BlockedCard({ reason, retry, onRetry }: { reason: string; retry: boolean; onRetry: () => void }) {
  return (
    <section className="tip-card tip-soon" aria-labelledby="blocked-title" data-testid="support-blocked">
      <h2 id="blocked-title" className="tip-title">Tips are paused</h2>
      <p className="tip-sub">{reason}</p>
      <p className="tip-sub">Nothing can be signed until the support vault checks out on Devnet.</p>
      {retry ? (
        <button type="button" className="tip-primary" onClick={onRetry} data-testid="support-retry">Check again</button>
      ) : null}
      <a className="tip-secondary" href="/">Back to ChainPay</a>
    </section>
  );
}

export default function SupportPage() {
  const live = supportReady();
  const mode = supportMode(live);
  const hero = SUPPORT_HERO[mode];
  const tracker = useTracker(live);
  const { readiness, check, retry, refreshQuietly } = useReadiness(live);
  const walletState = useSupportWallet();
  const raised = raisedLine(tracker.data);
  const ready = readiness.state === "ready" ? readiness : null;

  const afterSend = () => {
    void refreshQuietly();
    // The indexer picks it up within a few minutes; ask again soon.
    window.setTimeout(tracker.reload, 20_000);
  };
  const ensureReady = useCallback(async () => {
    const result = await check();
    return result?.state === "ready" ? null : result?.reason ?? "Support is switched off.";
  }, [check]);
  const recent = tracker.data?.recent;
  const indexed = useCallback((signature: string) => isIndexed(signature, recent), [recent]);

  return (
    <UseCaseChrome title="Support · ChainPay" headerAction={live ? "dashboard" : "home"}>
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
            {live && ready ? (
              <TipCard walletState={walletState} accounts={ready.accounts} ensureReady={ensureReady} indexed={indexed} onSent={afterSend} onRefreshLedger={tracker.reload} />
            ) : live && readiness.state === "blocked" ? (
              <BlockedCard reason={readiness.reason} retry={readiness.retry} onRetry={retry} />
            ) : live ? (
              <section className="tip-card tip-soon" aria-busy="true" data-testid="support-checking">
                <h2 className="tip-title">Checking the support vault</h2>
                <p className="tip-sub">Reading Devnet before anything can be signed…</p>
              </section>
            ) : (
              <section className="tip-card tip-soon" aria-labelledby="soon-title">
                <h2 id="soon-title" className="tip-title">Opening soon</h2>
                <p className="tip-sub">Nothing to send yet. Check back once it's open.</p>
                <a className="tip-secondary" href="/" data-testid="support-back">Back to ChainPay</a>
              </section>
            )}
          </div>
        </div>

        {live ? <Ledger data={tracker.data} failed={tracker.failed} vault={ready?.accounts.vault.toBase58() ?? null} /> : null}
        {ready ? <PayoutPanel wallet={walletState.wallet} vault={ready.vault} accounts={ready.accounts} ensureReady={ensureReady} onPaid={() => void refreshQuietly()} /> : null}
        {live ? (
          <div className="page-width"><p className="s2-devnet">Devnet test tokens only. Nothing sent here has real value.</p></div>
        ) : null}
      </div>
    </UseCaseChrome>
  );
}
