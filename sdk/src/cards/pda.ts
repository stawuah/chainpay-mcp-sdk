import { PublicKey } from "@solana/web3.js";
import type { Address } from "../types.js";
import { bytes32, publicKey } from "../encoding.js";
import {
  CARD_SEEDS,
  DELEGATION_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  resolveCardPolicyProgramId,
} from "./constants.js";

function pda(seeds: Uint8Array[], programId: Address): Address {
  return PublicKey.findProgramAddressSync(seeds, publicKey(programId))[0].toBase58();
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** `["card_binding", owner, card_id]` (base, public). */
export function deriveCardBindingAddress(owner: Address, cardId: Uint8Array, programId?: Address): Address {
  return pda([utf8(CARD_SEEDS.binding), publicKey(owner).toBytes(), bytes32(cardId, "cardId")], resolveCardPolicyProgramId(programId));
}

/** `["card_policy", binding]` (delegated to the TEE, private). */
export function deriveCardPolicyAddress(binding: Address, programId?: Address): Address {
  return pda([utf8(CARD_SEEDS.policy), publicKey(binding).toBytes()], resolveCardPolicyProgramId(programId));
}

/** `["card_period", binding]` (delegated to the TEE, private). */
export function deriveCardPeriodAddress(binding: Address, programId?: Address): Address {
  return pda([utf8(CARD_SEEDS.period), publicKey(binding).toBytes()], resolveCardPolicyProgramId(programId));
}

/** `["res", policy, auth_id_hash]` (PER-only). Its existence is the replay guard. */
export function deriveReservationAddress(policy: Address, authIdHash: Uint8Array, programId?: Address): Address {
  return pda([utf8(CARD_SEEDS.reservation), publicKey(policy).toBytes(), bytes32(authIdHash, "authIdHash")], resolveCardPolicyProgramId(programId));
}

/** `["auth_guard", policy]` (PER-only): replay guard for closed reservations. */
export function deriveAuthGuardAddress(policy: Address, programId?: Address): Address {
  return pda([utf8(CARD_SEEDS.authGuard), publicKey(policy).toBytes()], resolveCardPolicyProgramId(programId));
}

/** `["intent", policy, intent_id]` (PER-only); intent_id is 16 bytes. */
export function deriveCheckoutIntentAddress(policy: Address, intentId: Uint8Array, programId?: Address): Address {
  if (intentId.length !== 16) throw new Error("intentId must be exactly 16 bytes");
  return pda([utf8(CARD_SEEDS.intent), publicKey(policy).toBytes(), new Uint8Array(intentId)], resolveCardPolicyProgramId(programId));
}

/** `["card_commit", binding]` (base, public, never delegated). */
export function deriveCardCommitmentAddress(binding: Address, programId?: Address): Address {
  return pda([utf8(CARD_SEEDS.commitment), publicKey(binding).toBytes()], resolveCardPolicyProgramId(programId));
}

/** MagicBlock permission PDA for a private account: `["permission:", account]` under the permission program. */
export function derivePermissionAddress(account: Address): Address {
  return pda([utf8("permission:"), publicKey(account).toBytes()], PERMISSION_PROGRAM_ID);
}

/** Delegation-program escrow that pays for the card's Magic Actions: `["balance", policy, 255]`. */
export function deriveCardEscrowAddress(escrowAuthority: Address, index = 255): Address {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("escrow index must be 0..255");
  return pda([utf8("balance"), publicKey(escrowAuthority).toBytes(), Uint8Array.of(index)], DELEGATION_PROGRAM_ID);
}

export function deriveDelegationBufferAddress(account: Address, programId?: Address): Address {
  return pda([utf8("buffer"), publicKey(account).toBytes()], resolveCardPolicyProgramId(programId));
}

export function deriveDelegationRecordAddress(account: Address): Address {
  return pda([utf8("delegation"), publicKey(account).toBytes()], DELEGATION_PROGRAM_ID);
}

export function deriveDelegationMetadataAddress(account: Address): Address {
  return pda([utf8("delegation-metadata"), publicKey(account).toBytes()], DELEGATION_PROGRAM_ID);
}

export function deriveMagicFeeVaultAddress(validator: Address): Address {
  return pda([utf8("magic-fee-vault"), publicKey(validator).toBytes()], DELEGATION_PROGRAM_ID);
}

export type CardAccounts = {
  binding: Address;
  policy: Address;
  period: Address;
  commitment: Address;
  escrow: Address;
  policyPermission: Address;
  periodPermission: Address;
};

/** Every address one card owns, from the owner wallet and the 32-byte card id. */
export function deriveCardAccounts(owner: Address, cardId: Uint8Array, programId?: Address): CardAccounts {
  const binding = deriveCardBindingAddress(owner, cardId, programId);
  const policy = deriveCardPolicyAddress(binding, programId);
  const period = deriveCardPeriodAddress(binding, programId);
  return {
    binding,
    policy,
    period,
    commitment: deriveCardCommitmentAddress(binding, programId),
    escrow: deriveCardEscrowAddress(policy),
    policyPermission: derivePermissionAddress(policy),
    periodPermission: derivePermissionAddress(period),
  };
}

/** Card ids travel as 64-char lowercase hex (Convex key `card:<cardId hex>`). */
export function cardIdFromHex(value: string): Uint8Array {
  const hex = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("cardId must be 32 bytes of hex");
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export function cardIdToHex(cardId: Uint8Array): string {
  return Array.from(bytes32(cardId, "cardId"), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
