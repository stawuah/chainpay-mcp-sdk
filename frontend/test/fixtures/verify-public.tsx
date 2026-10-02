// Browser regression fixture: public verify states without RPC or wallet.
import "../../src/polyfills";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrandLogo } from "../../src/brand/Brand";
import { ReceiptPageState } from "../../src/receipts/ReceiptCard";
import { initialPageState, purchaseFragmentFromHash, type PublicReceiptPageState, type PurchaseProofState, type ReceiptView } from "../../src/receipts/model";
import { decodePurchaseFragment, verifyPurchaseForReceipt } from "../../src/receipts/purchase";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import settled from "./verify-settled.json";
import purchase from "./receipt-purchase.json";

const settledReceipt = (settled as Extract<PublicReceiptPageState, { kind: "verified" }>).receipt;

// The receipt as a v2 account: the program's snapshot, today's mandate, and
// the invoice hash of the fixture's seller-signed request.
const v2Receipt: ReceiptView = {
  ...settledReceipt,
  address: "3Rcpt2v2SnapshotFixture111111111111111111",
  invoiceHash: purchase.invoiceHash,
  recipientTokenAccount: purchase.request.payload.recipient,
  currentSlot: "399999500",
  policy: {
    source: "on-chain",
    limits: { maxPerPayment: "5000000", totalLimit: "50000000", amountSpentAfter: "12000000", paymentCountAfter: "3", maxPaymentCount: "10", expiresAtSlot: "405000000", cooldownSlots: "0" },
  },
  currentMandate: {
    status: "present",
    fields: {
      status: "paused", paused: true, revoked: false,
      maxPerPayment: "5.000000", totalLimit: "50.000000", amountSpent: "12.000000",
      paymentCount: "3", maxPaymentCount: "10", cooldownSlots: "0", expiresAtSlot: "405000000",
      baseUnits: { maxPerPayment: "5000000", totalLimit: "50000000", amountSpent: "12000000" },
    },
  },
};

const relayReceipt: ReceiptView = {
  ...v2Receipt,
  address: "4RelayObservedFixture11111111111111111111",
  policy: {
    source: "relay-observed",
    limits: { maxPerPayment: "5000000", totalLimit: "50000000", amountSpentAfter: "21000000", paymentCountAfter: "5", maxPaymentCount: "10", expiresAtSlot: "405000000", cooldownSlots: "0" },
    observedAtSlot: "399999300",
    includesLaterPayments: true,
  },
  currentMandate: {
    status: "present",
    fields: {
      status: "active", paused: false, revoked: false,
      maxPerPayment: "3.000000", totalLimit: "50.000000", amountSpent: "21.000000",
      paymentCount: "5", maxPaymentCount: "10", cooldownSlots: "0", expiresAtSlot: "405000000",
      baseUnits: { maxPerPayment: "3000000", totalLimit: "50000000", amountSpent: "21000000" },
    },
  },
};

const cases: Record<string, PublicReceiptPageState> = {
  malformed: initialPageState("InvalidPDA"),
  settled: settled as PublicReceiptPageState,
  not_found: { kind: "not_found", receiptPda: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1" },
  v2: { kind: "verified", receiptPda: v2Receipt.address, receipt: v2Receipt },
  relay: { kind: "verified", receiptPda: relayReceipt.address, receipt: relayReceipt },
};

/** Same audit-link rule as VerifyPage: content only after it verifies here. */
function usePurchaseFromHash(state: PublicReceiptPageState): PurchaseProofState | undefined {
  const [result, setResult] = useState<PurchaseProofState | undefined>(undefined);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    setResult(undefined);
    if (state.kind !== "verified") return;
    const fragment = purchaseFragmentFromHash(hash);
    if (!fragment) return;
    const request = decodePurchaseFragment(fragment);
    if (!request) {
      setResult({ status: "failed", via: "link", reason: "the invoice in this link could not be read" });
      return;
    }
    void verifyPurchaseForReceipt(state.receipt, request, "link").then(setResult);
  }, [state, hash]);
  return result;
}

function Fixture() {
  const params = new URLSearchParams(location.search);
  const state = cases[params.get("case") ?? "malformed"] ?? cases.malformed;
  const purchaseState = usePurchaseFromHash(state);
  return (
    <main className="site-shell cp-app verify-page" data-fixture="verify-public">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home"><BrandLogo /></a>
        <a className="login-link" href="/">Back to ChainPay</a>
      </header>
      <section className="page-width" style={{ padding: "48px 0 80px" }}>
        <span className="section-kicker">PUBLIC RECEIPT</span>
        <h1 className="t-xl">Payment receipt</h1>
        <ReceiptPageState state={state} purchase={purchaseState} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ChainPayTheme><Fixture /></ChainPayTheme>,
);
