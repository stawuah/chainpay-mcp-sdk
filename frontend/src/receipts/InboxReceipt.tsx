import { useEffect, useState } from "react";
import { loadPublicReceiptView } from "./load";
import { type PublicReceiptPageState, type SellerStatementState } from "./model";
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

  useEffect(() => {
    let active = true;
    setState({ kind: "loading", receiptPda });
    void loadPublicReceiptView(receiptPda).then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [receiptPda]);

  if (state.kind === "verified") {
    return (
      <ReceiptCard
        receipt={seller ? { ...state.receipt, seller } : state.receipt}
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
        void loadPublicReceiptView(receiptPda, { refresh: true }).then(setState);
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
