import type { Address } from "../types.js";

/**
 * card_policy program ID on Devnet (contracts.md Changelog, Lane 1 / 1A;
 * `address` in programs/card_policy/idl/card_policy.json). Every builder and
 * PDA helper takes an explicit `programId` and falls back to this value.
 */
export const CARD_POLICY_PROGRAM_ID: Address = "Cz9vYKFZFwx8Bqag95xZtw8dqUjS4k9AoyMh1pFo82F";

export function resolveCardPolicyProgramId(programId?: Address): Address {
  const value = (programId ?? CARD_POLICY_PROGRAM_ID).trim();
  if (!value) {
    throw new Error("card_policy program ID is not configured yet. Pass programId explicitly until the program is deployed.");
  }
  return value;
}

/** MagicBlock Devnet TEE (Private Ephemeral Rollup). Tokens go in the query string; never log the full URL. */
export const DEVNET_TEE_URL = "https://devnet-tee.magicblock.app";
export const DEVNET_TEE_WS_URL = "wss://devnet-tee.magicblock.app";
/** The only validator `delegate_card` accepts on Devnet (contracts.md §1). */
export const DEVNET_TEE_VALIDATOR: Address = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
export const TEE_VALIDATOR_ALLOWLIST: readonly Address[] = [DEVNET_TEE_VALIDATOR];

export const DELEGATION_PROGRAM_ID: Address = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
export const MAGIC_PROGRAM_ID: Address = "Magic11111111111111111111111111111111111111";
export const MAGIC_CONTEXT_ID: Address = "MagicContext1111111111111111111111111111111";
export const PERMISSION_PROGRAM_ID: Address = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";
export const EPHEMERAL_VAULT_ID: Address = "MagicVau1t999999999999999999999999999999999";

export const CARD_SEEDS = {
  binding: "card_binding",
  policy: "card_policy",
  period: "card_period",
  reservation: "res",
  intent: "intent",
  commitment: "card_commit",
} as const;

export const MAX_MERCHANTS = 8;
export const MAX_MCCS = 16;
/** owner + authorizer + 4 finance readers. */
export const MAX_MEMBERS = 6;
/** $10,000 sandbox cap on any budget (contracts.md §1.3 #6). */
export const MAX_BUDGET_CENTS = 1_000_000n;
export const MIN_PERIOD_SECONDS = 86_400;
export const MAX_FEE_BPS = 1_000;
/** A checkout intent may live at most 10 minutes. */
export const MAX_INTENT_TTL_SECONDS = 600;

export const CARD_ISSUER = { lithic_sandbox: 1, card_sim: 2 } as const;

/** EphemeralPermission member flags used by card_policy (MagicBlock permission program). */
export const PERMISSION_FLAGS = {
  AUTHORITY: 1,
  TX_LOGS: 2,
  TX_BALANCES: 4,
  TX_MESSAGE: 8,
} as const;

/** Anchor instruction discriminators: sha256("global:<name>")[0..8]. */
export const CARD_POLICY_DISCRIMINATORS = {
  initCard: Uint8Array.from([163, 228, 150, 17, 250, 36, 156, 20]),
  delegateCard: Uint8Array.from([143, 76, 125, 25, 4, 123, 254, 155]),
  initPermission: Uint8Array.from([66, 14, 153, 250, 187, 36, 179, 236]),
  updatePermission: Uint8Array.from([1, 120, 111, 126, 237, 61, 41, 61]),
  syncPermission: Uint8Array.from([164, 186, 105, 85, 229, 147, 214, 246]),
  setPolicy: Uint8Array.from([40, 133, 12, 157, 235, 202, 2, 132]),
  openCheckoutIntent: Uint8Array.from([139, 180, 113, 38, 119, 108, 36, 224]),
  cancelCheckoutIntent: Uint8Array.from([175, 152, 6, 182, 211, 206, 160, 167]),
  closeCheckoutIntent: Uint8Array.from([36, 161, 214, 238, 244, 192, 71, 234]),
  authorize: Uint8Array.from([173, 193, 102, 210, 219, 137, 113, 120]),
  adjustReservation: Uint8Array.from([137, 209, 64, 94, 107, 194, 101, 43]),
  capture: Uint8Array.from([110, 65, 245, 241, 195, 248, 233, 142]),
  reverse: Uint8Array.from([137, 149, 242, 82, 88, 95, 221, 145]),
  refund: Uint8Array.from([2, 96, 183, 251, 63, 208, 46, 46]),
  recordDispute: Uint8Array.from([190, 94, 198, 130, 215, 36, 43, 143]),
  recordException: Uint8Array.from([221, 204, 254, 53, 116, 13, 197, 105]),
  resolveException: Uint8Array.from([131, 144, 179, 147, 199, 157, 77, 127]),
  rollPeriod: Uint8Array.from([30, 184, 166, 42, 251, 204, 47, 107]),
  freeze: Uint8Array.from([255, 91, 207, 84, 251, 194, 254, 63]),
  unfreeze: Uint8Array.from([133, 160, 68, 253, 80, 232, 218, 247]),
  recoveryFreeze: Uint8Array.from([113, 1, 136, 29, 212, 19, 213, 56]),
  restore: Uint8Array.from([77, 37, 122, 128, 139, 35, 6, 58]),
  confirmReconciled: Uint8Array.from([116, 7, 34, 18, 87, 241, 4, 233]),
  checkpoint: Uint8Array.from([213, 200, 19, 204, 240, 143, 184, 252]),
  writeCommitment: Uint8Array.from([159, 54, 242, 213, 46, 162, 174, 75]),
  wipeCard: Uint8Array.from([210, 120, 235, 58, 105, 132, 206, 76]),
  closeCard: Uint8Array.from([142, 206, 170, 182, 227, 204, 185, 115]),
  recordRepayment: Uint8Array.from([193, 155, 76, 246, 27, 189, 147, 102]),
} as const;

