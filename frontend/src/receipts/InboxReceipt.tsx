import { useEffect, useState } from "react";
import { loadPublicReceiptView } from "./load";
import { type PublicReceiptPageState } from "./model";
import { ReceiptCard, ReceiptPageState } from "./ReceiptCard";

export function LoadedReceiptCard({
  receiptPda,
  shareMode = "public",
  onShare,
}: {
  receiptPda: string;
  shareMode?: "public" | "dashboard";
  onShare?: () => void;
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
    return <ReceiptCard receipt={state.receipt} shareMode={shareMode} onShare={onShare} />;
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

export function InboxReceipt({ receiptAddress }: { receiptAddress?: string }) {
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
      <LoadedReceiptCard receiptPda={receiptAddress} shareMode="dashboard" />
    </div>
  );
}
