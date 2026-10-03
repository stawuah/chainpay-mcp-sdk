import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CARD_SANDBOX_MERCHANTS,
  buildDisclosureBundle,
  cardDraftDigest,
  commitmentRoot,
  decodeDisclosureFragment,
  describeCommitmentLeaf,
  encodeCardDraftLink,
  encodeCardDraftReviewLink,
  encodeDisclosureFragment,
  merchantIdHash,
  merchantIdHashesForRefs,
  normalizeCardDraft,
  verifyCardDraftFragment,
  verifyDisclosureBundle,
} from "../dist/index.js";

const key = () => Keypair.generate().publicKey.toBase58();
const bytes = (n, fill) => new Uint8Array(n).fill(fill);
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

function fixture() {
  const binding = key();
  const policy = {
    binding, owner: key(), authorizer: key(), policyVersion: 3,
    budgetCents: 50_000n, maxPurchaseCents: 3_000n, maxPurchasesPerPeriod: 10, periodSeconds: 2_592_000,
    currency: "USD", merchantIdHashes: [bytes(32, 8), bytes(32, 7)], mccs: [5734, 5045],
    expiresAt: 1_790_000_000n, recurringAllowed: true, feeBps: 50, frozen: false, freezeReason: "none",
    recoveryState: "normal", statementOutstandingCents: 1_206n, exceptionsOpen: 0,
    members: [], ledgerHead: bytes(32, 9), ledgerSeq: 41n, commitSeq: 4n, bump: 254,
  };
  const period = { policy: key(), periodIndex: 2, periodStart: 1_759_000_000n, periodEnd: 1_761_592_000n, capturedCents: 2_000n, reservedCents: 500n, refundedCents: 100n, purchasesCount: 3, exceptionCents: 0n, bump: 253 };
  return { policy, period, salt: bytes(32, 42) };
}

