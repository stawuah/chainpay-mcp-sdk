import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID,
  DELIVERY_CANONICAL_FIXTURE_JSON,
  DELIVERY_CANONICAL_FIXTURE_SIGNATURE,
  DELIVERY_FIXTURE_RECEIPT_ADDRESS,
  DELIVERY_FIXTURE_SELLER_ADDRESS,
  DELIVERY_FIXTURE_SELLER_SEED,
  DELIVERY_HASH_FIXTURE_SHA256,
  DELIVERY_HASH_FIXTURE_UTF8,
  canonicalDeliveryPayload,
  defaultTrustedSellerMapping,
  parseDeliveryPayload,
  sha256HexBytes,
  signDeliveryAttestation,
  verifyDeliveryAttestation,
} from "../dist/index.js";

function fixturePayload(overrides = {}) {
  return {
    version: 1,
    statement: "chainpay.response-served",
    cluster: "devnet",
    programId: DEFAULT_PROGRAM_ID,
    receiptAddress: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
    seller: DELIVERY_FIXTURE_SELLER_ADDRESS,
    contentHash: DELIVERY_HASH_FIXTURE_SHA256,
    servedAt: "2026-09-15T04:16:00.000Z",
    ...overrides,
  };
}

test("hashes unicode and whitespace response bytes exactly", async () => {
  const bytes = new TextEncoder().encode(DELIVERY_HASH_FIXTURE_UTF8);
  assert.equal(bytes.length, 30);
  assert.equal(bytes[25], 0xc3);
  assert.equal(bytes[26], 0xa9);
  assert.equal(bytes[27], 10);
  assert.equal(bytes[28], 9);
  assert.equal(bytes[29], 32);
  assert.equal(await sha256HexBytes(bytes), DELIVERY_HASH_FIXTURE_SHA256);
});

test("canonicalizes the cross-language delivery payload in fixed field order", () => {
  const canonical = canonicalDeliveryPayload(fixturePayload());
  assert.equal(canonical, DELIVERY_CANONICAL_FIXTURE_JSON);
  assert.equal(
    Buffer.from(canonical, "utf8").toString("hex"),
    Buffer.from(DELIVERY_CANONICAL_FIXTURE_JSON, "utf8").toString("hex"),
  );
  const parsed = JSON.parse(canonical);
  assert.deepEqual(Object.keys(parsed), [
    "version",
    "statement",
    "cluster",
    "programId",
    "receiptAddress",
    "seller",
    "contentHash",
    "servedAt",
  ]);
});

test("rejects unsupported version before canonicalization", () => {
  assert.throws(
    () => parseDeliveryPayload({
      version: 2,
      extra: true,
      statement: "chainpay.response-served",
      cluster: "devnet",
      programId: "not-a-valid-address",
      receiptAddress: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
      seller: DELIVERY_FIXTURE_SELLER_ADDRESS,
      contentHash: DELIVERY_HASH_FIXTURE_SHA256,
      servedAt: "2026-09-15T04:16:00.000Z",
    }),
    /Unsupported delivery attestation version/,
  );
});

test("rejects unknown fields before canonicalization", () => {
  assert.throws(
    () => parseDeliveryPayload({
      ...fixturePayload(),
      extra: true,
      programId: "not-a-valid-address",
    }),
    /Unknown delivery attestation field: extra/,
  );
});

