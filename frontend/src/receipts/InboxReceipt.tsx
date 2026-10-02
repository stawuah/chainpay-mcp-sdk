import { useEffect, useState } from "react";
import { loadPublicReceiptView } from "./load";
import { type OrderLinkState, type PublicReceiptPageState, type PurchaseProofState, type ReceiptView } from "./model";
import { loadOwnerReceiptContext } from "./owner";
import { ReceiptCard, ReceiptPageState } from "./ReceiptCard";

export function LoadedReceiptCard({
  receiptPda,
  shareMode = "public",
  onShare,
  preparedInRequests = false,
}: {
  receiptPda: string;
  shareMode?: "public" | "dashboard";
  onShare?: () => void;
  preparedInRequests?: boolean;
}) {
  const [state, setState] = useState<PublicReceiptPageState>({ kind: "loading", receiptPda });
  const [owner, setOwner] = useState<{ receiptPda: string; policy?: ReceiptView["policy"]; purchase: PurchaseProofState; order: OrderLinkState } | null>(null);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading", receiptPda });
    setOwner(null);
    void loadPublicReceiptView(receiptPda).then((next) => {
      if (!active) return;
      setState(next);
      // Owner-only additions from the relay: observed limits for a receipt
      // without an on-chain snapshot, and the verified signed invoice.
      if (next.kind === "verified" && shareMode === "dashboard") {
        void loadOwnerReceiptContext(next.receipt).then((context) => {
          if (active) setOwner({ receiptPda, ...context });
        }).catch(() => undefined);
      }
    });
    return () => {
      active = false;
    };
  }, [receiptPda, shareMode]);

  if (state.kind === "verified") {
    const ownerContext = owner?.receiptPda === receiptPda ? owner : null;
    const receipt = ownerContext?.policy && state.receipt.policy?.source !== "on-chain"
      ? { ...state.receipt, policy: ownerContext.policy }
      : state.receipt;
    return (
      <ReceiptCard
        receipt={receipt}
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
        void loadPublicReceiptView(receiptPda, { refresh: true }).then(setState);
      }}
    />
  );
}

export function InboxReceipt({
  receiptAddress,
  preparedInRequests = true,
}: {
  receiptAddress?: string;
  preparedInRequests?: boolean;
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
      <LoadedReceiptCard receiptPda={receiptAddress} shareMode="dashboard" preparedInRequests={preparedInRequests} />
    </div>
  );
}
