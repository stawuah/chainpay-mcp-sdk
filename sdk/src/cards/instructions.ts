import type { Address, ChainPayInstruction } from "../types.js";
import { instruction, meta } from "../encoding.js";
import { DEFAULT_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../constants.js";
import { deriveAssetAddress, deriveConfigAddress, deriveReceiptAddress } from "../pda.js";
import {
  CARD_POLICY_DISCRIMINATORS,
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  MAX_BUDGET_CENTS,
  MAX_FEE_BPS,
  MAX_MCCS,
  MAX_MERCHANTS,
  MIN_PERIOD_SECONDS,
  PERMISSION_PROGRAM_ID,
  TEE_VALIDATOR_ALLOWLIST,
  resolveCardPolicyProgramId,
  type CardPolicyInstructionName,
} from "./constants.js";
import { currencyBytes } from "./accounts.js";
import { BorshReader, BorshWriter } from "./layout.js";
import {
  deriveAuthGuardAddress,
  deriveCardAccounts,
  deriveCheckoutIntentAddress,
  deriveDelegationBufferAddress,
  deriveDelegationMetadataAddress,
  deriveDelegationRecordAddress,
  derivePermissionAddress,
  deriveRepayAgentAddress,
  deriveReservationAddress,
} from "./pda.js";

/**
 * Instruction data follows contracts.md §1.3 (Anchor discriminator + Borsh
 * args in the listed order). Account lists, discriminators and arg layouts
 * are checked against the deployed program's IDL
 * (programs/card_policy/idl/card_policy.json, Devnet
 * Cz9vYKFZFwx8Bqag95xZtw8dqUjS4k9AoyMh1pFo82F) by test/cards-idl.test.mjs,
 * including the `#[delegate]` macro accounts of `delegate_card`.
 */
export const CARD_POLICY_ACCOUNT_ORDER_PROVISIONAL = false;

export type PolicyArgs = {
  budgetCents: bigint;
  maxPurchaseCents: bigint;
  /** 0 = no count limit. */
  maxPurchasesPerPeriod: number;
  periodSeconds: number;
  currency: string;
  merchantIdHashes: Uint8Array[];
  mccs: number[];
  /** 0 = no expiry. Unix seconds. */
  expiresAt: bigint;
  recurringAllowed: boolean;
  feeBps: number;
  authorizer: Address;
};

export type RestoreArgs = {
  policy: PolicyArgs;
  periodIndex: number;
  capturedCents: bigint;
  reservedCents: bigint;
  refundedCents: bigint;
  purchasesCount: number;
  /** Exception debits booked this period (program 1A review: after `purchases_count`). */
  exceptionCents: bigint;
  statementOutstandingCents: bigint;
  ledgerHead: Uint8Array;
  ledgerSeq: bigint;
  reconDigest: Uint8Array;
};

export type PermissionOp = { kind: "add_reader"; pubkey: Address } | { kind: "remove_reader"; pubkey: Address };

export type CardInstructionArgs = {
  initCard: { cardId: Uint8Array; issuer: number; issuerCardRefHash: Uint8Array; prefundLamports: bigint };
  delegateCard: { validator: Address };
  initPermission: { authorizer: Address };
  updatePermission: { op: PermissionOp };
  syncPermission: Record<string, never>;
  setPolicy: { policy: PolicyArgs };
  openCheckoutIntent: { intentId: Uint8Array; agent: Address; merchantIdHash: Uint8Array; mcc: number; maxAmountCents: bigint; currency: string; expiresAt: bigint };
  cancelCheckoutIntent: Record<string, never>;
  closeCheckoutIntent: Record<string, never>;
  authorize: { authIdHash: Uint8Array; intentId: Uint8Array; amountCents: bigint; currency: string; merchantIdHash: Uint8Array; mcc: number; merchantInitiated: boolean; singleMessage: boolean };
  adjustReservation: { newAmountCents: bigint };
  capture: { amountCents: bigint; captureIdHash: Uint8Array };
  reverse: { amountCents: bigint; reason: number; eventIdHash: Uint8Array };
  refund: { amountCents: bigint; eventIdHash: Uint8Array };
  recordDispute: { state: number; eventIdHash: Uint8Array };
  recordException: { kind: number; amountCents: bigint; eventIdHash: Uint8Array };
  resolveException: { eventIdHash: Uint8Array; resolution: number };
  rollPeriod: Record<string, never>;
  freeze: { reason: number };
  unfreeze: Record<string, never>;
  recoveryFreeze: { reason: number };
  restore: { restore: RestoreArgs };
  confirmReconciled: { reconDigest: Uint8Array };
  checkpoint: { masterSalt: Uint8Array; seq: bigint };
  writeCommitment: { root: Uint8Array; seq: bigint; policyVersion: number; periodIndex: number };
  wipeCard: Record<string, never>;
  closeReservation: Record<string, never>;
  closeCard: Record<string, never>;
  recordRepayment: { statementDigest: Uint8Array; amountCents: bigint };
  repayStatement: { statementDigest: Uint8Array; amount: bigint };
  recordPrivateRepayment: { statementDigest: Uint8Array; amountCents: bigint };
};

type Codec<T> = { encode(w: BorshWriter, args: T): void; decode(r: BorshReader): T };

const empty: Codec<Record<string, never>> = { encode() {}, decode: () => ({}) };

function writePolicy(w: BorshWriter, p: PolicyArgs): void {
  if (p.merchantIdHashes.length > MAX_MERCHANTS) throw new Error(`At most ${MAX_MERCHANTS} merchants`);
  if (p.mccs.length > MAX_MCCS) throw new Error(`At most ${MAX_MCCS} MCCs`);
  w.u64(p.budgetCents, "budgetCents")
    .u64(p.maxPurchaseCents, "maxPurchaseCents")
    .u16(p.maxPurchasesPerPeriod, "maxPurchasesPerPeriod")
    .u32(p.periodSeconds, "periodSeconds")
    .fixed(currencyBytes(p.currency), 3, "currency")
    .u32(p.merchantIdHashes.length);
  p.merchantIdHashes.forEach((hash, i) => w.fixed(hash, 32, `merchantIdHashes[${i}]`));
  w.u32(p.mccs.length);
  p.mccs.forEach((mcc, i) => w.u16(mcc, `mccs[${i}]`));
  w.i64(p.expiresAt, "expiresAt").bool(p.recurringAllowed).u16(p.feeBps, "feeBps").pubkey(p.authorizer);
}

function readVecLength(r: BorshReader, max: number, name: string): number {
  const length = r.u32(`${name}.length`);
  if (length > max) throw new Error(`${name} exceeds ${max} entries`);
  return length;
}

function readPolicy(r: BorshReader): PolicyArgs {
  const budgetCents = r.u64("budgetCents");
  const maxPurchaseCents = r.u64("maxPurchaseCents");
  const maxPurchasesPerPeriod = r.u16("maxPurchasesPerPeriod");
  const periodSeconds = r.u32("periodSeconds");
  const currency = String.fromCharCode(...r.fixed(3, "currency"));
  const merchantIdHashes = Array.from({ length: readVecLength(r, MAX_MERCHANTS, "merchantIdHashes") }, (_, i) => r.fixed(32, `merchantIdHashes[${i}]`));
  const mccs = Array.from({ length: readVecLength(r, MAX_MCCS, "mccs") }, (_, i) => r.u16(`mccs[${i}]`));
  return {
    budgetCents,
    maxPurchaseCents,
    maxPurchasesPerPeriod,
    periodSeconds,
    currency,
    merchantIdHashes,
    mccs,
    expiresAt: r.i64("expiresAt"),
    recurringAllowed: r.bool("recurringAllowed"),
    feeBps: r.u16("feeBps"),
    authorizer: r.pubkey("authorizer"),
  };
}

const CODECS: { [K in CardPolicyInstructionName]: Codec<CardInstructionArgs[K]> } = {
  initCard: {
    encode: (w, a) => { w.fixed(a.cardId, 32, "cardId").u8(a.issuer, "issuer").fixed(a.issuerCardRefHash, 32, "issuerCardRefHash").u64(a.prefundLamports, "prefundLamports"); },
    decode: (r) => ({ cardId: r.fixed(32, "cardId"), issuer: r.u8("issuer"), issuerCardRefHash: r.fixed(32, "issuerCardRefHash"), prefundLamports: r.u64("prefundLamports") }),
  },
  delegateCard: { encode: (w, a) => { w.pubkey(a.validator); }, decode: (r) => ({ validator: r.pubkey("validator") }) },
  initPermission: { encode: (w, a) => { w.pubkey(a.authorizer); }, decode: (r) => ({ authorizer: r.pubkey("authorizer") }) },
  updatePermission: {
    encode: (w, a) => { w.u8(a.op.kind === "add_reader" ? 0 : a.op.kind === "remove_reader" ? 1 : 255).pubkey(a.op.pubkey); },
    decode: (r) => {
      const tag = r.u8("op");
      if (tag > 1) throw new Error(`Unknown permission op ${tag}`);
      return { op: { kind: tag === 0 ? "add_reader" : "remove_reader", pubkey: r.pubkey("op.pubkey") } };
    },
  },
  syncPermission: empty,
  setPolicy: { encode: (w, a) => writePolicy(w, a.policy), decode: (r) => ({ policy: readPolicy(r) }) },
  openCheckoutIntent: {
    encode: (w, a) => { w.fixed(a.intentId, 16, "intentId").pubkey(a.agent).fixed(a.merchantIdHash, 32, "merchantIdHash").u16(a.mcc, "mcc").u64(a.maxAmountCents, "maxAmountCents").fixed(currencyBytes(a.currency), 3, "currency").i64(a.expiresAt, "expiresAt"); },
    decode: (r) => ({ intentId: r.fixed(16, "intentId"), agent: r.pubkey("agent"), merchantIdHash: r.fixed(32, "merchantIdHash"), mcc: r.u16("mcc"), maxAmountCents: r.u64("maxAmountCents"), currency: String.fromCharCode(...r.fixed(3, "currency")), expiresAt: r.i64("expiresAt") }),
  },
  cancelCheckoutIntent: empty,
  closeCheckoutIntent: empty,
  authorize: {
    encode: (w, a) => { w.fixed(a.authIdHash, 32, "authIdHash").fixed(a.intentId, 16, "intentId").u64(a.amountCents, "amountCents").fixed(currencyBytes(a.currency), 3, "currency").fixed(a.merchantIdHash, 32, "merchantIdHash").u16(a.mcc, "mcc").bool(a.merchantInitiated).bool(a.singleMessage); },
    decode: (r) => ({ authIdHash: r.fixed(32, "authIdHash"), intentId: r.fixed(16, "intentId"), amountCents: r.u64("amountCents"), currency: String.fromCharCode(...r.fixed(3, "currency")), merchantIdHash: r.fixed(32, "merchantIdHash"), mcc: r.u16("mcc"), merchantInitiated: r.bool("merchantInitiated"), singleMessage: r.bool("singleMessage") }),
  },
  adjustReservation: { encode: (w, a) => { w.u64(a.newAmountCents, "newAmountCents"); }, decode: (r) => ({ newAmountCents: r.u64("newAmountCents") }) },
  capture: {
    encode: (w, a) => { w.u64(a.amountCents, "amountCents").fixed(a.captureIdHash, 32, "captureIdHash"); },
    decode: (r) => ({ amountCents: r.u64("amountCents"), captureIdHash: r.fixed(32, "captureIdHash") }),
  },
  reverse: {
    encode: (w, a) => { w.u64(a.amountCents, "amountCents").u8(a.reason, "reason").fixed(a.eventIdHash, 32, "eventIdHash"); },
    decode: (r) => ({ amountCents: r.u64("amountCents"), reason: r.u8("reason"), eventIdHash: r.fixed(32, "eventIdHash") }),
  },
  refund: {
    encode: (w, a) => { w.u64(a.amountCents, "amountCents").fixed(a.eventIdHash, 32, "eventIdHash"); },
    decode: (r) => ({ amountCents: r.u64("amountCents"), eventIdHash: r.fixed(32, "eventIdHash") }),
  },
  recordDispute: {
    encode: (w, a) => { w.u8(a.state, "state").fixed(a.eventIdHash, 32, "eventIdHash"); },
    decode: (r) => ({ state: r.u8("state"), eventIdHash: r.fixed(32, "eventIdHash") }),
  },
  recordException: {
    encode: (w, a) => { w.u8(a.kind, "kind").u64(a.amountCents, "amountCents").fixed(a.eventIdHash, 32, "eventIdHash"); },
    decode: (r) => ({ kind: r.u8("kind"), amountCents: r.u64("amountCents"), eventIdHash: r.fixed(32, "eventIdHash") }),
  },
  resolveException: {
    encode: (w, a) => { w.fixed(a.eventIdHash, 32, "eventIdHash").u8(a.resolution, "resolution"); },
    decode: (r) => ({ eventIdHash: r.fixed(32, "eventIdHash"), resolution: r.u8("resolution") }),
  },
  rollPeriod: empty,
  freeze: { encode: (w, a) => { w.u8(a.reason, "reason"); }, decode: (r) => ({ reason: r.u8("reason") }) },
  unfreeze: empty,
  recoveryFreeze: { encode: (w, a) => { w.u8(a.reason, "reason"); }, decode: (r) => ({ reason: r.u8("reason") }) },
  restore: {
    encode: (w, a) => {
      const s = a.restore;
      writePolicy(w, s.policy);
      w.u32(s.periodIndex, "periodIndex").u64(s.capturedCents, "capturedCents").u64(s.reservedCents, "reservedCents").u64(s.refundedCents, "refundedCents")
        .u16(s.purchasesCount, "purchasesCount").u64(s.exceptionCents, "exceptionCents").u64(s.statementOutstandingCents, "statementOutstandingCents")
        .fixed(s.ledgerHead, 32, "ledgerHead").u64(s.ledgerSeq, "ledgerSeq").fixed(s.reconDigest, 32, "reconDigest");
    },
    decode: (r) => ({
      restore: {
        policy: readPolicy(r),
        periodIndex: r.u32("periodIndex"),
        capturedCents: r.u64("capturedCents"),
        reservedCents: r.u64("reservedCents"),
        refundedCents: r.u64("refundedCents"),
        purchasesCount: r.u16("purchasesCount"),
        exceptionCents: r.u64("exceptionCents"),
        statementOutstandingCents: r.u64("statementOutstandingCents"),
        ledgerHead: r.fixed(32, "ledgerHead"),
        ledgerSeq: r.u64("ledgerSeq"),
        reconDigest: r.fixed(32, "reconDigest"),
      },
    }),
  },
  confirmReconciled: { encode: (w, a) => { w.fixed(a.reconDigest, 32, "reconDigest"); }, decode: (r) => ({ reconDigest: r.fixed(32, "reconDigest") }) },
  checkpoint: {
    encode: (w, a) => { w.fixed(a.masterSalt, 32, "masterSalt").u64(a.seq, "seq"); },
    decode: (r) => ({ masterSalt: r.fixed(32, "masterSalt"), seq: r.u64("seq") }),
  },
  writeCommitment: {
    encode: (w, a) => { w.fixed(a.root, 32, "root").u64(a.seq, "seq").u32(a.policyVersion, "policyVersion").u32(a.periodIndex, "periodIndex"); },
    decode: (r) => ({ root: r.fixed(32, "root"), seq: r.u64("seq"), policyVersion: r.u32("policyVersion"), periodIndex: r.u32("periodIndex") }),
  },
  wipeCard: empty,
  closeCard: empty,
  closeReservation: empty,
  recordRepayment: {
    encode: (w, a) => { w.fixed(a.statementDigest, 32, "statementDigest").u64(a.amountCents, "amountCents"); },
    decode: (r) => ({ statementDigest: r.fixed(32, "statementDigest"), amountCents: r.u64("amountCents") }),
  },
  repayStatement: {
    encode: (w, a) => { w.fixed(a.statementDigest, 32, "statementDigest").u64(a.amount, "amount"); },
    decode: (r) => ({ statementDigest: r.fixed(32, "statementDigest"), amount: r.u64("amount") }),
  },
  recordPrivateRepayment: {
    encode: (w, a) => { w.fixed(a.statementDigest, 32, "statementDigest").u64(a.amountCents, "amountCents"); },
    decode: (r) => ({ statementDigest: r.fixed(32, "statementDigest"), amountCents: r.u64("amountCents") }),
  },
};

export function encodeCardInstructionData<K extends CardPolicyInstructionName>(name: K, args: CardInstructionArgs[K]): Uint8Array {
  const w = new BorshWriter().bytes(CARD_POLICY_DISCRIMINATORS[name]);
  CODECS[name].encode(w, args);
  return w.toBytes();
}

export type DecodedCardInstruction = { [K in CardPolicyInstructionName]: { name: K; args: CardInstructionArgs[K] } }[CardPolicyInstructionName];

export function decodeCardInstructionData(data: Uint8Array): DecodedCardInstruction {
  if (data.length < 8) throw new Error("Instruction data is truncated");
  for (const name of Object.keys(CARD_POLICY_DISCRIMINATORS) as CardPolicyInstructionName[]) {
    const disc = CARD_POLICY_DISCRIMINATORS[name];
    if (disc.every((byte, i) => data[i] === byte)) {
      const r = new BorshReader(data, 8);
      const args = CODECS[name].decode(r);
      if (r.remaining() !== 0) throw new Error(`${name} has ${r.remaining()} unexpected trailing bytes`);
      return { name, args } as DecodedCardInstruction;
    }
  }
  throw new Error("Unknown card_policy instruction discriminator");
}

/**
 * Client-side mirror of the `set_policy` validation (contracts.md §1.3 #6).
 * The program is the authority; this only stops an owner from signing a
 * transaction that is certain to fail. Returns plain-language problems.
 */
export function policyArgsProblems(p: PolicyArgs): string[] {
  const problems: string[] = [];
  if (p.maxPurchaseCents <= 0n) problems.push("Max purchase must be more than $0.");
  if (p.maxPurchaseCents > p.budgetCents) problems.push("Max purchase can't be more than the budget.");
  if (p.budgetCents > MAX_BUDGET_CENTS) problems.push("Budget can't be more than $10,000 in the sandbox.");
  if (p.periodSeconds < MIN_PERIOD_SECONDS) problems.push("A period must be at least one day.");
  if (p.currency !== "USD") problems.push("Cards only spend USD.");
  if (!Number.isInteger(p.feeBps) || p.feeBps < 0 || p.feeBps > MAX_FEE_BPS) problems.push("Fee can't be more than 10%.");
  if (p.merchantIdHashes.length === 0 && p.mccs.length === 0) problems.push("Pick at least one shop or merchant category.");
  if (p.merchantIdHashes.length > MAX_MERCHANTS) problems.push(`At most ${MAX_MERCHANTS} shops.`);
  if (p.mccs.length > MAX_MCCS) problems.push(`At most ${MAX_MCCS} merchant categories.`);
  const hashes = new Set(p.merchantIdHashes.map((hash) => Array.from(hash).join(",")));
  if (hashes.size !== p.merchantIdHashes.length) problems.push("A shop is listed twice.");
  if (new Set(p.mccs).size !== p.mccs.length) problems.push("A merchant category is listed twice.");
  return problems;
}

function build<K extends CardPolicyInstructionName>(
  name: K,
  snake: string,
  programId: Address | undefined,
  keys: ReturnType<typeof meta>[],
  args: CardInstructionArgs[K],
): ChainPayInstruction {
  return instruction(snake, resolveCardPolicyProgramId(programId), keys, encodeCardInstructionData(name, args));
}

type CardRef = { owner: Address; cardId: Uint8Array };

/** OwnerCardEvent: owner (signer), policy (mut), period (mut). */
function ownerEventKeys(owner: Address, a: { policy: Address; period: Address }) {
  return [meta(owner, false, true), meta(a.policy, true), meta(a.period, true)];
}

// ------------------------------------------------ owner-signed (browser) builders

export function buildInitCardInstruction(
  input: CardRef & { issuer: number; issuerCardRefHash: Uint8Array; prefundLamports: bigint },
  programId?: Address,
): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("initCard", "init_card", programId, [
    meta(input.owner, true, true),
    meta(a.binding, true),
    meta(a.policy, true),
    meta(a.period, true),
    meta(a.commitment, true),
    meta(SYSTEM_PROGRAM_ID),
  ], { cardId: input.cardId, issuer: input.issuer, issuerCardRefHash: input.issuerCardRefHash, prefundLamports: input.prefundLamports });
}