export type CardPolicyInstructionName = keyof typeof CARD_POLICY_DISCRIMINATORS;

/** Anchor account discriminators: sha256("account:<Name>")[0..8]. */
export const CARD_ACCOUNT_DISCRIMINATORS = {
  cardBinding: Uint8Array.from([86, 71, 81, 106, 155, 166, 1, 72]),
  cardPolicy: Uint8Array.from([196, 159, 33, 83, 231, 156, 65, 71]),
  cardPeriod: Uint8Array.from([112, 201, 91, 227, 87, 121, 62, 2]),
  reservation: Uint8Array.from([188, 235, 0, 111, 208, 253, 247, 212]),
  checkoutIntent: Uint8Array.from([39, 73, 4, 146, 212, 151, 108, 241]),
  cardCommitment: Uint8Array.from([43, 146, 163, 253, 221, 147, 4, 9]),
} as const;

/** `CardPolicyError` codes (contracts.md §1.4). Append only. */
export const CARD_POLICY_ERRORS = {
  6000: "Unauthorized",
  6001: "ValidatorNotAllowed",
  6002: "PolicyNotSet",
  6003: "InvalidPolicy",
  6004: "CardFrozen",
  6005: "RecoveryFrozen",
  6006: "PolicyExpired",
  6007: "IntentInvalid",
  6008: "IntentExpired",
  6009: "IntentStale",
  6010: "MerchantMismatch",
  6011: "MerchantNotAllowed",
  6012: "MccNotAllowed",
  6013: "CurrencyMismatch",
  6014: "AmountExceedsIntent",
  6015: "AmountExceedsMax",
  6016: "BudgetExceeded",
  6017: "VelocityExceeded",
  6018: "RecurringNotAllowed",
  6019: "DuplicateAuthorization",
  6020: "DuplicateCapture",
  6021: "ReservationClosed",
  6022: "PeriodNotEnded",
  6023: "DisclosureBlocked",
  6024: "MemberLimit",
  6025: "ExceptionsOpen",
  6026: "NotInRecovery",
  6027: "StaleCommitment",
  6028: "OpenReservations",
  6029: "OutstandingBalance",
  6030: "MathOverflow",
  6031: "AuthorizerChangeRequiresFreeze",
  6032: "DuplicateRepayment",
  // Appended by card_policy (contracts.md Changelog, Lane 1 / 1A).
  6033: "MemberNotFound",
  6034: "PermissionNotInitialized",
  6035: "InvalidAmount",
  6036: "NoOpenExceptions",
  6037: "ReconDigestMismatch",
  6038: "RepaymentExceedsOutstanding",
  6039: "InvalidAccount",
  6040: "PrefundTooLow",
  6041: "NotWiped",
  6042: "InvalidEventId",
  6043: "DuplicateEvent",
  6044: "EphemeralAccountsOpen",
} as const;

export type CardPolicyErrorCode = keyof typeof CARD_POLICY_ERRORS;
export type CardPolicyErrorName = (typeof CARD_POLICY_ERRORS)[CardPolicyErrorCode];

export function cardPolicyErrorName(code: number): CardPolicyErrorName | undefined {
  return (CARD_POLICY_ERRORS as Record<number, CardPolicyErrorName>)[code];
}
