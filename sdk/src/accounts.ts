import { PublicKey } from "@solana/web3.js";
import type {
  Address,
  Mandate,
  PaymentReceipt,
  PaymentStatus,
  TokenProgram,
} from "./types.js";
import { ACCOUNT_DISCRIMINATORS, RECEIPT_STATUS_SETTLED } from "./constants.js";
import {
  address,
  assertDiscriminator,
  readBytes32,
  readPublicKey,
  readU8,
  readU64,
} from "./encoding.js";

const ACCOUNT_DISCRIMINATOR_LENGTH = 8;
const DEFAULT_ADDRESS = PublicKey.default.toBase58();

function accountBytes(data: Uint8Array | Buffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function requireLength(data: Uint8Array, length: number, accountName: string): void {
  if (data.length < length) throw new Error(`${accountName} account data is truncated`);
}

function mandateStatus(
  paused: boolean,
  revoked: boolean,
  expiresAtSlot: bigint,
  currentSlot?: bigint,
): Mandate["status"] {
  if (revoked) return "revoked";
  if (paused) return "paused";
  if (currentSlot !== undefined && expiresAtSlot <= currentSlot) return "expired";
  return "active";
}

export function decodeProtocolConfig(data: Uint8Array | Buffer, configAddress?: Address) {
  const bytes = accountBytes(data);
  assertDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.protocolConfig, "ProtocolConfig");
  requireLength(bytes, 145, "ProtocolConfig");
  const supportedMints = [
    readPublicKey(bytes, 40),
    readPublicKey(bytes, 72),
    readPublicKey(bytes, 104),
  ].filter((mint) => mint !== DEFAULT_ADDRESS);

  return {
    address: configAddress ? address(configAddress) : undefined,
    authority: readPublicKey(bytes, ACCOUNT_DISCRIMINATOR_LENGTH),
    supportedMints,
    bump: readU8(bytes, 136),
  };
}

export function decodeMandate(
  data: Uint8Array | Buffer,
  mandateAddress: Address,
  currentSlot?: bigint,
  tokenProgram?: TokenProgram,
): Mandate {
  const bytes = accountBytes(data);
  assertDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.paymentMandate, "PaymentMandate");
  requireLength(bytes, 211, "PaymentMandate");
  const expiresAtSlot = readU64(bytes, 200);
  const paused = readU8(bytes, 208) !== 0;
  const revoked = readU8(bytes, 209) !== 0;

  return {
    address: address(mandateAddress),
    owner: readPublicKey(bytes, 8),
    approvedAgent: readPublicKey(bytes, 40),
    sourceTokenAccount: readPublicKey(bytes, 72),
    allowedMint: readPublicKey(bytes, 104),
    allowedRecipient: readPublicKey(bytes, 136),
    maxPerPayment: readU64(bytes, 168),
    totalLimit: readU64(bytes, 176),
    amountSpent: readU64(bytes, 184),
    paymentCount: readU64(bytes, 192),
    expiresAtSlot,
    paused,
    revoked,
    status: mandateStatus(paused, revoked, expiresAtSlot, currentSlot),
    tokenProgram,
  };
}

function paymentStatus(onChainStatus: number): PaymentStatus {
  return onChainStatus === RECEIPT_STATUS_SETTLED ? "confirmed" : "failed";
}

export function decodePaymentReceipt(
  data: Uint8Array | Buffer,
  receiptAddress: Address,
  transactionSignature?: string,
): PaymentReceipt {
  const bytes = accountBytes(data);
  assertDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.paymentReceipt, "PaymentReceipt");
  requireLength(bytes, 282, "PaymentReceipt");
  const onChainStatus = readU8(bytes, 280);

  return {
    address: address(receiptAddress),
    mandate: readPublicKey(bytes, 8),
    invoiceHash: readBytes32(bytes, 40, "invoiceHash"),
    paymentId: readBytes32(bytes, 72, "paymentId"),
    mint: readPublicKey(bytes, 104),
    sourceTokenAccount: readPublicKey(bytes, 136),
    recipientTokenAccount: readPublicKey(bytes, 168),
    recipient: readPublicKey(bytes, 168),
    amount: readU64(bytes, 200),
    agent: readPublicKey(bytes, 208),
    executedAtSlot: readU64(bytes, 240),
    signatureReference: readBytes32(bytes, 248, "signatureReference"),
    status: paymentStatus(onChainStatus),
    onChainStatus,
    bump: readU8(bytes, 281),
    transactionSignature,
  };
}
