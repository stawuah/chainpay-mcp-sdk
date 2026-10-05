import { BrandLogo } from "../brand/Brand";
import { useEffect, useRef, useState } from "react";
import { loadPublicReceiptView } from "../receipts/load";
import {
  classifyReceiptPda,
  initialPageState,
  orderFragmentFromHash,
  publicReceiptPath,
  purchaseFragmentFromHash,
  type OrderLinkState,
  type PublicReceiptPageState,
  type PurchaseProofState,
} from "../receipts/model";
import { decodeOrderFragment, verifyOrderForReceipt } from "../receipts/order";
import { decodePurchaseFragment, verifyPurchaseForReceipt } from "../receipts/purchase";
import { ReceiptPageState } from "../receipts/ReceiptCard";
import { configuredDemoReceiptPath } from "../owner/onboarding";
import { DEMO_RECEIPT_PATH } from "../receipts/demoReceipt";
import { parseReceiptInput } from "./receiptInput";

export { isPlausibleReceiptPda, classifyReceiptPda } from "../receipts/model";

function VerifyAddressEntry({ onSubmit }: { onSubmit: (address: string, hash: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const demoPath = configuredDemoReceiptPath(import.meta.env?.VITE_CHAINPAY_DEMO_RECEIPT_PDA) ?? DEMO_RECEIPT_PATH;

  return (
    <div className="verify-entry">
      <p className="t-body">Paste a receipt address or a receipt link. No wallet needed.</p>
      <form
        className="verify-entry-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // Parsed here only. A pasted link's site is never contacted.
          const parsed = parseReceiptInput(value);
          if (!parsed.ok) {
            setError(parsed.error);
            return;
          }
          setError("");
          onSubmit(parsed.receiptPda, parsed.hash);
        }}
      >
        <label className="verify-entry-label" htmlFor="verify-receipt-pda">Receipt address or link</label>
        <input
          id="verify-receipt-pda"
          className="verify-entry-input mono"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError("");
          }}
          placeholder="Receipt address or https://…/verify/…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "verify-receipt-error" : undefined}
        />
        <button type="submit" className="button button-primary">Verify receipt</button>
      </form>
      {error && <p id="verify-receipt-error" className="verify-entry-error" role="alert">{error}</p>}
      <p className="verify-demo-link">
        <a href={demoPath}>Demo receipt</a>
        <span> · A real payment on Solana Devnet</span>
      </p>
    </div>
  );
}

export function VerifyPage({ receiptPda }: { receiptPda: string }) {
  const trimmed = receiptPda.trim();
  const [draftAddress, setDraftAddress] = useState(trimmed);
  const [state, setState] = useState<PublicReceiptPageState>(() => (
    trimmed ? initialPageState(trimmed) : { kind: "malformed", receiptPda: "" }
  ));
  const [purchase, setPurchase] = useState<PurchaseProofState | undefined>(undefined);
  const [order, setOrder] = useState<OrderLinkState | undefined>(undefined);
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  // Each load or retry takes a number. Only the newest one may set the page,
  // so a slow retry for one receipt can't land on another.
  const loadSeq = useRef(0);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // An audit link carries the seller-signed invoice in the URL fragment, which
  // never reaches a server. Nothing from it shows until it verifies against
  // this receipt's on-chain invoice hash and the seller's signature.
  useEffect(() => {
    setPurchase(undefined);
    if (state.kind !== "verified") return;
    const fragment = purchaseFragmentFromHash(hash);
    if (!fragment) return;
    let active = true;
    const request = decodePurchaseFragment(fragment);
    if (!request) {
      setPurchase({ status: "failed", via: "link", reason: "the invoice in this link could not be read" });
      return;
    }
    void verifyPurchaseForReceipt(state.receipt, request, "link").then((result) => {
      if (active) setPurchase(result);
    });
    return () => {
      active = false;
    };
  }, [state, hash]);

  // The same audit link may also carry the requester-signed order. It shows
  // only after its signature verifies and it matches this receipt's token
  // (and, for a budget request, the agent that paid).
  useEffect(() => {
    setOrder(undefined);
    if (state.kind !== "verified") return;
    const fragment = orderFragmentFromHash(hash);
    if (!fragment) return;
    let active = true;
    const request = decodeOrderFragment(fragment);
    if (!request) {
      setOrder({ status: "failed", via: "link", reason: "the order in this link could not be read" });
      return;
    }
    void verifyOrderForReceipt(state.receipt, request, "link").then((result) => {
      if (active) setOrder(result);
    });
    return () => {
      active = false;
    };
  }, [state, hash]);

  useEffect(() => {
    setDraftAddress(trimmed);
    if (!trimmed) {
      setState({ kind: "malformed", receiptPda: "" });
      return;
    }
    const seq = ++loadSeq.current;
    const next = initialPageState(trimmed);
    setState(next);
    if (next.kind !== "loading") return;
    void loadPublicReceiptView(trimmed).then((result) => {
      if (loadSeq.current === seq) setState(result);
    });
    return () => {
      loadSeq.current += 1;
    };
  }, [trimmed]);

  function retry() {
    const seq = ++loadSeq.current;
    setState({ kind: "loading", receiptPda: trimmed });
    void loadPublicReceiptView(trimmed, { refresh: true }).then((result) => {
      if (loadSeq.current === seq) setState(result);
    });
  }

  function navigateToAddress(address: string, nextHash = "") {
    const path = publicReceiptPath(address);
    window.history.pushState({}, "", `${path}${nextHash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    setHash(nextHash);
  }

  function checkDraftAddress() {
    const parsed = parseReceiptInput(draftAddress);
    if (parsed.ok) navigateToAddress(parsed.receiptPda, parsed.hash);
    else navigateToAddress(draftAddress);
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
            purchase={purchase}
            order={order}
            editableAddress={draftAddress}
            onAddressChange={setDraftAddress}
            onRetry={retry}
            onEditAddress={checkDraftAddress}
          />
        )}
      </section>
    </main>
  );
}

export default VerifyPage;
