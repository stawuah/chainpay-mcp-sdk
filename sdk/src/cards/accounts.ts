import type { Address } from "../types.js";
import { assertDiscriminator } from "../encoding.js";
import {
  CARD_ACCOUNT_DISCRIMINATORS,
  MAX_MCCS,
  MAX_MEMBERS,
  MAX_MERCHANTS,
} from "./constants.js";
import { BorshReader, BorshWriter } from "./layout.js";

/*
 * Typed decoders for every card_policy account (contracts.md §1.2). Layouts
 * are the Rust structs in field order, Borsh little-endian, after the 8-byte
 * Anchor discriminator. Fixed-capacity arrays decode in full but only the
 * first `*_count` entries are returned. Decoders accept trailing bytes so an
 * append-only program change (for example a capture-id ring on
 * Reservation) does not break older readers.
 */

export type CardBindingStatus = "active" | "closing" | "closed";
export type CardFreezeReason = "none" | "owner" | "authorizer_safety" | "recovery" | "expiry";
export type CardRecoveryState = "normal" | "recovery_frozen" | "restored_pending_reconcile";
export type OnChainReservationState = number;

/** On-chain ReservationState bytes as card_policy defines them (0 is never written). */
export const RESERVATION_STATES = { 1: "reserved", 2: "partially_captured", 3: "captured", 4: "reversed", 5: "expired" } as const;
export type ReservationStateName = (typeof RESERVATION_STATES)[keyof typeof RESERVATION_STATES];

export function reservationStateName(state: number): ReservationStateName | undefined {
  return (RESERVATION_STATES as Record<number, ReservationStateName>)[state];
}
export type IntentState = "open" | "consumed" | "expired" | "cancelled";
export type DisputeState = "none" | "open" | "won" | "lost" | "withdrawn";

const BINDING_STATUS: readonly CardBindingStatus[] = ["active", "closing", "closed"];
const FREEZE_REASONS: readonly CardFreezeReason[] = ["none", "owner", "authorizer_safety", "recovery", "expiry"];
const RECOVERY_STATES: readonly CardRecoveryState[] = ["normal", "recovery_frozen", "restored_pending_reconcile"];
const INTENT_STATES: readonly IntentState[] = ["open", "consumed", "expired", "cancelled"];
const DISPUTE_STATES: readonly DisputeState[] = ["none", "open", "won", "lost", "withdrawn"];

function enumValue<T>(values: readonly T[], raw: number, name: string): T {
  const value = values[raw];
  if (value === undefined) throw new Error(`Unknown ${name} value ${raw}`);
  return value;
}

function enumIndex<T>(values: readonly T[], value: T, name: string): number {
  const index = values.indexOf(value);
  if (index < 0) throw new Error(`Unknown ${name} ${String(value)}`);
  return index;
}

function currencyFromBytes(bytes: Uint8Array): string {
  if (bytes.every((byte) => byte === 0)) return "";
  return String.fromCharCode(...bytes);
}

export function currencyBytes(currency: string): Uint8Array {
  if (currency === "") return new Uint8Array(3);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a 3-letter uppercase code");
  return Uint8Array.from(currency, (char) => char.charCodeAt(0));
}

