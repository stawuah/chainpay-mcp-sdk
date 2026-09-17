import type { PublicReceiptPageState } from "../../src/receipts/model";

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

export async function loadPublicReceiptView(receiptPda: string): Promise<PublicReceiptPageState> {
  if (receiptPda === fixture.receiptPda) return fixture;
  if (receiptPda === "RpcDown111111111111111111111111111111111") {
    return { kind: "rpc_error", receiptPda, message: "RPC timed out" };
  }
  return { kind: "not_found", receiptPda };
}

export function peekPublicReceiptCache() {
  return undefined;
}
