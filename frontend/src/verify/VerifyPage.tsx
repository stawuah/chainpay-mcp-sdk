import { BrandLogo } from "../brand/Brand";
import { useEffect, useState } from "react";
import { loadPublicReceiptView } from "../receipts/load";
import { classifyReceiptPda, initialPageState, publicReceiptPath, type PublicReceiptPageState } from "../receipts/model";
import { ReceiptPageState } from "../receipts/ReceiptCard";
import { configuredDemoReceiptPath } from "../owner/onboarding";

export { isPlausibleReceiptPda, classifyReceiptPda } from "../receipts/model";

function VerifyAddressEntry({ onSubmit }: { onSubmit: (address: string) => void }) {
  const [value, setValue] = useState("");
  const demoPath = configuredDemoReceiptPath(import.meta.env?.VITE_CHAINPAY_DEMO_RECEIPT_PDA);

  return (
    <div className="verify-entry">
      <p className="t-body">Paste a ChainPay receipt address to verify payment without connecting a wallet.</p>
      <form
        className="verify-entry-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          if (trimmed) onSubmit(trimmed);
        }}
      >
        <label className="verify-entry-label" htmlFor="verify-receipt-pda">Receipt address</label>
        <input
          id="verify-receipt-pda"
          className="verify-entry-input mono"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste a Solana receipt PDA"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="button button-primary">Verify receipt</button>
      </form>
      {demoPath && (
        <p className="verify-demo-link">
          <a href={demoPath}>Demo receipt</a>
          <span> · Illustrative finalized receipt for judges</span>
        </p>
      )}
    </div>
  );
}

export function VerifyPage({ receiptPda }: { receiptPda: string }) {
  const trimmed = receiptPda.trim();
  const [draftAddress, setDraftAddress] = useState(trimmed);
  const [state, setState] = useState<PublicReceiptPageState>(() => (
    trimmed ? initialPageState(trimmed) : { kind: "malformed", receiptPda: "" }
  ));

  useEffect(() => {
    setDraftAddress(trimmed);
    if (!trimmed) {
      setState({ kind: "malformed", receiptPda: "" });
      return;
    }
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

  function navigateToAddress(address: string) {
    const path = publicReceiptPath(address);
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

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
        {!trimmed && <VerifyAddressEntry onSubmit={navigateToAddress} />}
        {trimmed && classifyReceiptPda(trimmed) === "plausible" && state.kind !== "verified" && (
          <p className="mono">{trimmed}</p>
        )}
        {trimmed && state.kind === "malformed" && (
          <VerifyAddressEntry onSubmit={navigateToAddress} />
        )}
        {trimmed && (
          <ReceiptPageState
            state={state}
            editableAddress={draftAddress}
            onAddressChange={setDraftAddress}
            onRetry={() => {
              setState({ kind: "loading", receiptPda: trimmed });
              void loadPublicReceiptView(trimmed, { refresh: true }).then(setState);
            }}
            onEditAddress={() => navigateToAddress(draftAddress)}
          />
        )}
      </section>
    </main>
  );
}

export default VerifyPage;
