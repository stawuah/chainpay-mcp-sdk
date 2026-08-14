import type { ChainPayMcpContext } from "./context.js";
import { serializeTransaction, solanaAddress, tokenProgram as parseTokenProgram, toolResult, unsignedInteger } from "./common.js";
import { parseRemainingAccounts, requireObject } from "./payment-input.js";

type X402Challenge = {
  network?: unknown;
  scheme?: unknown;
  asset?: unknown;
  mint?: unknown;
  payTo?: unknown;
  recipient?: unknown;
  amount?: unknown;
  resource?: unknown;
  nonce?: unknown;
  expiresAtSlot?: unknown;
  tokenProgram?: unknown;
  remainingAccounts?: unknown;
};

function requiredChallengeString(challenge: X402Challenge, key: "amount" | "nonce"): string {
  const value = challenge[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`x402 challenge ${key} is required`);
  return value.trim();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value).slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function normalizeChallenge(challenge: X402Challenge) {
  const network = typeof challenge.network === "string" ? challenge.network : "devnet";
  if (network !== "devnet" && network !== "solana-devnet") {
    throw new Error("Only Solana Devnet x402 challenges are enabled");
  }
  const scheme = typeof challenge.scheme === "string" ? challenge.scheme : "exact";
  if (scheme !== "exact") throw new Error("Only the x402 exact scheme is enabled");
  const asset = solanaAddress(challenge.asset ?? challenge.mint, "asset");
  const recipient = solanaAddress(challenge.payTo ?? challenge.recipient, "payTo");
  const amount = requiredChallengeString(challenge, "amount");
  unsignedInteger(amount, "amount");
  const nonce = requiredChallengeString(challenge, "nonce");
  const resource = typeof challenge.resource === "string" ? challenge.resource : "x402-resource";
  const tokenProgram: "spl-token" | "token-2022" = challenge.tokenProgram === undefined
    ? "spl-token"
    : parseTokenProgram(challenge.tokenProgram);
  const remainingAccounts = parseRemainingAccounts(challenge.remainingAccounts);
  const expiresAtSlot = challenge.expiresAtSlot === undefined
    ? undefined
    : unsignedInteger(challenge.expiresAtSlot, "expiresAtSlot").toString();
  const canonical = JSON.stringify({
    network,
    scheme,
    asset,
    recipient,
    amount,
    resource,
    nonce,
    ...(expiresAtSlot ? { expiresAtSlot } : {}),
    ...(remainingAccounts ? { remainingAccounts } : {}),
  });
  const invoiceHash = await sha256Hex(canonical);
  return {
    network,
    scheme,
    mint: asset,
    recipient,
    amount,
    tokenProgram,
    ...(remainingAccounts ? { remainingAccounts } : {}),
    resource,
    nonce,
    invoiceHash,
    paymentId: await sha256Hex(`payment:${invoiceHash}`),
    signatureReference: await sha256Hex(`x402:${invoiceHash}`),
    ...(expiresAtSlot ? { expiresAtSlot } : {}),
  };
}

export async function prepareX402Payment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const challenge = await normalizeChallenge(requireObject(args.challenge) as X402Challenge);
  const mandate = solanaAddress(args.mandate, "mandate");
  const agent = solanaAddress(args.agent, "agent");
  if (challenge.expiresAtSlot !== undefined && BigInt(challenge.expiresAtSlot) <= await context.client.getCurrentSlot()) {
    return toolResult({ action: "x402_expired", challenge }, true);
  }
  const prepared = await context.client.preparePayment({
    mandate,
    invoiceHash: hexBytes(challenge.invoiceHash),
    paymentId: hexBytes(challenge.paymentId),
    signatureReference: hexBytes(challenge.signatureReference),
    mint: challenge.mint,
    recipient: challenge.recipient,
    amount: BigInt(challenge.amount),
    tokenProgram: challenge.tokenProgram,
    remainingAccounts: challenge.remainingAccounts,
  }, agent);

  const signedTransaction = typeof args.signedTransaction === "string"
    ? args.signedTransaction.trim()
    : undefined;
  if (signedTransaction) {
    if (!context.backendUrl) {
      return toolResult({
        action: "backend_required",
        challenge,
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        transaction: serializeTransaction(prepared.transaction),
        message: "CHAINPAY_BACKEND_URL must be configured to relay a signed x402 transaction.",
      }, true);
    }

    const response = await fetch(`${context.backendUrl.replace(/\/$/, "")}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(context.backendAuthToken
          ? { Authorization: `Bearer ${context.backendAuthToken}` }
          : {}),
      },
      body: JSON.stringify({
        idempotency_key: `x402:${mandate}:${challenge.invoiceHash}`,
        mandate,
        invoice_hash: challenge.invoiceHash,
        receipt_address: prepared.receiptAddress,
        signed_transaction: signedTransaction,
        agent,
        mint: challenge.mint,
        recipient: challenge.recipient,
        amount: challenge.amount,
        token_program: challenge.tokenProgram,
      }),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) return toolResult({ action: "backend_rejected", challenge, ...payload }, true);
    return toolResult({
      action: "x402_backend_relayed",
      challenge,
      ...payload,
      receiptAddress: prepared.receiptAddress,
      preflight: prepared.preflight,
    }, payload.status === "failed");
  }

  return toolResult({
    action: "x402_agent_signature_required",
    challenge,
    receiptAddress: prepared.receiptAddress,
    preflight: prepared.preflight,
    transaction: serializeTransaction(prepared.transaction),
    message: "An external signer must review and sign this x402 settlement transaction.",
  }, !prepared.preflight.valid);
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
