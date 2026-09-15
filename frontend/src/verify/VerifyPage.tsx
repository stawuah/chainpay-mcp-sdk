import { BrandLogo } from "../brand/Brand";
import { useEffect, useState } from "react";
import { loadPublicReceiptView } from "../receipts/load";
import { classifyReceiptPda, initialPageState, type PublicReceiptPageState } from "../receipts/model";
import { ReceiptPageState } from "../receipts/ReceiptCard";

export { isPlausibleReceiptPda, classifyReceiptPda } from "../receipts/model";

export function VerifyPage({ receiptPda }: { receiptPda: string }) {
  const trimmed = receiptPda.trim();
  const [state, setState] = useState<PublicReceiptPageState>(() => initialPageState(trimmed));

  useEffect(() => {
    const next = initialPageState(trimmed);
    setState(next);
    if (next.kind !== "loading") return;
    let active = true;
    void loadPublicReceiptView(trimmed).then((result) => {
      if (active) setState(result);
    });
    return () => {
      active = false;
    };
  }, [trimmed]);

  return (
    <main className="site-shell cp-app verify-page">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home">
          <BrandLogo />
        </a>
        <a className="login-link" href="/">Back to ChainPay</a>
      </header>
      <section className="page-width" style={{ padding: "48px 0 80px" }}>
        <span className="section-kicker">PUBLIC RECEIPT</span>
        <h1 className="t-xl">Payment receipt</h1>
        {classifyReceiptPda(trimmed) === "plausible" && state.kind !== "verified" && (
          <p className="mono">{trimmed}</p>
        )}
        <ReceiptPageState
          state={state}
          onRetry={() => {
            setState({ kind: "loading", receiptPda: trimmed });
            void loadPublicReceiptView(trimmed, { refresh: true }).then(setState);
          }}
        />
      </section>
    </main>
  );
}

export default VerifyPage;
