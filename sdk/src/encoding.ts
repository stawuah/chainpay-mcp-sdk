import { PublicKey } from "@solana/web3.js";
import type {
  AccountMeta,
  Address,
  ChainPayInstruction,
  TokenProgram,
} from "./types.js";
import { DISCRIMINATORS, MANDATE_NONCE_PREFIX, SYSTEM_PROGRAM_ID } from "./constants.js";

export function publicKey(value: Address): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid Solana address: ${value}`);
  }
}

export function address(value: Address): Address {
  return publicKey(value).toBase58();
}

export function bytes32(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== 32) throw new Error(`${name} must be exactly 32 bytes`);
  return new Uint8Array(value);
}

export function writeU64(value: bigint, name: string): Uint8Array {
  if (value < 0n || value > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} must fit in an unsigned 64-bit integer`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function readU64(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) throw new Error("Account data ended while reading u64");
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

export function readU8(data: Uint8Array, offset: number): number {
  if (offset >= data.length) throw new Error("Account data ended while reading u8");
  return data[offset];
}

export function readBytes32(data: Uint8Array, offset: number, name: string): Uint8Array {
  if (offset + 32 > data.length) {
    throw new Error(`Account data ended while reading ${name}`);
  }
  return new Uint8Array(data.slice(offset, offset + 32));
}

export function assertDiscriminator(
  data: Uint8Array,
  discriminator: Uint8Array,
  accountName: string,
): void {
  if (data.length < discriminator.length) {
    throw new Error(`${accountName} account data is truncated`);
  }
  for (let index = 0; index < discriminator.length; index += 1) {
    if (data[index] !== discriminator[index]) {
      throw new Error(`Invalid ${accountName} account discriminator`);
    }
  }
}

export function readPublicKey(data: Uint8Array, offset: number): Address {
  if (offset + 32 > data.length) throw new Error("Account data ended while reading public key");
  return new PublicKey(data.slice(offset, offset + 32)).toBase58();
}

export function isMandateNonce(value: Address): boolean {
  const bytes = publicKey(value).toBytes();
  return MANDATE_NONCE_PREFIX.every((byte, index) => bytes[index] === byte);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function meta(value: Address, isWritable = false, isSigner = false): AccountMeta {
  return { address: address(value), isWritable, isSigner };
}

export function tokenProgramAddress(tokenProgram: TokenProgram): Address {
  return tokenProgram === "token-2022"
    ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
}

export function tokenProgramFromAddress(value: Address): TokenProgram | undefined {
  const normalized = address(value);
  if (normalized === tokenProgramAddress("spl-token")) return "spl-token";
  if (normalized === tokenProgramAddress("token-2022")) return "token-2022";
  return undefined;
}

export function instruction(
  name: string,
  programId: Address,
  keys: AccountMeta[],
  data: Uint8Array,
): ChainPayInstruction {
  return { name, programId: address(programId), keys, data: new Uint8Array(data) };
}

export function encodeCreateMandate(params: {
  approvedAgent: Address;
  sourceTokenAccount: Address;
  allowedMint: Address;
  maxPerPayment: bigint;
  totalLimit: bigint;
  expiresAtSlot: bigint;
  maxPaymentCount: bigint;
  cooldownSlots: bigint;
  mandateNonce: Address;
}): Uint8Array {
  return concat(
    DISCRIMINATORS.createMandate,
    publicKey(params.approvedAgent).toBytes(),
    publicKey(params.sourceTokenAccount).toBytes(),
    publicKey(params.allowedMint).toBytes(),
    writeU64(params.maxPerPayment, "maxPerPayment"),
    writeU64(params.totalLimit, "totalLimit"),
    writeU64(params.expiresAtSlot, "expiresAtSlot"),
    writeU64(params.maxPaymentCount, "maxPaymentCount"),
    writeU64(params.cooldownSlots, "cooldownSlots"),
    publicKey(params.mandateNonce).toBytes(),
  );
}

export function encodeInitializeConfig(supportedMints: readonly Address[]): Uint8Array {
  if (supportedMints.length !== 3) {
    throw new Error("initialize_config requires exactly three mint slots");
  }
  return concat(
    DISCRIMINATORS.initializeConfig,
    ...supportedMints.map((mint) => publicKey(mint).toBytes()),
  );
}

export function encodeRegisterAsset(mint: Address): Uint8Array {
  return concat(DISCRIMINATORS.registerAsset, publicKey(mint).toBytes());
}

export function encodeSetAssetStatus(enabled: boolean): Uint8Array {
  return concat(DISCRIMINATORS.setAssetStatus, Uint8Array.of(enabled ? 1 : 0));
}

export function encodeUpdateMandate(params: {
  approvedAgent: Address;
  maxPerPayment: bigint;
  totalLimit: bigint;
  expiresAtSlot: bigint;
  maxPaymentCount: bigint;
  cooldownSlots: bigint;
  paused: boolean;
}): Uint8Array {
  return concat(
    DISCRIMINATORS.updateMandate,
    publicKey(params.approvedAgent).toBytes(),
    writeU64(params.maxPerPayment, "maxPerPayment"),
    writeU64(params.totalLimit, "totalLimit"),
    writeU64(params.expiresAtSlot, "expiresAtSlot"),
    writeU64(params.maxPaymentCount, "maxPaymentCount"),
    writeU64(params.cooldownSlots, "cooldownSlots"),
    Uint8Array.of(params.paused ? 1 : 0),
  );
}

export function encodePayment(params: {
  invoiceHash: Uint8Array;
  paymentId: Uint8Array;
  signatureReference: Uint8Array;
  amount: bigint;
}): Uint8Array {
  return concat(
    DISCRIMINATORS.executePayment,
    bytes32(params.invoiceHash, "invoiceHash"),
    bytes32(params.paymentId, "paymentId"),
    bytes32(params.signatureReference, "signatureReference"),
    writeU64(params.amount, "amount"),
  );
}

export function encodePauseMandate(): Uint8Array {
  return new Uint8Array(DISCRIMINATORS.pauseMandate);
}

export function encodeRevokeMandate(): Uint8Array {
  return new Uint8Array(DISCRIMINATORS.revokeMandate);
}

export function encodeApproveChecked(amount: bigint, decimals: number): Uint8Array {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals must be between 0 and 255");
  }
  return concat(DISCRIMINATORS.approveChecked, writeU64(amount, "delegateAmount"), Uint8Array.of(decimals));
}

export function encodeRevokeDelegate(): Uint8Array {
  return new Uint8Array(DISCRIMINATORS.revokeDelegate);
}

export function systemProgramMeta(): AccountMeta {
  return meta(SYSTEM_PROGRAM_ID);
}
