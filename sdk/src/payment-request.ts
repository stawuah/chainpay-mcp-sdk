import { PublicKey } from "@solana/web3.js";
import type {
  PaymentRequestPayload,
  PaymentRequestVerification,
  SignedPaymentRequest,
} from "./types.js";
import { address, tokenProgramAddress } from "./encoding.js";

const MAX_U64 = 18_446_744_073_709_551_615n;

function orderedPayload(payload: PaymentRequestPayload): PaymentRequestPayload {
  return {
    version: 1,
    cluster: payload.cluster,
    merchant: address(payload.merchant),
    invoice: payload.invoice,
    mint: address(payload.mint),
    tokenProgram: payload.tokenProgram,
    recipient: address(payload.recipient),
    amount: payload.amount,
    decimals: payload.decimals,
    nonce: payload.nonce,
    ...(payload.expiresAtSlot === undefined ? {} : { expiresAtSlot: payload.expiresAtSlot }),
    ...(payload.resource === undefined ? {} : { resource: payload.resource }),
  };
}

export function canonicalPaymentRequest(payload: PaymentRequestPayload): string {
  return JSON.stringify(orderedPayload(payload));
}

function base64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", value.slice().buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

function validationError(payload: PaymentRequestPayload, reason: string): PaymentRequestVerification {
  return { valid: false, payload, invoiceHash: new Uint8Array(32), reason };
}

export async function verifyPaymentRequest(
  request: SignedPaymentRequest,
  currentSlot?: bigint,
): Promise<PaymentRequestVerification> {
  const payload = orderedPayload(request.payload);
  try {
    if (payload.version !== 1) return validationError(payload, "Unsupported payment request version");
    if (payload.cluster !== "devnet" && payload.cluster !== "mainnet-beta") {
      return validationError(payload, "Unsupported Solana cluster");
    }
    if (!payload.invoice.trim() || !payload.nonce.trim()) {
      return validationError(payload, "Payment request invoice and nonce are required");
    }
    if (!/^\d+$/.test(payload.amount)) return validationError(payload, "Amount must be an unsigned integer string");
    const amount = BigInt(payload.amount);
    if (amount <= 0n || amount > MAX_U64) return validationError(payload, "Amount must fit in u64 and be positive");
    if (!Number.isInteger(payload.decimals) || payload.decimals < 0 || payload.decimals > 255) {
      return validationError(payload, "Decimals must be between 0 and 255");
    }
    if (payload.tokenProgram !== "spl-token" && payload.tokenProgram !== "token-2022") {
      return validationError(payload, "Unsupported token program");
    }
    address(payload.merchant);
    address(payload.mint);
    address(payload.recipient);
    if (payload.expiresAtSlot !== undefined) {
      if (!/^\d+$/.test(payload.expiresAtSlot)) return validationError(payload, "Expiry slot must be an unsigned integer");
      if (currentSlot !== undefined && BigInt(payload.expiresAtSlot) <= currentSlot) {
        return validationError(payload, "Payment request has expired");
      }
    }

    const signature = base64Bytes(request.signature);
    if (signature.length !== 64) return validationError(payload, "Ed25519 signature must be 64 bytes");
    const merchant = new PublicKey(payload.merchant).toBytes();
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      merchant.slice().buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(canonicalPaymentRequest(payload));
    const validSignature = await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      signature.slice().buffer as ArrayBuffer,
      message.slice().buffer as ArrayBuffer,
    );
    if (!validSignature) return validationError(payload, "Payment request signature is invalid");

    const invoiceHash = await sha256(message);
    return { valid: true, payload, invoiceHash };
  } catch (error) {
    return validationError(payload, error instanceof Error ? error.message : String(error));
  }
}

export function paymentRequestTokenProgramAddress(request: PaymentRequestPayload): string {
  return tokenProgramAddress(request.tokenProgram);
}
