import { createHash } from "node:crypto";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function derivePaymentReferences(invoiceHash: string, signature: string) {
  return {
    paymentId: sha256Hex(`payment:${invoiceHash}`),
    signatureReference: sha256Hex(`merchant-signature:${signature}`),
  };
}
