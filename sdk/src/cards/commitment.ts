import { PublicKey } from "@solana/web3.js";
import type { Address } from "../types.js";
import type { CardCommitment, CardPeriod, CardPolicy } from "./accounts.js";
import { formatFeeBps, formatUsdCents } from "./math.js";

/*
 * Salted commitment leaves and single-field disclosure (contracts.md §1.6, §9).
 *
 * Byte layouts mirror programs/card_policy/src/hashes.rs exactly. The owner
 * builds a disclosure bundle for the fields they pick; anyone recomputes the
 * leaf and its Merkle path against the public CardCommitment root. This is an
 * integrity check against ChainPay's on-chain commitment, not a zero-knowledge
 * proof: the disclosed values are shown in the clear.
 */

export const COMMITMENT_LEAF_COUNT = 16;
const LEAF_DOMAIN = "chainpay-card-leaf:v1\n";
const DISCLOSURE_PARAM = "disclose";

export type CommitmentLeafIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export type DisclosedLeaf = {
  i: number;
  /** hex of the leaf's value bytes. */
  value: string;
  /** hex of sha256(master_salt || i). Reveals nothing about other leaves. */
  leafSalt: string;
  /** 4 sibling hashes (hex), bottom-up. */
  proof: string[];
};

export type DisclosureBundle = {
  v: 1;
  /** CardBinding address (base58); the commitment PDA is derived from it. */
  binding: Address;
  commitmentSeq: string;
  leaves: DisclosedLeaf[];
  /** Reserved by contracts §9; not produced or checked by this version. */
  ledger?: { eventBytes: string; subsequentHashes: string[] };
};

// --------------------------------------------------------------- bytes

const enc = new TextEncoder();

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", joined.buffer as ArrayBuffer));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) throw new Error("Expected lowercase hex");
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function le(value: bigint, bytes: number, signed = false): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 2) view.setUint16(0, Number(value), true);
  else if (bytes === 4) view.setUint32(0, Number(value), true);
  else if (signed) view.setBigInt64(0, value, true);
  else view.setBigUint64(0, value, true);
  return out;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

const RECOVERY_BYTE: Record<CardPolicy["recoveryState"], number> = { normal: 0, recovery_frozen: 1, restored_pending_reconcile: 2 };

// --------------------------------------------------------------- leaves

/** Leaf value bytes, fixed per index (hashes.rs `leaf_values`). */
export async function commitmentLeafValues(policy: CardPolicy, period: CardPeriod): Promise<Uint8Array[]> {
  const merchants = [...policy.merchantIdHashes].sort(compareBytes);
  const mccs = [...policy.mccs].sort((a, b) => a - b);
  return [
    new PublicKey(policy.binding).toBytes(),
    le(BigInt(policy.policyVersion), 4),
    le(policy.budgetCents, 8),
    le(policy.maxPurchaseCents, 8),
    le(BigInt(policy.maxPurchasesPerPeriod), 2),
    await sha256(...merchants),
    await sha256(cat(...mccs.map((mcc) => le(BigInt(mcc), 2)))),
    cat(le(policy.expiresAt, 8, true), Uint8Array.of(policy.recurringAllowed ? 1 : 0), le(BigInt(policy.feeBps), 2)),
    cat(le(BigInt(period.periodIndex), 4), le(period.periodStart, 8, true), le(period.periodEnd, 8, true)),
    le(period.capturedCents, 8),
    le(period.reservedCents, 8),
    le(period.refundedCents, 8),
    le(BigInt(period.purchasesCount), 2),
    le(policy.statementOutstandingCents, 8),
    Uint8Array.of(policy.frozen ? 1 : 0, RECOVERY_BYTE[policy.recoveryState]),
    cat(policy.ledgerHead, le(policy.ledgerSeq, 8)),
  ];
}

export function leafSalt(masterSalt: Uint8Array, index: number): Promise<Uint8Array> {
  if (masterSalt.length !== 32) throw new Error("master salt must be 32 bytes");
  return sha256(masterSalt, Uint8Array.of(index));
}

export function leafHash(index: number, salt: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  return sha256(enc.encode(LEAF_DOMAIN), Uint8Array.of(index), salt, value);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(Uint8Array.of(1), left, right);
}

async function levels(leaves: Uint8Array[]): Promise<Uint8Array[][]> {
  if (leaves.length !== COMMITMENT_LEAF_COUNT) throw new Error(`a commitment has exactly ${COMMITMENT_LEAF_COUNT} leaves`);
  const out = [leaves];
  while (out[out.length - 1].length > 1) {
    const level = out[out.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await nodeHash(level[i], level[i + 1]));
    out.push(next);
  }
  return out;
}

/** Root for the given policy, period and checkpoint salt (hashes.rs `commitment_root`). */
export async function commitmentRoot(policy: CardPolicy, period: CardPeriod, masterSalt: Uint8Array): Promise<Uint8Array> {
  const values = await commitmentLeafValues(policy, period);
  const leaves = await Promise.all(values.map(async (value, i) => leafHash(i, await leafSalt(masterSalt, i), value)));
  const tree = await levels(leaves);
  return tree[tree.length - 1][0];
}

