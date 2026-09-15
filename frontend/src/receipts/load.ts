import {
  bytesToHex,
  formatExactTokenAmount,
  type CurrentMandateRead,
  type PaymentReceipt,
  type PublicReceiptProof,
  type ReceiptValidationCode,
  type TokenAmountDisplay,
} from "@chainpay/sdk";
import { PROGRAM_ID, publicReceiptClient } from "../config/client";
import { DEVNET_PYUSD_TOKEN_2022_MINT, DEVNET_USDC_MINT } from "../config/public";
import {
  classifyReceiptPda,
  type CurrentMandateView,
  type PublicReceiptPageState,
  type ReceiptAmountView,
  type ReceiptView,
  type SellerStatementState,
} from "./model";
import { loadSellerStatement } from "./seller";

const cache = new Map<string, PublicReceiptPageState>();
const inflight = new Map<string, Promise<PublicReceiptPageState>>();

export function tokenLabelForMint(mint: string): string {
  if (mint === DEVNET_USDC_MINT) return "USDC";
  if (mint === DEVNET_PYUSD_TOKEN_2022_MINT) return "PYUSD";
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function amountView(amount: TokenAmountDisplay): ReceiptAmountView {
  return {
    baseUnits: amount.baseUnits,
    decimals: amount.decimals,
    display: amount.display,
    displayKind: amount.displayKind,
  };
}

function currentMandateView(read: CurrentMandateRead): CurrentMandateView {
  if (read.status === "present") {
    const mandate = read.mandate;
    return {
      status: "present",
      fields: {
        status: mandate.status,
        paused: mandate.paused,
        revoked: mandate.revoked,
        maxPerPayment: mandate.maxPerPayment.toString(),
        totalLimit: mandate.totalLimit.toString(),
        amountSpent: mandate.amountSpent.toString(),
        paymentCount: mandate.paymentCount.toString(),
        maxPaymentCount: mandate.maxPaymentCount.toString(),
        cooldownSlots: mandate.cooldownSlots.toString(),
        expiresAtSlot: mandate.expiresAtSlot.toString(),
      },
    };
  }
  if (read.status === "unavailable") return { status: "unavailable", reason: read.reason };
  return { status: "absent" };
}

export function receiptViewFromProof(
  proof: Extract<PublicReceiptProof["receipt"], { valid: true }>,
  amount: TokenAmountDisplay,
  currentMandate: CurrentMandateRead,
  seller: SellerStatementState,
): ReceiptView {
  const receipt = proof.receipt;
  return {
    address: receipt.address,
    mandate: receipt.mandate,
    invoiceHash: bytesToHex(receipt.invoiceHash),
    paymentId: bytesToHex(receipt.paymentId),
    mint: receipt.mint,
    sourceTokenAccount: receipt.sourceTokenAccount,
    recipientTokenAccount: receipt.recipientTokenAccount,
    recipient: receipt.recipient,
    agent: receipt.agent,
    executedAtSlot: receipt.executedAtSlot.toString(),
    signatureReference: bytesToHex(receipt.signatureReference),
    bump: receipt.bump.toString(),
    onChainStatus: receipt.onChainStatus.toString(),
    transactionSignature: receipt.transactionSignature,
    amount: amountView(amount),
    tokenLabel: tokenLabelForMint(receipt.mint),
    currentMandate: currentMandateView(currentMandate),
    seller,
  };
}

export function receiptViewFromSettledPayment(
  receipt: PaymentReceipt,
  decimals: number | null,
  seller: SellerStatementState = { status: "absent" },
  currentMandate: CurrentMandateView = { status: "absent" },
): ReceiptView | null {
  if (receipt.status !== "confirmed" || receipt.onChainStatus !== 1) return null;
  return {
    address: receipt.address,
    mandate: receipt.mandate,
    invoiceHash: bytesToHex(receipt.invoiceHash),
    paymentId: bytesToHex(receipt.paymentId),
    mint: receipt.mint,
    sourceTokenAccount: receipt.sourceTokenAccount,
    recipientTokenAccount: receipt.recipientTokenAccount,
    recipient: receipt.recipient,
    agent: receipt.agent,
    executedAtSlot: receipt.executedAtSlot.toString(),
    signatureReference: bytesToHex(receipt.signatureReference),
    bump: receipt.bump.toString(),
    onChainStatus: receipt.onChainStatus.toString(),
    transactionSignature: receipt.transactionSignature,
    amount: amountView(formatExactTokenAmount(receipt.amount, decimals)),
    tokenLabel: tokenLabelForMint(receipt.mint),
    currentMandate,
    seller,
  };
}

function cacheKey(receiptPda: string): string {
  return `${PROGRAM_ID}:${receiptPda}`;
}

async function readPageState(receiptPda: string): Promise<PublicReceiptPageState> {
  if (classifyReceiptPda(receiptPda) !== "plausible") {
    return { kind: "malformed", receiptPda };
  }

  let proof: PublicReceiptProof;
  try {
    proof = await publicReceiptClient.readPublicReceipt(receiptPda);
  } catch (error) {
    return {
      kind: "rpc_error",
      receiptPda,
      message: error instanceof Error ? error.message : "The Solana RPC request failed.",
    };
  }

  if (!proof.receipt.valid) {
    if (proof.receipt.code === "not_found") {
      return { kind: "not_found", receiptPda };
    }
    return {
      kind: "invalid",
      receiptPda,
      code: proof.receipt.code as ReceiptValidationCode,
      reason: proof.receipt.reason,
    };
  }

  const amount = proof.amount ?? formatExactTokenAmount(proof.receipt.receipt.amount, null);
  let seller: SellerStatementState = { status: "absent" };
  try {
    seller = await loadSellerStatement({
      receiptAddress: proof.receipt.receipt.address,
      recipientTokenAccount: proof.receipt.receipt.recipientTokenAccount,
    });
  } catch (error) {
    seller = {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "Seller statement could not be checked.",
    };
  }

  return {
    kind: "verified",
    receiptPda: proof.receipt.receipt.address,
    receipt: receiptViewFromProof(proof.receipt, amount, proof.currentMandate, seller),
  };
}

export function loadPublicReceiptView(
  receiptPda: string,
  options: { refresh?: boolean } = {},
): Promise<PublicReceiptPageState> {
  const trimmed = receiptPda.trim();
  const key = cacheKey(trimmed);
  if (!options.refresh) {
    const hit = cache.get(key);
    if (hit && hit.kind !== "rpc_error") return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const request = readPageState(trimmed).then((state) => {
    if (state.kind !== "rpc_error") cache.set(key, state);
    else cache.delete(key);
    inflight.delete(key);
    return state;
  }, (error) => {
    inflight.delete(key);
    throw error;
  });
  inflight.set(key, request);
  return request;
}

export function peekPublicReceiptCache(receiptPda: string): PublicReceiptPageState | undefined {
  return cache.get(cacheKey(receiptPda.trim()));
}