test("signs and verifies a trusted seller statement", async () => {
  const seller = Keypair.fromSeed(Buffer.from(DELIVERY_FIXTURE_SELLER_SEED));
  assert.equal(seller.publicKey.toBase58(), DELIVERY_FIXTURE_SELLER_ADDRESS);
  const envelope = await signDeliveryAttestation(fixturePayload(), seller.secretKey);
  assert.equal(envelope.signature, DELIVERY_CANONICAL_FIXTURE_SIGNATURE);
  assert.match(envelope.signature, /^[A-Za-z0-9+/]+={0,2}$/);
  const verified = await verifyDeliveryAttestation(envelope, {
    trustedSellers: defaultTrustedSellerMapping([DELIVERY_FIXTURE_SELLER_ADDRESS]),
    receipt: {
      address: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
      recipientTokenAccount: Keypair.generate().publicKey.toBase58(),
    },
    now: new Date("2026-09-15T04:16:00.000Z"),
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.payload.statement, "chainpay.response-served");
});

test("refuses to verify without a trusted seller mapping", async () => {
  // Without a mapping the only remaining check is that the payload is signed by
  // the key the payload itself names, which any anonymous poster satisfies with
  // a throwaway keypair. A caller who forgets the mapping must get a refusal,
  // not a self-signed statement stamped valid for someone else's receipt.
  const impostor = Keypair.generate();
  const forged = await signDeliveryAttestation(
    fixturePayload({ seller: impostor.publicKey.toBase58() }),
    impostor.secretKey,
  );

  const unbound = await verifyDeliveryAttestation(forged);
  assert.equal(unbound.valid, false);
  assert.equal(unbound.code, "unknown_seller");

  // Supplying the other bindings without a mapping is still not enough.
  const stillUnbound = await verifyDeliveryAttestation(forged, {
    programId: DEFAULT_PROGRAM_ID,
    receipt: {
      address: DELIVERY_FIXTURE_RECEIPT_ADDRESS,
      recipientTokenAccount: Keypair.generate().publicKey.toBase58(),
    },
  });
  assert.equal(stillUnbound.valid, false);
  assert.equal(stillUnbound.code, "unknown_seller");
});

test("rejects invalid signature, hash format, and unknown sellers", async () => {
  const seller = Keypair.fromSeed(Buffer.from(DELIVERY_FIXTURE_SELLER_SEED));
  const envelope = await signDeliveryAttestation(fixturePayload(), seller.secretKey);
  const tampered = { ...envelope, signature: `A${envelope.signature.slice(1)}` };
  const badSignature = await verifyDeliveryAttestation(tampered, {
    trustedSellers: defaultTrustedSellerMapping([DELIVERY_FIXTURE_SELLER_ADDRESS]),
  });
  assert.equal(badSignature.valid, false);
  assert.match(badSignature.reason, /signature/i);

  const uppercaseHash = await verifyDeliveryAttestation({
    payload: fixturePayload({ contentHash: DELIVERY_HASH_FIXTURE_SHA256.toUpperCase() }),
    signature: envelope.signature,
  });
  assert.equal(uppercaseHash.valid, false);
  assert.match(uppercaseHash.reason, /contentHash/);

  const unknownSeller = await verifyDeliveryAttestation(envelope, {
    trustedSellers: defaultTrustedSellerMapping([Keypair.generate().publicKey.toBase58()]),
  });
  assert.equal(unknownSeller.valid, false);
  assert.equal(unknownSeller.code, "unknown_seller");

  const recipientAta = Keypair.generate().publicKey.toBase58();
  const mappedAsAta = await verifyDeliveryAttestation(envelope, {
    trustedSellers: {
      cluster: "devnet",
      programId: DEFAULT_PROGRAM_ID,
      sellers: [recipientAta],
      recipientTokenAccount: recipientAta,
    },
    receipt: { address: DELIVERY_FIXTURE_RECEIPT_ADDRESS, recipientTokenAccount: recipientAta },
  });
  assert.equal(mappedAsAta.valid, false);
  assert.equal(mappedAsAta.code, "unknown_seller");
});

test("rejects far-future servedAt and non-canonical timestamps", async () => {
  const seller = Keypair.fromSeed(Buffer.from(DELIVERY_FIXTURE_SELLER_SEED));
  const future = await signDeliveryAttestation(
    fixturePayload({ servedAt: "2099-01-01T00:00:00.000Z" }),
    seller.secretKey,
  );
  const farFuture = await verifyDeliveryAttestation(future, {
    trustedSellers: defaultTrustedSellerMapping([DELIVERY_FIXTURE_SELLER_ADDRESS]),
    now: new Date("2026-09-15T04:16:00.000Z"),
  });
  assert.equal(farFuture.valid, false);
  assert.equal(farFuture.code, "invalid_timestamp");

  const offsetIso = await verifyDeliveryAttestation({
    payload: fixturePayload({ servedAt: "2026-09-15T04:16:00+00:00" }),
    signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  });
  assert.equal(offsetIso.valid, false);
  assert.match(offsetIso.reason, /servedAt/);
});