export function buildDelegateCardInstruction(input: CardRef & { validator: Address }, programId?: Address): ChainPayInstruction {
  if (!TEE_VALIDATOR_ALLOWLIST.includes(input.validator)) throw new Error("Validator is not an allowed TEE validator");
  const id = resolveCardPolicyProgramId(programId);
  const a = deriveCardAccounts(input.owner, input.cardId, id);
  const delegated = (account: Address) => [
    meta(deriveDelegationBufferAddress(account, id), true),
    meta(deriveDelegationRecordAddress(account), true),
    meta(deriveDelegationMetadataAddress(account), true),
    meta(account, true),
  ];
  return build("delegateCard", "delegate_card", id, [
    meta(input.owner, true, true),
    meta(a.binding),
    ...delegated(a.policy),
    ...delegated(a.period),
    meta(id),
    meta(DELEGATION_PROGRAM_ID),
    meta(SYSTEM_PROGRAM_ID),
  ], { validator: input.validator });
}

function permissionKeys(owner: Address, cardId: Uint8Array, programId?: Address) {
  const a = deriveCardAccounts(owner, cardId, programId);
  return [
    meta(owner, false, true),
    meta(a.policy, true),
    meta(a.period, true),
    meta(a.policyPermission, true),
    meta(a.periodPermission, true),
    meta(EPHEMERAL_VAULT_ID, true),
    meta(MAGIC_PROGRAM_ID),
    meta(PERMISSION_PROGRAM_ID),
  ];
}