function bytesOf(data: Uint8Array | Buffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function header(data: Uint8Array | Buffer, discriminator: Uint8Array, name: string, minLength: number): BorshReader {
  const bytes = bytesOf(data);
  assertDiscriminator(bytes, discriminator, name);
  if (bytes.length < minLength) throw new Error(`${name} account data is truncated`);
  return new BorshReader(bytes, 8);
}

// ---------------------------------------------------------------- CardBinding

export type CardBinding = {
  version: number;
  owner: Address;
  cardId: Uint8Array;
  issuer: number;
  issuerCardRefHash: Uint8Array;
  policy: Address;
  period: Address;
  commitment: Address;
  status: CardBindingStatus;
  createdAt: bigint;
  bump: number;
};

export const CARD_BINDING_LENGTH = 8 + 1 + 32 + 32 + 1 + 32 + 32 * 3 + 1 + 8 + 1;

export function decodeCardBinding(data: Uint8Array | Buffer): CardBinding {
  const r = header(data, CARD_ACCOUNT_DISCRIMINATORS.cardBinding, "CardBinding", CARD_BINDING_LENGTH);
  return {
    version: r.u8("version"),
    owner: r.pubkey("owner"),
    cardId: r.fixed(32, "cardId"),
    issuer: r.u8("issuer"),
    issuerCardRefHash: r.fixed(32, "issuerCardRefHash"),
    policy: r.pubkey("policy"),
    period: r.pubkey("period"),
    commitment: r.pubkey("commitment"),
    status: enumValue(BINDING_STATUS, r.u8("status"), "binding status"),
    createdAt: r.i64("createdAt"),
    bump: r.u8("bump"),
  };
}

export function encodeCardBinding(value: CardBinding): Uint8Array {
  return new BorshWriter()
    .bytes(CARD_ACCOUNT_DISCRIMINATORS.cardBinding)
    .u8(value.version, "version")
    .pubkey(value.owner)
    .fixed(value.cardId, 32, "cardId")
    .u8(value.issuer, "issuer")
    .fixed(value.issuerCardRefHash, 32, "issuerCardRefHash")
    .pubkey(value.policy)
    .pubkey(value.period)
    .pubkey(value.commitment)
    .u8(enumIndex(BINDING_STATUS, value.status, "binding status"))
    .i64(value.createdAt, "createdAt")
    .u8(value.bump, "bump")
    .toBytes();
}

// ----------------------------------------------------------------- CardPolicy

export type CardPolicyMember = { pubkey: Address; flags: number };

export type CardPolicy = {
  binding: Address;
  owner: Address;
  /** Zero address until the first `set_policy`; every authorization fails until then. */
  authorizer: Address;
  policyVersion: number;
  budgetCents: bigint;
  maxPurchaseCents: bigint;
  /** 0 = no count limit. */
  maxPurchasesPerPeriod: number;
  periodSeconds: number;
  currency: string;
  merchantIdHashes: Uint8Array[];
  mccs: number[];
  /** 0 = no expiry. Unix seconds on the PER clock. */
  expiresAt: bigint;
  recurringAllowed: boolean;
  feeBps: number;
  frozen: boolean;
  freezeReason: CardFreezeReason;
  recoveryState: CardRecoveryState;
  statementOutstandingCents: bigint;
  exceptionsOpen: number;
  members: CardPolicyMember[];
  ledgerHead: Uint8Array;
  ledgerSeq: bigint;
  commitSeq: bigint;
  bump: number;
  /**
   * Program-appended tail (not in contracts.md §1.2): last reconciliation
   * digest and the ring of used repayment digests. Present only when the
   * account is long enough; encoders never write it.
   */
  tail?: { reconDigest: Uint8Array; repaymentDigests: Uint8Array[] };
};

const REPAYMENT_RING = 8;
const CAPTURE_RING = 8;

export const CARD_POLICY_LENGTH =
  8 + 32 * 3 + 4 + 8 + 8 + 2 + 4 + 3 + 1 + 32 * MAX_MERCHANTS + 1 + 2 * MAX_MCCS + 8 + 1 + 2 + 1 + 1 + 1 + 8 + 2 + 1
  + 32 * MAX_MEMBERS + MAX_MEMBERS + 32 + 8 + 8 + 1;

export function decodeCardPolicy(data: Uint8Array | Buffer): CardPolicy {
  const r = header(data, CARD_ACCOUNT_DISCRIMINATORS.cardPolicy, "CardPolicy", CARD_POLICY_LENGTH);
  const binding = r.pubkey("binding");
  const owner = r.pubkey("owner");
  const authorizer = r.pubkey("authorizer");
  const policyVersion = r.u32("policyVersion");
  const budgetCents = r.u64("budgetCents");
  const maxPurchaseCents = r.u64("maxPurchaseCents");
  const maxPurchasesPerPeriod = r.u16("maxPurchasesPerPeriod");
  const periodSeconds = r.u32("periodSeconds");
  const currency = currencyFromBytes(r.fixed(3, "currency"));
  const merchantCount = r.u8("merchantCount");
  if (merchantCount > MAX_MERCHANTS) throw new Error("CardPolicy merchant_count exceeds capacity");
  const allMerchants = Array.from({ length: MAX_MERCHANTS }, (_, i) => r.fixed(32, `merchantIdHashes[${i}]`));
  const mccCount = r.u8("mccCount");
  if (mccCount > MAX_MCCS) throw new Error("CardPolicy mcc_count exceeds capacity");
  const allMccs = Array.from({ length: MAX_MCCS }, (_, i) => r.u16(`mccs[${i}]`));
  const expiresAt = r.i64("expiresAt");
  const recurringAllowed = r.bool("recurringAllowed");
  const feeBps = r.u16("feeBps");
  const frozen = r.bool("frozen");
  const freezeReason = enumValue(FREEZE_REASONS, r.u8("freezeReason"), "freeze reason");
  const recoveryState = enumValue(RECOVERY_STATES, r.u8("recoveryState"), "recovery state");
  const statementOutstandingCents = r.u64("statementOutstandingCents");
  const exceptionsOpen = r.u16("exceptionsOpen");
  const memberCount = r.u8("memberCount");
  if (memberCount > MAX_MEMBERS) throw new Error("CardPolicy member_count exceeds capacity");
  const allMembers = Array.from({ length: MAX_MEMBERS }, (_, i) => r.pubkey(`members[${i}]`));
  const allFlags = Array.from({ length: MAX_MEMBERS }, (_, i) => r.u8(`memberFlags[${i}]`));
  return {
    binding,
    owner,
    authorizer,
    policyVersion,
    budgetCents,
    maxPurchaseCents,
    maxPurchasesPerPeriod,
    periodSeconds,
    currency,
    merchantIdHashes: allMerchants.slice(0, merchantCount),
    mccs: allMccs.slice(0, mccCount),
    expiresAt,
    recurringAllowed,
    feeBps,
    frozen,
    freezeReason,
    recoveryState,
    statementOutstandingCents,
    exceptionsOpen,
    members: allMembers.slice(0, memberCount).map((pubkey, i) => ({ pubkey, flags: allFlags[i] })),
    ledgerHead: r.fixed(32, "ledgerHead"),
    ledgerSeq: r.u64("ledgerSeq"),
    commitSeq: r.u64("commitSeq"),
    bump: r.u8("bump"),
    ...policyTail(r),
  };
}

function policyTail(r: BorshReader): { tail?: CardPolicy["tail"] } {
  if (r.remaining() < 32 + 32 * REPAYMENT_RING + 1) return {};
  const reconDigest = r.fixed(32, "reconDigest");
  const ring = Array.from({ length: REPAYMENT_RING }, (_, i) => r.fixed(32, `repaymentDigests[${i}]`));
  const count = Math.min(r.u8("repaymentCount"), REPAYMENT_RING);
  return { tail: { reconDigest, repaymentDigests: ring.slice(0, count) } };
}

export function encodeCardPolicy(value: CardPolicy): Uint8Array {
  if (value.merchantIdHashes.length > MAX_MERCHANTS) throw new Error(`At most ${MAX_MERCHANTS} merchants`);
  if (value.mccs.length > MAX_MCCS) throw new Error(`At most ${MAX_MCCS} MCCs`);
  if (value.members.length > MAX_MEMBERS) throw new Error(`At most ${MAX_MEMBERS} members`);
  const w = new BorshWriter()
    .bytes(CARD_ACCOUNT_DISCRIMINATORS.cardPolicy)
    .pubkey(value.binding)
    .pubkey(value.owner)
    .pubkey(value.authorizer)
    .u32(value.policyVersion, "policyVersion")
    .u64(value.budgetCents, "budgetCents")
    .u64(value.maxPurchaseCents, "maxPurchaseCents")
    .u16(value.maxPurchasesPerPeriod, "maxPurchasesPerPeriod")
    .u32(value.periodSeconds, "periodSeconds")
    .fixed(currencyBytes(value.currency), 3, "currency")
    .u8(value.merchantIdHashes.length);
  for (let i = 0; i < MAX_MERCHANTS; i += 1) w.fixed(value.merchantIdHashes[i] ?? new Uint8Array(32), 32, `merchantIdHashes[${i}]`);
  w.u8(value.mccs.length);
  for (let i = 0; i < MAX_MCCS; i += 1) w.u16(value.mccs[i] ?? 0, `mccs[${i}]`);
  w.i64(value.expiresAt, "expiresAt")
    .bool(value.recurringAllowed)
    .u16(value.feeBps, "feeBps")
    .bool(value.frozen)
    .u8(enumIndex(FREEZE_REASONS, value.freezeReason, "freeze reason"))
    .u8(enumIndex(RECOVERY_STATES, value.recoveryState, "recovery state"))
    .u64(value.statementOutstandingCents, "statementOutstandingCents")
    .u16(value.exceptionsOpen, "exceptionsOpen")
    .u8(value.members.length);
  for (let i = 0; i < MAX_MEMBERS; i += 1) w.fixed(value.members[i] ? publicKeyBytes(value.members[i].pubkey) : new Uint8Array(32), 32, `members[${i}]`);
  for (let i = 0; i < MAX_MEMBERS; i += 1) w.u8(value.members[i]?.flags ?? 0, `memberFlags[${i}]`);
  return w.fixed(value.ledgerHead, 32, "ledgerHead")
    .u64(value.ledgerSeq, "ledgerSeq")
    .u64(value.commitSeq, "commitSeq")
    .u8(value.bump, "bump")
    .toBytes();
}

function publicKeyBytes(value: Address): Uint8Array {
  return new BorshWriter().pubkey(value).toBytes();
}

// ----------------------------------------------------------------- CardPeriod

export type CardPeriod = {
  policy: Address;
  /** 0 before the first set_policy; 1.. thereafter. */
  periodIndex: number;
  periodStart: bigint;
  periodEnd: bigint;
  capturedCents: bigint;
  reservedCents: bigint;
  refundedCents: bigint;
  purchasesCount: number;
  exceptionCents: bigint;
  bump: number;
};

export const CARD_PERIOD_LENGTH = 8 + 32 + 4 + 8 + 8 + 8 + 8 + 8 + 2 + 8 + 1;

export function decodeCardPeriod(data: Uint8Array | Buffer): CardPeriod {
  const r = header(data, CARD_ACCOUNT_DISCRIMINATORS.cardPeriod, "CardPeriod", CARD_PERIOD_LENGTH);
  return {
    policy: r.pubkey("policy"),
    periodIndex: r.u32("periodIndex"),
    periodStart: r.i64("periodStart"),
    periodEnd: r.i64("periodEnd"),
    capturedCents: r.u64("capturedCents"),
    reservedCents: r.u64("reservedCents"),
    refundedCents: r.u64("refundedCents"),
    purchasesCount: r.u16("purchasesCount"),
    exceptionCents: r.u64("exceptionCents"),
    bump: r.u8("bump"),
  };
}

export function encodeCardPeriod(value: CardPeriod): Uint8Array {
  return new BorshWriter()
    .bytes(CARD_ACCOUNT_DISCRIMINATORS.cardPeriod)
    .pubkey(value.policy)
    .u32(value.periodIndex, "periodIndex")
    .i64(value.periodStart, "periodStart")
    .i64(value.periodEnd, "periodEnd")
    .u64(value.capturedCents, "capturedCents")
    .u64(value.reservedCents, "reservedCents")
    .u64(value.refundedCents, "refundedCents")
    .u16(value.purchasesCount, "purchasesCount")
    .u64(value.exceptionCents, "exceptionCents")
    .u8(value.bump, "bump")
    .toBytes();
}

// ---------------------------------------------------------------- Reservation

/** Reservation.flags bits (contracts.md §1.2). */
export const RESERVATION_FLAGS = {
  lateCapture: 1 << 0,
  overCapture: 1 << 1,
  singleMessage: 1 << 2,
  recurring: 1 << 3,
} as const;

export type Reservation = {
  policy: Address;
  authIdHash: Uint8Array;
  intent: Address;
  periodIndex: number;
  amountReservedCents: bigint;
  capturedCents: bigint;
  reversedCents: bigint;
  refundedCents: bigint;
  /** On-chain ReservationState byte (§4.1). Off-chain states (pending, ambiguous) never appear here. */
  state: OnChainReservationState;
  disputeState: DisputeState;
  flags: number;
  createdAt: bigint;
  holdExpiresAt: bigint;
  bump: number;
  /** Program-appended capture-id ring (replay guard for `capture`). Present only when the account is long enough. */
  captureIdHashes?: Uint8Array[];
  /** Program-appended: the checkout intent's max; `adjust_reservation` never grows the hold past it. */
  maxAmountCents?: bigint;
};

export const RESERVATION_LENGTH = 8 + 32 + 32 + 32 + 4 + 8 * 4 + 1 + 1 + 1 + 8 + 8 + 1;

export function decodeReservation(data: Uint8Array | Buffer): Reservation {
  const r = header(data, CARD_ACCOUNT_DISCRIMINATORS.reservation, "Reservation", RESERVATION_LENGTH);
  return {
    policy: r.pubkey("policy"),
    authIdHash: r.fixed(32, "authIdHash"),
    intent: r.pubkey("intent"),
    periodIndex: r.u32("periodIndex"),
    amountReservedCents: r.u64("amountReservedCents"),
    capturedCents: r.u64("capturedCents"),
    reversedCents: r.u64("reversedCents"),
    refundedCents: r.u64("refundedCents"),
    state: r.u8("state"),
    disputeState: enumValue(DISPUTE_STATES, r.u8("disputeState"), "dispute state"),
    flags: r.u8("flags"),
    createdAt: r.i64("createdAt"),
    holdExpiresAt: r.i64("holdExpiresAt"),
    bump: r.u8("bump"),
    ...captureTail(r),
  };
}

function captureTail(r: BorshReader): { captureIdHashes?: Uint8Array[]; maxAmountCents?: bigint } {
  if (r.remaining() < 1 + 32 * CAPTURE_RING) return {};
  const count = Math.min(r.u8("captureCount"), CAPTURE_RING);
  const ring = Array.from({ length: CAPTURE_RING }, (_, i) => r.fixed(32, `captureIds[${i}]`));
  if (r.remaining() < 8) return { captureIdHashes: ring.slice(0, count) };
  return { captureIdHashes: ring.slice(0, count), maxAmountCents: r.u64("maxAmountCents") };
}

export function encodeReservation(value: Reservation): Uint8Array {
  return new BorshWriter()
    .bytes(CARD_ACCOUNT_DISCRIMINATORS.reservation)
    .pubkey(value.policy)
    .fixed(value.authIdHash, 32, "authIdHash")
    .pubkey(value.intent)
    .u32(value.periodIndex, "periodIndex")
    .u64(value.amountReservedCents, "amountReservedCents")
    .u64(value.capturedCents, "capturedCents")
    .u64(value.reversedCents, "reversedCents")
    .u64(value.refundedCents, "refundedCents")
    .u8(value.state, "state")
    .u8(enumIndex(DISPUTE_STATES, value.disputeState, "dispute state"))
    .u8(value.flags, "flags")
    .i64(value.createdAt, "createdAt")
    .i64(value.holdExpiresAt, "holdExpiresAt")
    .u8(value.bump, "bump")
    .toBytes();
}

// ------------------------------------------------------------- CheckoutIntent

export type CheckoutIntent = {
  policy: Address;
  intentId: Uint8Array;
  agent: Address;
  merchantIdHash: Uint8Array;
  /** 0 = any allowed MCC. */
  mcc: number;
  maxAmountCents: bigint;
  currency: string;
  policyVersion: number;
  expiresAt: bigint;
  state: IntentState;
  reservation: Address;
  bump: number;
};

export const CHECKOUT_INTENT_LENGTH = 8 + 32 + 16 + 32 + 32 + 2 + 8 + 3 + 4 + 8 + 1 + 32 + 1;

export function decodeCheckoutIntent(data: Uint8Array | Buffer): CheckoutIntent {
  const r = header(data, CARD_ACCOUNT_DISCRIMINATORS.checkoutIntent, "CheckoutIntent", CHECKOUT_INTENT_LENGTH);
  return {
    policy: r.pubkey("policy"),
    intentId: r.fixed(16, "intentId"),
    agent: r.pubkey("agent"),
    merchantIdHash: r.fixed(32, "merchantIdHash"),
    mcc: r.u16("mcc"),
    maxAmountCents: r.u64("maxAmountCents"),
    currency: currencyFromBytes(r.fixed(3, "currency")),
    policyVersion: r.u32("policyVersion"),
    expiresAt: r.i64("expiresAt"),
    state: enumValue(INTENT_STATES, r.u8("state"), "intent state"),
    reservation: r.pubkey("reservation"),
    bump: r.u8("bump"),
  };
}

export function encodeCheckoutIntent(value: CheckoutIntent): Uint8Array {
  return new BorshWriter()
    .bytes(CARD_ACCOUNT_DISCRIMINATORS.checkoutIntent)
    .pubkey(value.policy)
    .fixed(value.intentId, 16, "intentId")
    .pubkey(value.agent)
    .fixed(value.merchantIdHash, 32, "merchantIdHash")
    .u16(value.mcc, "mcc")
    .u64(value.maxAmountCents, "maxAmountCents")
    .fixed(currencyBytes(value.currency), 3, "currency")
    .u32(value.policyVersion, "policyVersion")
    .i64(value.expiresAt, "expiresAt")
    .u8(enumIndex(INTENT_STATES, value.state, "intent state"))
    .pubkey(value.reservation)
    .u8(value.bump, "bump")
    .toBytes();
}

// ------------------------------------------------------------- CardCommitment

export type CardCommitment = {
  binding: Address;
  seq: bigint;
  root: Uint8Array;
  policyVersion: number;
  periodIndex: number;
  writtenSlot: bigint;
  bump: number;
};

export const CARD_COMMITMENT_LENGTH = 8 + 32 + 8 + 32 + 4 + 4 + 8 + 1;

export function decodeCardCommitment(data: Uint8Array | Buffer): CardCommitment {
  const r = header(data, CARD_ACCOUNT_DISCRIMINATORS.cardCommitment, "CardCommitment", CARD_COMMITMENT_LENGTH);
  return {
    binding: r.pubkey("binding"),
    seq: r.u64("seq"),
    root: r.fixed(32, "root"),
    policyVersion: r.u32("policyVersion"),
    periodIndex: r.u32("periodIndex"),
    writtenSlot: r.u64("writtenSlot"),
    bump: r.u8("bump"),
  };
}

export function encodeCardCommitment(value: CardCommitment): Uint8Array {
  return new BorshWriter()
    .bytes(CARD_ACCOUNT_DISCRIMINATORS.cardCommitment)
    .pubkey(value.binding)
    .u64(value.seq, "seq")
    .fixed(value.root, 32, "root")
    .u32(value.policyVersion, "policyVersion")
    .u32(value.periodIndex, "periodIndex")
    .u64(value.writtenSlot, "writtenSlot")
    .u8(value.bump, "bump")
    .toBytes();
}
