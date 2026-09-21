import { BrandLogo } from "../brand/Brand";
import { useEffect, useState } from "react";
import { loadOpsSnapshot, type OpsSnapshot } from "@chainpay/sdk";
import { publicReceiptClient } from "../config/client";
import { SpendMeter } from "../dashboard/charts/SpendMeter";
import { LoadedReceiptCard } from "../receipts/InboxReceipt";
import { isPlausibleSolanaAddress } from "../receipts/model";
import { useRoute } from "../routing/useRoute";
import "./embed-overview.css";

function OwnerEntry({ onSubmit }: { onSubmit: (owner: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="ops-embed-entry"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <label htmlFor="ops-embed-owner">Owner wallet</label>
      <input
        id="ops-embed-owner"
        className="mono"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste the owner Solana address"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" className="button button-primary">Show spending</button>
    </form>
  );
}

export function EmbedOverview({ owner }: { owner: string }) {
  const { navigate } = useRoute();
  const navigateToOwner = (next: string) => navigate({ kind: "embed-overview", owner: next.trim() });
  const trimmed = owner.trim();
  const plausible = trimmed.length > 0 && isPlausibleSolanaAddress(trimmed);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; snapshot: OpsSnapshot }
    | { kind: "error"; message: string }
  >(trimmed ? { kind: "loading" } : { kind: "idle" });

  useEffect(() => {
    if (!trimmed || !plausible) {
      setState({ kind: "idle" });
      return;
    }
    let active = true;
    setState({ kind: "loading" });
    void loadOpsSnapshot(publicReceiptClient, {
      owner: trimmed,
      appUrl: window.location.origin,
      receiptLimit: 8,
    }).then((snapshot) => {
      if (active) setState({ kind: "ready", snapshot });
    }).catch((error) => {
      if (active) {
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not load on-chain spending.",
        });
      }
    });
    return () => {
      active = false;
    };
  }, [trimmed, plausible]);

  const latest = state.kind === "ready" ? state.snapshot.receipts[0] : undefined;

  return (
    <main className="site-shell cp-app ops-embed">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home">
          <BrandLogo />
        </a>
        <a className="login-link" href="/app/overview">Open dashboard</a>
      </header>
      <section className="page-width ops-embed-body">
        <span className="section-kicker">IN-CONTEXT OVERVIEW</span>
        <h1 className="t-xl">Spending snapshot</h1>
        <p className="t-body">
          Mandate allowances and receipts from Solana. No wallet required. Pause and revoke still sign in the dashboard.
        </p>
        {!trimmed && <OwnerEntry onSubmit={navigateToOwner} />}
        {trimmed && !plausible && (
          <>
            <p role="alert">That does not look like a Solana address.</p>
            <OwnerEntry onSubmit={navigateToOwner} />
          </>
        )}
        {state.kind === "loading" && <p className="t-body">Loading on-chain spend…</p>}
        {state.kind === "error" && <p role="alert">{state.message}</p>}
        {state.kind === "ready" && (
          <>
            {state.snapshot.totals.map((total) => (
              <p key={total.mint}>
                <strong>{total.spent} {total.symbol}</strong> spent · {total.remaining} {total.symbol} remaining
              </p>
            ))}
            {state.snapshot.attention.map((item) => (
              <p key={`${item.kind}:${item.mandate}`} className="ops-embed-attention">{item.detail}</p>
            ))}
            <div className="ops-embed-meters">
              {state.snapshot.mandates.filter((mandate) => mandate.status === "active").map((mandate) => (
                <div key={mandate.address} className="ops-embed-meter">
                  <h2>{mandate.symbol} · {mandate.status}</h2>
                  <SpendMeter
                    spent={BigInt(mandate.spentBase)}
                    limit={BigInt(mandate.totalLimitBase)}
                    decimals={mandate.decimals}
                    symbol={mandate.symbol}
                  />
                </div>
              ))}
            </div>
            {latest && (
              <section className="ops-embed-receipt">
                <h2>Latest receipt</h2>
                <LoadedReceiptCard receiptPda={latest.address} shareMode="public" />
              </section>
            )}
            {state.snapshot.receipts.length > 1 && (
              <ul className="ops-embed-receipts">
                {state.snapshot.receipts.slice(1).map((receipt) => (
                  <li key={receipt.address}>
                    <a href={receipt.receiptUrl ?? `/verify/${encodeURIComponent(receipt.address)}`}>
                      {receipt.amount} {receipt.symbol}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {state.snapshot.mandates.length === 0 && (
              <p className="t-body">No spending permissions found for this wallet.</p>
            )}
            <p className="ops-embed-note">{state.snapshot.note}</p>
          </>
        )}
      </section>
    </main>
  );
}

export default EmbedOverview;