/** PER. Owner creates the private permissions for policy and period. */
export function buildInitPermissionInstruction(input: CardRef & { authorizer: Address }, programId?: Address): ChainPayInstruction {
  return build("initPermission", "init_permission", programId, permissionKeys(input.owner, input.cardId, programId), { authorizer: input.authorizer });
}

/** `[ephemeral account, its permission]` pairs, as `wipe_card` and `update_permission` take them in remaining_accounts. */
function ephemeralPairs(accounts: readonly Address[] | undefined) {
  return (accounts ?? []).flatMap((account) => [meta(account, true), meta(derivePermissionAddress(account), true)]);
}

/**
 * PER. Owner adds or removes a read-only finance reader. There is no "make public" op.
 * `ephemeralAccounts` (open Reservations/CheckoutIntents) are re-synced in the same
 * transaction, so removing a reader also revokes their view of open holds at once.
 */
export function buildUpdatePermissionInstruction(input: CardRef & { op: PermissionOp; ephemeralAccounts?: Address[] }, programId?: Address): ChainPayInstruction {
  if (input.op.kind !== "add_reader" && input.op.kind !== "remove_reader") throw new Error("Only add_reader and remove_reader are allowed");
  return build("updatePermission", "update_permission", programId, [...permissionKeys(input.owner, input.cardId, programId), ...ephemeralPairs(input.ephemeralAccounts)], { op: input.op });
}

