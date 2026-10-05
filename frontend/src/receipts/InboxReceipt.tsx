import { useEffect, useRef, useState } from "react";
import { loadPublicReceiptView } from "./load";
import { type SellerStatementState, type OrderLinkState, type PublicReceiptPageState, type PurchaseProofState, type ReceiptView } from "./model";
import { loadOwnerReceiptContext } from "./owner";
import { ReceiptCard, ReceiptPageState } from "./ReceiptCard";

export function LoadedReceiptCard({
  receiptPda,
  shareMode = "public",
  onShare,
  preparedInRequests = false,
  seller,
}: {
  receiptPda: string;
  shareMode?: "public" | "dashboard";
  onShare?: () => void;
  preparedInRequests?: boolean;
  /** A seller statement known privately to this request, such as Crossmint's order status. */
  seller?: SellerStatementState;
}) {
  const [state, setState] = useState<PublicReceiptPageState>({ kind: "loading", receiptPda });
  const [owner, setOwner] = useState<{ receiptPda: string; policy?: ReceiptView["policy"]; purchase: PurchaseProofState; order: OrderLinkState } | null>(null);

  // Only the newest load or retry may set the card, so a slow retry for one
  // receipt can't replace a different receipt shown since.
  const loadSeq = useRef(0);

  useEffect(() => {
    const seq = ++loadSeq.current;
    const active = () => loadSeq.current === seq;
    setState({ kind: "loading", receiptPda });
    setOwner(null);
    void loadPublicReceiptView(receiptPda).then((next) => {
      if (!active()) return;
      setState(next);
      // Owner-only additions from the relay: observed limits for a receipt
      // without an on-chain snapshot, and the verified signed invoice.
      if (next.kind === "verified" && shareMode === "dashboard") {
        void loadOwnerReceiptContext(next.receipt).then((context) => {
          if (active()) setOwner({ receiptPda, ...context });
        }).catch(() => undefined);
      }
    });
    return () => {
      loadSeq.current += 1;
    };
  }, [receiptPda, shareMode]);

  if (state.kind === "verified") {
    const ownerContext = owner?.receiptPda === receiptPda ? owner : null;
    const receipt = ownerContext?.policy && state.receipt.policy?.source !== "on-chain"
      ? { ...state.receipt, policy: ownerContext.policy }
      : state.receipt;
    return (
      <ReceiptCard
        receipt={seller ? { ...receipt, seller } : receipt}
        purchase={ownerContext?.purchase}
        order={ownerContext?.order}
        shareMode={shareMode}
        onShare={onShare}
        // Both dashboard call sites pass shareMode="dashboard", so OR-ing it here
        // forced the flag true for every dashboard render and discarded the
        // preparedRequestReceiptAddresses match that Dashboard.tsx computes. Any
        // receipt pasted into the Receipts lookup then claimed it was prepared in
        // Requests with private invoice text behind it. ReceiptCard already
        // requires shareMode === "dashboard" before showing the note.
        preparedInRequests={preparedInRequests}
      />
    );
  }

  return (
    <ReceiptPageState
      state={state}
      onRetry={() => {
        const seq = ++loadSeq.current;
        setState({ kind: "loading", receiptPda });
        void loadPublicReceiptView(receiptPda, { refresh: true }).then((next) => {
          if (loadSeq.current === seq) setState(next);
        });
      }}
    />
  );
}

export function InboxReceipt({
  receiptAddress,
  preparedInRequests = true,
  seller,
}: {
  receiptAddress?: string;
  preparedInRequests?: boolean;
  seller?: SellerStatementState;
}) {
  if (!receiptAddress) {
    return (
      <div className="inbox-receipt inbox-receipt-unavailable" role="status">
        <b>Receipt unavailable</b>
        <p>This inbox item settled without a receipt PDA, so ChainPay cannot render proof here.</p>
      </div>
    );
  }

  return (
    <div className="inbox-receipt">
      <LoadedReceiptCard receiptPda={receiptAddress} shareMode="dashboard" preparedInRequests={preparedInRequests} seller={seller} />
    </div>
  );
}
