import { PublicKey } from "@solana/web3.js";
import type {
  Address,
  Mandate,
  PaymentReceipt,
  PaymentStatus,
  SupportedAsset,
  TokenProgram,
} from "./types.js";
import { ACCOUNT_DISCRIMINATORS, RECEIPT_STATUS_SETTLED } from "./constants.js";
import {
  address,
  assertDiscriminator,
  isMandateNonce,
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
  requireLength(bytes, 137, "ProtocolConfig");
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

export function decodeSupportedAsset(
  data: Uint8Array | Buffer,
  assetAddress: Address,
): SupportedAsset {
  const bytes = accountBytes(data);
  assertDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.supportedAsset, "SupportedAsset");
  requireLength(bytes, 106, "SupportedAsset");
  return {
    address: address(assetAddress),
    authority: readPublicKey(bytes, 8),
    mint: readPublicKey(bytes, 40),
    tokenProgram: readPublicKey(bytes, 72),
    enabled: readU8(bytes, 104) !== 0,
    bump: readU8(bytes, 105),
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
  requireLength(bytes, 235, "PaymentMandate");
  const expiresAtSlot = readU64(bytes, 200);
  const maxPaymentCount = readU64(bytes, 208);
  const cooldownSlots = readU64(bytes, 216);
  const lastPaymentSlot = readU64(bytes, 224);
  const paused = readU8(bytes, 232) !== 0;
  const revoked = readU8(bytes, 233) !== 0;
  const legacyAllowedRecipient = readPublicKey(bytes, 136);
  const mandateNonce = isMandateNonce(legacyAllowedRecipient) ? legacyAllowedRecipient : undefined;

  return {
    address: address(mandateAddress),
    owner: readPublicKey(bytes, 8),
    approvedAgent: readPublicKey(bytes, 40),
    sourceTokenAccount: readPublicKey(bytes, 72),
    allowedMint: readPublicKey(bytes, 104),
    legacyAllowedRecipient: mandateNonce || legacyAllowedRecipient === DEFAULT_ADDRESS ? undefined : legacyAllowedRecipient,
    maxPerPayment: readU64(bytes, 168),
    totalLimit: readU64(bytes, 176),
    amountSpent: readU64(bytes, 184),
    paymentCount: readU64(bytes, 192),
    expiresAtSlot,
    maxPaymentCount,
    cooldownSlots,
    lastPaymentSlot,
    paused,
    revoked,
    status: mandateStatus(paused, revoked, expiresAtSlot, currentSlot),
    tokenProgram,
    mandateNonce,
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