/**
 * PER. The owner signs this over their own TEE connection. Rejects a policy the program would reject.
 *
 * Once the card's policy is set, changing the credit terms (the authorizer, the
 * fee, a larger budget or a shorter period) also needs ChainPay's current
 * authorizer as `coSigner`: it rides as an extra signer account and the
 * program refuses the change without it. The authorizer is never the owner.
 */
export function buildSetPolicyInstruction(input: CardRef & { policy: PolicyArgs; coSigner?: Address }, programId?: Address): ChainPayInstruction {
  const problems = policyArgsProblems(input.policy);
  if (input.policy.authorizer === input.owner) problems.push("The authorizer can't be the owner.");
  if (input.coSigner !== undefined && input.coSigner === input.owner) problems.push("The co-signer must be ChainPay's authorizer, not the owner.");
  if (problems.length) throw new Error(problems.join(" "));
  // set_policy shares the CardPermissions account struct; the co-signer is the first remaining account.
  const keys = permissionKeys(input.owner, input.cardId, programId);
  if (input.coSigner !== undefined) keys.push(meta(input.coSigner, false, true));
  return build("setPolicy", "set_policy", programId, keys, { policy: input.policy });
}

/** PER. Owner freeze (reason 1). The authorizer variant lives in Axum. */
export function buildFreezeInstruction(input: CardRef & { signer?: Address; reason?: number }, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("freeze", "freeze", programId, [meta(input.signer ?? input.owner, false, true), meta(a.policy, true), meta(a.period)], { reason: input.reason ?? 1 });
}

