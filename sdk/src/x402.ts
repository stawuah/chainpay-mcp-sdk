import type { Address, TokenProgram } from "./types.js";

export type X402ExactPayment = {
  mint: Address;
  recipient: Address;
  amount: string;
  resource: string;
  tokenProgram: TokenProgram;
  nonce?: string;
  expiresAtSlot?: string;
};

export type X402PaymentReferences = {
  nonce: string;
  invoiceHash: string;
  paymentId: string;
  signatureReference: string;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value).slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Canonical references shared by the x402 client and independent merchant verifier. */
export async function deriveX402PaymentReferences(input: X402ExactPayment): Promise<X402PaymentReferences> {
  const nonceSeed = JSON.stringify({
    network: "solana-devnet",
    scheme: "exact",
    mint: input.mint,
    recipient: input.recipient,
    amount: input.amount,
    resource: input.resource,
    expiresAtSlot: input.expiresAtSlot,
  });
  const nonce = input.nonce?.trim() || (await sha256Hex(`nonce:${nonceSeed}`)).slice(0, 32);
  const canonical = JSON.stringify({
    network: "solana-devnet",
    scheme: "exact",
    asset: input.mint,
    payTo: input.recipient,
    amount: input.amount,
    resource: input.resource,
    nonce,
    tokenProgram: input.tokenProgram,
    ...(input.expiresAtSlot ? { expiresAtSlot: input.expiresAtSlot } : {}),
  });
  const invoiceHash = await sha256Hex(canonical);
  return {
    nonce,
    invoiceHash,
    paymentId: await sha256Hex(`payment:${invoiceHash}`),
    signatureReference: await sha256Hex(`x402:${invoiceHash}`),
  };
}