/** Owner side: disclose only the picked leaves. `masterSalt` comes from the owner's encrypted recovery record. */
export async function buildDisclosureBundle(input: {
  policy: CardPolicy;
  period: CardPeriod;
  masterSalt: Uint8Array;
  commitmentSeq: bigint;
  indices: readonly number[];
}): Promise<DisclosureBundle> {
  const indices = [...new Set(input.indices)].sort((a, b) => a - b);
  if (indices.length === 0) throw new Error("Pick at least one field to share");
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= COMMITMENT_LEAF_COUNT)) throw new Error("Unknown field");
  const values = await commitmentLeafValues(input.policy, input.period);
  const salts = await Promise.all(values.map((_, i) => leafSalt(input.masterSalt, i)));
  const leaves = await Promise.all(values.map((value, i) => leafHash(i, salts[i], value)));
  const tree = await levels(leaves);
  return {
    v: 1,
    binding: new PublicKey(input.policy.binding).toBase58(),
    commitmentSeq: input.commitmentSeq.toString(),
    leaves: indices.map((i) => {
      const proof: string[] = [];
      let idx = i;
      for (let depth = 0; depth < tree.length - 1; depth += 1) {
        proof.push(bytesToHex(tree[depth][idx ^ 1]));
        idx >>= 1;
      }
      return { i, value: bytesToHex(values[i]), leafSalt: bytesToHex(salts[i]), proof };
    }),
  };
}

// --------------------------------------------------------------- fragment

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of enc.encode(text)) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const binary = globalThis.atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** `/verify/card#disclose=<base64url(JSON)>`. The fragment never reaches a server. */
export function encodeDisclosureFragment(bundle: DisclosureBundle): string {
  return `${DISCLOSURE_PARAM}=${toBase64Url(JSON.stringify(bundle))}`;
}

/** Strict parse: unknown shapes are rejected, never partially trusted. */
export function decodeDisclosureFragment(fragment: string): DisclosureBundle {
  const match = fragment.match(/(?:^#?|&)disclose=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("No shared card record in this link");
  let raw: Partial<DisclosureBundle>;
  try {
    raw = JSON.parse(fromBase64Url(match[1])) as Partial<DisclosureBundle>;
  } catch {
    throw new Error("The shared card record in this link can't be read");
  }
  if (raw.v !== 1) throw new Error("Unsupported card record version");
  if (typeof raw.binding !== "string") throw new Error("The card record has no card link");
  new PublicKey(raw.binding);
  if (typeof raw.commitmentSeq !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(raw.commitmentSeq)) throw new Error("The card record has no commitment number");
  if (!Array.isArray(raw.leaves) || raw.leaves.length === 0 || raw.leaves.length > COMMITMENT_LEAF_COUNT) throw new Error("The card record has no fields");
  const seen = new Set<number>();
  const leaves = raw.leaves.map((leaf) => {
    if (!leaf || !Number.isInteger(leaf.i) || leaf.i < 0 || leaf.i >= COMMITMENT_LEAF_COUNT || seen.has(leaf.i)) throw new Error("The card record has an unknown field");
    seen.add(leaf.i);
    hexToBytes(leaf.value);
    if (hexToBytes(leaf.leafSalt).length !== 32) throw new Error("A field's salt has the wrong length");
    if (!Array.isArray(leaf.proof) || leaf.proof.length !== 4 || leaf.proof.some((node) => typeof node !== "string" || hexToBytes(node).length !== 32)) throw new Error("A field's proof has the wrong shape");
    return { i: leaf.i, value: leaf.value, leafSalt: leaf.leafSalt, proof: [...leaf.proof] };
  });
  return { v: 1, binding: raw.binding, commitmentSeq: raw.commitmentSeq, leaves };
}

// --------------------------------------------------------------- verify

export type DisclosureLeafCheck = { i: number; ok: boolean; field: CommitmentFieldView };

export type DisclosureCheck =
  | { state: "verified"; seq: string; root: string; writtenSlot: string; leaves: DisclosureLeafCheck[] }
  | { state: "mismatch"; seq: string; root: string; writtenSlot: string; leaves: DisclosureLeafCheck[] }
  | { state: "superseded"; bundleSeq: string; chainSeq: string; leaves: DisclosureLeafCheck[] }
  | { state: "wrong_card"; leaves: DisclosureLeafCheck[] };

export async function recomputeDisclosedRoot(leaf: DisclosedLeaf): Promise<Uint8Array> {
  let acc = await leafHash(leaf.i, hexToBytes(leaf.leafSalt), hexToBytes(leaf.value));
  let idx = leaf.i;
  for (const sibling of leaf.proof) {
    const node = hexToBytes(sibling);
    acc = idx % 2 === 0 ? await nodeHash(acc, node) : await nodeHash(node, acc);
    idx >>= 1;
  }
  return acc;
}

/**
 * Check every disclosed field against the public commitment account. The
 * commitment holds only its latest root, so a record from an older checkpoint
 * is reported as superseded rather than guessed at.
 */
export async function verifyDisclosureBundle(bundle: DisclosureBundle, commitment: CardCommitment): Promise<DisclosureCheck> {
  const described = bundle.leaves.map((leaf) => ({ i: leaf.i, ok: false, field: describeCommitmentLeaf(leaf.i, hexToBytes(leaf.value)) }));
  if (new PublicKey(commitment.binding).toBase58() !== new PublicKey(bundle.binding).toBase58()) return { state: "wrong_card", leaves: described };
  const bindingLeaf = bundle.leaves.find((leaf) => leaf.i === 0);
  if (bindingLeaf && bindingLeaf.value !== bytesToHex(new PublicKey(bundle.binding).toBytes())) return { state: "wrong_card", leaves: described };
  if (commitment.seq.toString() !== bundle.commitmentSeq) {
    return { state: "superseded", bundleSeq: bundle.commitmentSeq, chainSeq: commitment.seq.toString(), leaves: described };
  }
  const root = bytesToHex(commitment.root);
  const leaves = await Promise.all(bundle.leaves.map(async (leaf, n) => ({ ...described[n], ok: bytesToHex(await recomputeDisclosedRoot(leaf)) === root })));
  const base = { seq: commitment.seq.toString(), root, writtenSlot: commitment.writtenSlot.toString(), leaves };
  return leaves.every((leaf) => leaf.ok) ? { state: "verified", ...base } : { state: "mismatch", ...base };
}

// --------------------------------------------------------------- display

export type CommitmentFieldView = { i: number; label: string; value: string; detail?: string };

export const COMMITMENT_FIELD_LABELS: Record<number, string> = {
  0: "Card",
  1: "Rules version",
  2: "Budget per period",
  3: "Max per purchase",
  4: "Purchases allowed per period",
  5: "Shop list fingerprint",
  6: "Category list fingerprint",
  7: "End date and fee",
  8: "Period",
  9: "Charged this period",
  10: "Held right now",
  11: "Refunded this period",
  12: "Purchases this period",
  13: "Owed on the statement",
  14: "Frozen",
  15: "Activity log position",
};

function readLe(bytes: Uint8Array, offset: number, size: 2 | 4 | 8, signed = false): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size === 2) return BigInt(view.getUint16(offset, true));
  if (size === 4) return BigInt(view.getUint32(offset, true));
  return signed ? view.getBigInt64(offset, true) : view.getBigUint64(offset, true);
}