/** PER. Owner only. Never built or sent by an agent tool. */
export function buildUnfreezeInstruction(input: CardRef, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("unfreeze", "unfreeze", programId, ownerEventKeys(input.owner, a), {});
}

export function buildResolveExceptionInstruction(input: CardRef & { eventIdHash: Uint8Array; resolution: number }, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("resolveException", "resolve_exception", programId, ownerEventKeys(input.owner, a), { eventIdHash: input.eventIdHash, resolution: input.resolution });
}

export function buildCancelCheckoutIntentInstruction(input: CardRef & { intentId: Uint8Array; signer?: Address }, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("cancelCheckoutIntent", "cancel_checkout_intent", programId, [
    meta(input.signer ?? input.owner, false, true),
    meta(a.policy),
    meta(deriveCheckoutIntentAddress(a.policy, input.intentId, programId), true),
  ], {});
}

/**
 * PER. Co-signed: owner and the card's member authorizer must both sign
 * (program 1A review), so the owner alone can't rewrite counters or debt.
 * Axum signs as authorizer first; the owner checks and adds a signature.
 */
export function buildRestoreInstruction(input: CardRef & { authorizer: Address; restore: RestoreArgs }, programId?: Address): ChainPayInstruction {
  if (input.authorizer === input.owner) throw new Error("The authorizer can't be the owner");
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("restore", "restore", programId, [
    meta(input.owner, false, true),
    meta(input.authorizer, false, true),
    meta(a.policy, true),
    meta(a.period, true),
  ], { restore: input.restore });
}

