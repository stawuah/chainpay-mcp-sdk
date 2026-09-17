// Browser regression fixture: public verify states without RPC or wallet.
import "../../src/polyfills";
import { createRoot } from "react-dom/client";
import { BrandLogo } from "../../src/brand/Brand";
import { ReceiptPageState } from "../../src/receipts/ReceiptCard";
import { initialPageState, type PublicReceiptPageState } from "../../src/receipts/model";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import settled from "./verify-settled.json";

const cases: Record<string, PublicReceiptPageState> = {
  malformed: initialPageState("InvalidPDA"),
  settled: settled as PublicReceiptPageState,
  not_found: { kind: "not_found", receiptPda: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1" },
};

function Fixture() {
  const params = new URLSearchParams(location.search);
  const state = cases[params.get("case") ?? "malformed"] ?? cases.malformed;
  return (
    <main className="site-shell cp-app verify-page" data-fixture="verify-public">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home"><BrandLogo /></a>
        <a className="login-link" href="/">Back to ChainPay</a>
      </header>
      <section className="page-width" style={{ padding: "48px 0 80px" }}>
        <span className="section-kicker">PUBLIC RECEIPT</span>
        <h1 className="t-xl">Payment receipt</h1>
        <ReceiptPageState state={state} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ChainPayTheme><Fixture /></ChainPayTheme>,
);