/** Independent re-implementation of programs/card_policy/scripts/per-integration.ts commitmentRoot. */
function referenceRoot(policy, period, masterSalt) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
  const merchants = policy.merchantIdHashes.map((m) => Buffer.from(m)).sort(Buffer.compare);
  const mccs = [...policy.mccs].sort((a, b) => a - b);
  const values = [
    new PublicKey(policy.binding).toBuffer(), u32(policy.policyVersion), u64(policy.budgetCents), u64(policy.maxPurchaseCents),
    u16(policy.maxPurchasesPerPeriod), sha(...merchants), sha(Buffer.concat(mccs.map(u16))),
    Buffer.concat([i64(policy.expiresAt), Buffer.from([policy.recurringAllowed ? 1 : 0]), u16(policy.feeBps)]),
    Buffer.concat([u32(period.periodIndex), i64(period.periodStart), i64(period.periodEnd)]),
    u64(period.capturedCents), u64(period.reservedCents), u64(period.refundedCents), u16(period.purchasesCount),
    u64(policy.statementOutstandingCents), Buffer.from([policy.frozen ? 1 : 0, 0]),
    Buffer.concat([Buffer.from(policy.ledgerHead), u64(policy.ledgerSeq)]),
  ];
  let level = values.map((v, i) => sha(Buffer.from("chainpay-card-leaf:v1\n"), Buffer.from([i]), sha(masterSalt, Buffer.from([i])), v));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(Buffer.from([1]), level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

test("commitment root matches the program's leaf layout (independent recomputation)", async () => {
  const { policy, period, salt } = fixture();
  const root = await commitmentRoot(policy, period, salt);
  assert.equal(Buffer.from(root).toString("hex"), referenceRoot(policy, period, salt).toString("hex"));
});

test("a disclosure verifies field by field against the on-chain root, and only what was picked travels", async () => {
  const { policy, period, salt } = fixture();
  const root = await commitmentRoot(policy, period, salt);
  const commitment = { binding: policy.binding, seq: 5n, root, policyVersion: 3, periodIndex: 2, writtenSlot: 400_000_123n, bump: 255 };
  const bundle = await buildDisclosureBundle({ policy, period, masterSalt: salt, commitmentSeq: 5n, indices: [9, 2] });
  assert.deepEqual(bundle.leaves.map((leaf) => leaf.i), [2, 9]);
  assert.ok(!JSON.stringify(bundle).includes(Buffer.from(salt).toString("hex")), "master salt never leaves the owner");
  const decoded = decodeDisclosureFragment(`#${encodeDisclosureFragment(bundle)}`);
  assert.deepEqual(decoded, bundle);
  const check = await verifyDisclosureBundle(decoded, commitment);
  assert.equal(check.state, "verified");
  assert.deepEqual(check.leaves.map((leaf) => [leaf.field.label, leaf.field.value, leaf.ok]), [
    ["Budget per period", "$500.00", true],
    ["Charged this period", "$20.00", true],
  ]);

  // A changed value fails; a newer checkpoint is reported, not guessed; another card is refused.
  const tampered = { ...decoded, leaves: decoded.leaves.map((leaf) => leaf.i === 2 ? { ...leaf, value: Buffer.from(new BigUint64Array([90_000n]).buffer).toString("hex") } : leaf) };
  const bad = await verifyDisclosureBundle(tampered, commitment);
  assert.equal(bad.state, "mismatch");
  assert.deepEqual(bad.leaves.map((leaf) => leaf.ok), [false, true]);
  assert.equal((await verifyDisclosureBundle(decoded, { ...commitment, seq: 6n })).state, "superseded");
  assert.equal((await verifyDisclosureBundle(decoded, { ...commitment, binding: key() })).state, "wrong_card");
});

test("disclosure fragments reject unknown shapes", () => {
  assert.throws(() => decodeDisclosureFragment("#nothing=1"), /No shared card record/);
  const evil = Buffer.from(JSON.stringify({ v: 1, binding: key(), commitmentSeq: "1", leaves: [{ i: 99, value: "", leafSalt: "00".repeat(32), proof: [] }] })).toString("base64url");
  assert.throws(() => decodeDisclosureFragment(`#disclose=${evil}`), /unknown field/);
});

test("leaf descriptions use exact cents and plain words", () => {
  const cents = Buffer.alloc(8); cents.writeBigUInt64LE(50_250n);
  assert.equal(describeCommitmentLeaf(13, cents).value, "$502.50");
  assert.equal(describeCommitmentLeaf(14, Uint8Array.of(1, 1)).value, "Frozen");
  assert.equal(describeCommitmentLeaf(2, Uint8Array.of(1)).value, "Unreadable value");
});

test("draft intake: only a link whose digest matches is usable", async () => {
  const draft = normalizeCardDraft({ label: "Data API credits", budgetCents: "50000", maxPurchaseCents: "3000", merchants: ["demo-approved"], periodDays: 30 });
  const digest = await cardDraftDigest(draft);
  const link = await encodeCardDraftReviewLink(draft, "https://app.example");
  assert.ok(link.endsWith(`&digest=${digest}`));
  const fragment = link.slice(link.indexOf("#"));
  assert.deepEqual(await verifyCardDraftFragment(fragment), { status: "matched", draft, digest });
  const bare = encodeCardDraftLink(draft, "https://app.example");
  assert.equal((await verifyCardDraftFragment(bare.slice(bare.indexOf("#")))).status, "missing_digest");
  const other = normalizeCardDraft({ ...draft, budgetCents: "90000" });
  const swapped = `${encodeCardDraftLink(other, "https://app.example").split("#")[1]}&digest=${digest}`;
  const result = await verifyCardDraftFragment(`#${swapped}`);
  assert.equal(result.status, "mismatch");
  assert.ok(!("draft" in result), "a mismatched draft is never handed back");
  assert.equal((await verifyCardDraftFragment("#draft=@@@")).status, "invalid");
});

test("sandbox shops hash to the merchant allowlist the program checks", async () => {
  const [hash] = await merchantIdHashesForRefs(["demo-approved"]);
  assert.deepEqual(hash, await merchantIdHash(CARD_SANDBOX_MERCHANTS[0].acceptorId));
  await assert.rejects(() => merchantIdHashesForRefs(["nope"]), /isn't a registered shop/);
});
