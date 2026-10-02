import type { PublicReceiptPageState } from "../../src/receipts/model";
import purchase from "./receipt-purchase.json";

const fixture: PublicReceiptPageState = {
  kind: "verified",
  receiptPda: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
  receipt: {
    address: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
    mandate: "Mandate11111111111111111111111111111111111",
    invoiceHash: "aa".repeat(32),
    paymentId: "bb".repeat(32),
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    sourceTokenAccount: "Source111111111111111111111111111111111111",
    recipientTokenAccount: "Dest1111111111111111111111111111111111111",
    agent: "Agent111111111111111111111111111111111111",
    executedAtSlot: "484791192",
    signatureReference: "cc".repeat(32),
    bump: "255",
    onChainStatus: "1",
    amount: { baseUnits: "4500000", decimals: 6, display: "4.500000", displayKind: "ui-amount" },
    tokenLabel: "USDC",
    currentMandate: { status: "absent" },
    seller: { status: "absent" },
  },
};

/** A v2 receipt that paid the fixture's seller-signed invoice. */
const snapshotFixture: PublicReceiptPageState = {
  kind: "verified",
  receiptPda: "3Rcpt2v2SnapshotFixture111111111111111111",
  receipt: {
    ...fixture.receipt,
    address: "3Rcpt2v2SnapshotFixture111111111111111111",
    invoiceHash: purchase.invoiceHash,
    recipientTokenAccount: purchase.request.payload.recipient,
    policy: {
      source: "on-chain",
      limits: { maxPerPayment: "5000000", totalLimit: "50000000", amountSpentAfter: "12000000", paymentCountAfter: "3", maxPaymentCount: "10", expiresAtSlot: "405000000", cooldownSlots: "0" },
    },
  },
};

export async function loadPublicReceiptView(receiptPda: string): Promise<PublicReceiptPageState> {
  if (receiptPda === fixture.receiptPda) return fixture;
  if (receiptPda === snapshotFixture.receiptPda) return snapshotFixture;
  if (receiptPda === "RpcDown111111111111111111111111111111111") {
    return { kind: "rpc_error", receiptPda, message: "RPC timed out" };
  }
  return { kind: "not_found", receiptPda };
}

export function peekPublicReceiptCache() {
  return undefined;
}