function dateFromSeconds(seconds: bigint): string {
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : `unix ${seconds}`;
}

const EXPECTED_LENGTH: Record<number, number> = { 0: 32, 1: 4, 2: 8, 3: 8, 4: 2, 5: 32, 6: 32, 7: 11, 8: 20, 9: 8, 10: 8, 11: 8, 12: 2, 13: 8, 14: 2, 15: 40 };

/** Human-readable value for one leaf. Exact cents; malformed bytes say so instead of guessing. */
export function describeCommitmentLeaf(i: number, value: Uint8Array): CommitmentFieldView {
  const label = COMMITMENT_FIELD_LABELS[i] ?? `Field ${i}`;
  if (value.length !== EXPECTED_LENGTH[i]) return { i, label, value: "Unreadable value" };
  const cents = (offset = 0) => formatUsdCents(readLe(value, offset, 8));
  switch (i) {
    case 0: return { i, label, value: new PublicKey(value).toBase58() };
    case 1: return { i, label, value: `Version ${readLe(value, 0, 4)}` };
    case 2: case 3: case 9: case 10: case 11: case 13: return { i, label, value: cents() };
    case 4: { const n = readLe(value, 0, 2); return { i, label, value: n === 0n ? "No count limit" : n.toString() }; }
    case 12: return { i, label, value: readLe(value, 0, 2).toString() };
    case 5: case 6: return { i, label, value: bytesToHex(value).slice(0, 16), detail: bytesToHex(value) };
    case 7: {
      const end = readLe(value, 0, 8, true);
      const fee = Number(readLe(value, 9, 2));
      return { i, label, value: `${end === 0n ? "No end date" : `Ends ${dateFromSeconds(end)}`} · fee ${fee <= 1000 ? formatFeeBps(fee) : `${fee} bps`}`, detail: value[8] ? "Repeat charges allowed" : "No repeat charges" };
    }
    case 8: return { i, label, value: `Period ${readLe(value, 0, 4)}`, detail: `${dateFromSeconds(readLe(value, 4, 8, true))} to ${dateFromSeconds(readLe(value, 12, 8, true))}` };
    case 14: return { i, label, value: value[0] ? "Frozen" : "Not frozen", detail: ["Normal", "Frozen for recovery", "Restored, waiting for confirmation"][value[1]] ?? "Unknown recovery state" };
    case 15: return { i, label, value: `Event ${readLe(value, 32, 8)}`, detail: bytesToHex(value.slice(0, 32)) };
    default: return { i, label, value: bytesToHex(value) };
  }
}