/**
 * PER. Owner or authorizer closes a consumed, cancelled or expired intent and
 * its permission, returning the rent to the card prefund.
 */
export function buildCloseCheckoutIntentInstruction(input: CardRef & { intentId: Uint8Array; signer?: Address }, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  const intent = deriveCheckoutIntentAddress(a.policy, input.intentId, programId);
  return build("closeCheckoutIntent", "close_checkout_intent", programId, [
    meta(input.signer ?? input.owner, false, true),
    meta(a.policy, true),
    meta(intent, true),
    meta(derivePermissionAddress(intent), true),
    meta(EPHEMERAL_VAULT_ID, true),
    meta(MAGIC_PROGRAM_ID),
    meta(PERMISSION_PROGRAM_ID),
  ], {});
}

export type RepayStatementInput = CardRef & {
  /** The owner's ChainPay mandate whose `approvedAgent` is this card's repay agent. */
  mandate: Address;
  mint: Address;
  sourceTokenAccount: Address;
  /** The partner token account the statement's `payWith` names. */
  recipientTokenAccount: Address;
  /** 32-byte statement digest; becomes the receipt's `invoice_hash`. */
  statementDigest: Uint8Array;
  /** Exact base units of `mint` (the statement's amount due). */
  amount: bigint;
  tokenProgram?: Address;
  chainpayProgramId?: Address;
};

