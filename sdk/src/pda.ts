import { PublicKey } from "@solana/web3.js";
import type { Address } from "./types.js";
import {
  CONFIG_SEED,
  ASSET_SEED,
  DEFAULT_PROGRAM_ID,
  MANDATE_SEED,
  RECEIPT_SEED,
} from "./constants.js";
import { bytes32, publicKey } from "./encoding.js";

export function deriveConfigAddress(programId: Address = DEFAULT_PROGRAM_ID): Address {
  return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], publicKey(programId))[0].toBase58();
}

export function deriveMandateAddress(
  owner: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
): Address {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(MANDATE_SEED), publicKey(owner).toBytes()],
    publicKey(programId),
  )[0].toBase58();
}

export function deriveReceiptAddress(
  mandate: Address,
  invoiceHash: Uint8Array,
  programId: Address = DEFAULT_PROGRAM_ID,
): Address {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RECEIPT_SEED), publicKey(mandate).toBytes(), bytes32(invoiceHash, "invoiceHash")],
    publicKey(programId),
  )[0].toBase58();
}

export function deriveAssetAddress(
  mint: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
): Address {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ASSET_SEED), publicKey(mint).toBytes()],
    publicKey(programId),
  )[0].toBase58();
}
