import type { Address, PaymentReceipt, PaymentStatus } from "./types.js";
import { decodePaymentReceipt } from "./accounts.js";
import { deriveReceiptAddress } from "./pda.js";
import { DEFAULT_PROGRAM_ID } from "./constants.js";

export function createReceiptReference(
  address: Address,
  mandate: Address,
  invoiceHash: Uint8Array,
  status: PaymentStatus,
): Pick<PaymentReceipt, "address" | "mandate" | "invoiceHash" | "status"> {
  return { address, mandate, invoiceHash, status };
}

export function receiptAddress(
  mandate: Address,
  invoiceHash: Uint8Array,
  programId: Address = DEFAULT_PROGRAM_ID,
): Address {
  return deriveReceiptAddress(mandate, invoiceHash, programId);
}

export { decodePaymentReceipt };

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value: string, name: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length !== 64) {
    throw new Error(`${name} must be exactly 32 bytes encoded as hexadecimal`);
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