/**
 * Base layer, owner-signed. card_policy's repay agent PDA `["repay_agent", binding]`
 * signs ChainPay `execute_payment` by CPI, so ChainPay enforces the mandate and creates
 * the receipt `["receipt", mandate, statementDigest]`. The owner pays the receipt rent.
 * Returns the receipt address the Axum relay verifies and `record_repayment` re-checks on PER.
 */
export function buildRepayStatementInstruction(input: RepayStatementInput, programId?: Address): { instruction: ChainPayInstruction; receipt: Address; repayAgent: Address } {
  if (input.amount <= 0n) throw new Error("Repayment amount must be positive");
  const id = resolveCardPolicyProgramId(programId);
  const chainpay = input.chainpayProgramId ?? DEFAULT_PROGRAM_ID;
  const a = deriveCardAccounts(input.owner, input.cardId, id);
  const repayAgent = deriveRepayAgentAddress(a.binding, id);
  const receipt = deriveReceiptAddress(input.mandate, input.statementDigest, chainpay);
  const ix = build("repayStatement", "repay_statement", id, [
    meta(input.owner, true, true),
    meta(a.binding),
    meta(repayAgent, true),
    meta(deriveConfigAddress(chainpay)),
    meta(deriveAssetAddress(input.mint, chainpay)),
    meta(input.mandate, true),
    meta(receipt, true),
    meta(input.mint),
    meta(input.sourceTokenAccount, true),
    meta(input.recipientTokenAccount, true),
    meta(input.tokenProgram ?? SPL_TOKEN_PROGRAM_ID),
    meta(SYSTEM_PROGRAM_ID),
    meta(chainpay),
  ], { statementDigest: input.statementDigest, amount: input.amount });
  return { instruction: ix, receipt, repayAgent };
}

export function buildConfirmReconciledInstruction(input: CardRef & { reconDigest: Uint8Array }, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("confirmReconciled", "confirm_reconciled", programId, ownerEventKeys(input.owner, a), { reconDigest: input.reconDigest });
}

/**
 * PER. Owner or authorizer closes a final Reservation (fully captured, reversed
 * or expired; nothing held; no open dispute) and its permission. The rent goes
 * back to the card prefund and the auth id moves into the card's AuthGuard
 * ring, so a replayed issuer authorization still gets `DuplicateAuthorization`.
 * Axum normally does this; the owner can too.
 */
export function buildCloseReservationInstruction(input: CardRef & { authIdHash: Uint8Array; signer?: Address }, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  const reservation = deriveReservationAddress(a.policy, input.authIdHash, programId);
  const guard = deriveAuthGuardAddress(a.policy, programId);
  return build("closeReservation", "close_reservation", programId, [
    meta(input.signer ?? input.owner, false, true),
    meta(a.policy, true),
    meta(a.period),
    meta(reservation, true),
    meta(derivePermissionAddress(reservation), true),
    meta(guard, true),
    meta(derivePermissionAddress(guard), true),
    meta(EPHEMERAL_VAULT_ID, true),
    meta(MAGIC_PROGRAM_ID),
    meta(PERMISSION_PROGRAM_ID),
  ], {});
}

/**
 * `ephemeralAccounts` lists every live Reservation and CheckoutIntent of the
 * card, plus its AuthGuard once a reservation was ever closed
 * (`deriveAuthGuardAddress`); each goes in remaining_accounts as
 * [account, its permission] so the program can close it. Omitting one leaves
 * private data behind (`EphemeralAccountsOpen`).
 */
export function buildWipeCardInstruction(input: CardRef & { ephemeralAccounts?: Address[] }, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  const remaining = ephemeralPairs(input.ephemeralAccounts);
  return build("wipeCard", "wipe_card", programId, [
    meta(input.owner, true, true),
    meta(a.policy, true),
    meta(a.period, true),
    meta(a.policyPermission, true),
    meta(a.periodPermission, true),
    meta(EPHEMERAL_VAULT_ID, true),
    meta(MAGIC_CONTEXT_ID, true),
    meta(MAGIC_PROGRAM_ID),
    meta(PERMISSION_PROGRAM_ID),
    ...remaining,
  ], {});
}

export function buildCloseCardInstruction(input: CardRef, programId?: Address): ChainPayInstruction {
  const a = deriveCardAccounts(input.owner, input.cardId, programId);
  return build("closeCard", "close_card", programId, [
    meta(input.owner, true, true),
    meta(a.binding, true),
    meta(a.policy, true),
    meta(a.period, true),
  ], {});
}

/**
 * Base layer `#[action]`. Account order is fixed by contracts.md §1.3 #24:
 * commitment, binding, source_program, escrow_auth (= policy PDA), escrow (signer).
 * Only the delegation program can satisfy the escrow signer; exposed for tests and card-sim.
 */
export function buildWriteCommitmentInstruction(
  input: CardRef & { root: Uint8Array; seq: bigint; policyVersion: number; periodIndex: number },
  programId?: Address,
): ChainPayInstruction {
  const id = resolveCardPolicyProgramId(programId);
  const a = deriveCardAccounts(input.owner, input.cardId, id);
  return build("writeCommitment", "write_commitment", id, [
    meta(a.commitment, true),
    meta(a.binding),
    meta(id),
    meta(a.policy),
    meta(a.escrow, false, true),
  ], { root: input.root, seq: input.seq, policyVersion: input.policyVersion, periodIndex: input.periodIndex });
}
