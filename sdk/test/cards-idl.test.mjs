/*
 * IDL-driven checks: every SDK card_policy builder must produce exactly the
 * accounts (order, address, writable, signer), discriminator and Borsh arg
 * layout the deployed program's IDL describes.
 *
 * The IDL is read from programs/card_policy/idl/card_policy.json when the
 * program crate is in this checkout, else from the vendored copy in
 * test/fixtures (dre/cards-program 677455c, Devnet deploy). Both must agree.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CARD_ACCOUNT_DISCRIMINATORS,
  CARD_POLICY_DISCRIMINATORS,
  CARD_POLICY_ERRORS,
  CARD_POLICY_PROGRAM_ID,
  DEVNET_TEE_VALIDATOR,
  buildCancelCheckoutIntentInstruction,
  buildCloseCardInstruction,
  buildCloseCheckoutIntentInstruction,
  buildConfirmReconciledInstruction,
  buildDelegateCardInstruction,
  buildFreezeInstruction,
  buildInitCardInstruction,
  buildInitPermissionInstruction,
  buildResolveExceptionInstruction,
  buildRestoreInstruction,
  buildSetPolicyInstruction,
  buildUnfreezeInstruction,
  buildUpdatePermissionInstruction,
  buildWipeCardInstruction,
  buildWriteCommitmentInstruction,
  deriveCardAccounts,
  deriveCheckoutIntentAddress,
  derivePermissionAddress,
  merchantIdHash,
} from "../dist/index.js";

const vendored = new URL("./fixtures/card_policy.idl.json", import.meta.url);
const inRepo = new URL("../../programs/card_policy/idl/card_policy.json", import.meta.url);
const IDL = JSON.parse(readFileSync(existsSync(inRepo) ? inRepo : vendored, "utf8"));
const PROGRAM = IDL.address;
const types = new Map(IDL.types.map((t) => [t.name, t.type]));
const camel = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const idlIx = (name) => {
  const found = IDL.instructions.find((ix) => ix.name === name);
  assert.ok(found, `IDL has no ${name}`);
  return found;
};

test("IDL copies agree and the SDK program id is the deployed one", () => {
  assert.equal(CARD_POLICY_PROGRAM_ID, "Cz9vYKFZFwx8Bqag95xZtw8dqUjS4k9AoyMh1pFo82F");
  assert.equal(PROGRAM, CARD_POLICY_PROGRAM_ID);
  if (existsSync(inRepo)) assert.deepEqual(JSON.parse(readFileSync(inRepo, "utf8")), JSON.parse(readFileSync(vendored, "utf8")), "refresh test/fixtures/card_policy.idl.json");
});

test("every IDL instruction discriminator matches the SDK", () => {
  for (const ix of IDL.instructions) {
    if (ix.name === "process_undelegation") continue; // emitted by the delegation macro, only the delegation program calls it
    const sdk = CARD_POLICY_DISCRIMINATORS[camel(ix.name)];
    assert.ok(sdk, `SDK is missing ${ix.name}`);
    assert.deepEqual(Array.from(sdk), ix.discriminator, ix.name);
  }
  assert.equal(Object.keys(CARD_POLICY_DISCRIMINATORS).length, IDL.instructions.length - 1, "SDK lists an instruction the IDL doesn't have");
});

test("account discriminators and error table match the IDL", () => {
  for (const account of IDL.accounts) {
    const key = account.name[0].toLowerCase() + account.name.slice(1);
    assert.deepEqual(Array.from(CARD_ACCOUNT_DISCRIMINATORS[key]), account.discriminator, account.name);
  }
  assert.deepEqual(
    Object.entries(CARD_POLICY_ERRORS).map(([code, name]) => [Number(code), name]),
    IDL.errors.map((e) => [e.code, e.name]),
  );
});

// ------------------------------------------------------------ IDL resolution

function resolveAccounts(ix, ctx) {
  const resolved = {};
  const missing = Symbol("missing");
  const seedBytes = (seed) => {
    if (seed.kind === "const") return Uint8Array.from(seed.value);
    if (seed.kind === "arg") {
      assert.ok(ctx.args[seed.path], `${ix.name}: test context lacks arg ${seed.path}`);
      return ctx.args[seed.path];
    }
    // account seeds: an account name ("policy") or a field of one ("policy.binding", "binding.card_id")
    if (ctx.fields[seed.path]) return ctx.fields[seed.path];
    const base = resolved[seed.path];
    return base ? new PublicKey(base).toBytes() : missing;
  };
  // Seeds may reference accounts listed later (the #[delegate] buffers seed on `policy`), so resolve in passes.
  for (let pass = 0; pass < ix.accounts.length + 1; pass += 1) {
    for (const account of ix.accounts) {
      if (resolved[account.name]) continue;
      // Accounts the IDL leaves unconstrained (signers, has_one-checked PDAs) come from the test context.
      let address = account.address ?? (account.pda ? undefined : ctx.accounts[account.name]);
      if (!address && account.pda) {
        const seeds = account.pda.seeds.map(seedBytes);
        let program = PROGRAM;
        if (account.pda.program?.kind === "const") program = new PublicKey(Uint8Array.from(account.pda.program.value)).toBase58();
        if (account.pda.program?.kind === "account") program = resolved[account.pda.program.path];
        if (program && !seeds.includes(missing)) address = PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
      }
      if (address) resolved[account.name] = address;
    }
  }
  for (const account of ix.accounts) assert.ok(resolved[account.name], `${ix.name}: can't resolve account ${account.name}`);
  return ix.accounts.map((account) => ({
    name: account.name,
    address: resolved[account.name],
    isWritable: Boolean(account.writable),
    isSigner: Boolean(account.signer),
  }));
}

function assertMatchesIdl(name, built, ctx, { remaining = 0 } = {}) {
  const ix = idlIx(name);
  assert.equal(built.programId, PROGRAM, `${name} program`);
  assert.deepEqual(Array.from(built.data.slice(0, 8)), ix.discriminator, `${name} discriminator`);
  const expected = resolveAccounts(ix, ctx);
  assert.equal(built.keys.length, expected.length + remaining, `${name} account count`);
  expected.forEach((want, i) => {
    const got = built.keys[i];
    assert.deepEqual({ name: want.name, address: got.address, isWritable: got.isWritable, isSigner: got.isSigner }, want, `${name} account #${i} (${want.name})`);
  });
  const args = decodeArgs(ix.args, built.data);
  return args;
}

// ------------------------------------------------- minimal IDL Borsh decoder

function decodeArgs(fields, data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  const read = (type) => {
    if (typeof type === "string") {
      switch (type) {
        case "u8": return view.getUint8(offset++);
        case "bool": { const b = view.getUint8(offset++); assert.ok(b <= 1, "bool byte"); return b === 1; }
        case "u16": { const v = view.getUint16(offset, true); offset += 2; return v; }
        case "u32": { const v = view.getUint32(offset, true); offset += 4; return v; }
        case "u64": { const v = view.getBigUint64(offset, true); offset += 8; return v; }
        case "i64": { const v = view.getBigInt64(offset, true); offset += 8; return v; }
        case "pubkey": { const v = new PublicKey(data.slice(offset, offset + 32)).toBase58(); offset += 32; return v; }
        case "bytes": { const n = view.getUint32(offset, true); offset += 4; const v = data.slice(offset, offset + n); offset += n; return v; }
        default: throw new Error(`unsupported IDL type ${type}`);
      }
    }
    if (type.array) {
      const [inner, length] = type.array;
      if (inner === "u8") { const v = data.slice(offset, offset + length); offset += length; return v; }
      return Array.from({ length }, () => read(inner));
    }
    if (type.vec) return Array.from({ length: read("u32") }, () => read(type.vec));
    if (type.option) return read("u8") ? read(type.option) : null;
    if (type.defined) {
      const def = types.get(type.defined.name);
      if (def.kind === "struct") return Object.fromEntries(def.fields.map((f) => [f.name, read(f.type)]));
      if (def.kind === "enum") {
        const variant = def.variants[read("u8")];
        assert.ok(variant, `${type.defined.name} variant`);
        return { [variant.name]: Object.fromEntries((variant.fields ?? []).map((f) => [f.name, read(f.type)])) };
      }
    }
    throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
  };
  const out = Object.fromEntries(fields.map((f) => [f.name, read(f.type)]));
  assert.equal(offset, data.length, "args consume the whole instruction data");
  return out;
}

// ---------------------------------------------------------------- builders

const owner = Keypair.generate().publicKey.toBase58();
const authorizer = Keypair.generate().publicKey.toBase58();
const reader = Keypair.generate().publicKey.toBase58();
const cardId = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const intentId = Uint8Array.from({ length: 16 }, (_, i) => 200 - i);
const a = deriveCardAccounts(owner, cardId, PROGRAM);
const ctx = (extra = {}) => ({
  accounts: { owner, signer: owner, authorizer, policy: a.policy, period: a.period, ...extra.accounts },
  fields: { "policy.binding": new PublicKey(a.binding).toBytes(), "binding.card_id": cardId, "intent.intent_id": intentId, "binding.owner": new PublicKey(owner).toBytes() },
  args: { card_id: cardId, "args.intent_id": intentId, ...extra.args },
});

async function policyArgs() {
  return {
    budgetCents: 50_000n,
    maxPurchaseCents: 4_000n,
    maxPurchasesPerPeriod: 10,
    periodSeconds: 2_592_000,
    currency: "USD",
    merchantIdHashes: [await merchantIdHash("DEMO-DATAAPI")],
    mccs: [5734],
    expiresAt: 0n,
    recurringAllowed: false,
    feeBps: 50,
    authorizer,
  };
}

test("init_card and delegate_card (incl. #[delegate] macro accounts) match the IDL", () => {
  const args = assertMatchesIdl("init_card", buildInitCardInstruction({ owner, cardId, issuer: 1, issuerCardRefHash: new Uint8Array(32).fill(7), prefundLamports: 5_000_000n }, PROGRAM), ctx());
  assert.deepEqual(args.card_id, cardId);
  assert.equal(args.prefund_lamports, 5_000_000n);
  const delegated = assertMatchesIdl("delegate_card", buildDelegateCardInstruction({ owner, cardId, validator: DEVNET_TEE_VALIDATOR }, PROGRAM), ctx());
  assert.equal(delegated.validator, DEVNET_TEE_VALIDATOR);
});

test("permission and policy builders match the IDL", async () => {
  assert.equal(assertMatchesIdl("init_permission", buildInitPermissionInstruction({ owner, cardId, authorizer }, PROGRAM), ctx()).authorizer, authorizer);
  const policy = await policyArgs();
  const set = assertMatchesIdl("set_policy", buildSetPolicyInstruction({ owner, cardId, policy }, PROGRAM), ctx());
  assert.equal(set.args.max_purchase_cents, 4_000n);
  assert.deepEqual(set.args.merchant_id_hashes, policy.merchantIdHashes);
  assert.deepEqual(set.args.mccs, [5734]);
  assert.equal(set.args.authorizer, authorizer);

  const add = assertMatchesIdl("update_permission", buildUpdatePermissionInstruction({ owner, cardId, op: { kind: "add_reader", pubkey: reader } }, PROGRAM), ctx());
  assert.deepEqual(add.op, { AddReader: { pubkey: reader } });
  const intent = deriveCheckoutIntentAddress(a.policy, intentId, PROGRAM);
  const remove = buildUpdatePermissionInstruction({ owner, cardId, op: { kind: "remove_reader", pubkey: reader }, ephemeralAccounts: [intent] }, PROGRAM);
  assert.deepEqual(assertMatchesIdl("update_permission", remove, ctx(), { remaining: 2 }).op, { RemoveReader: { pubkey: reader } });
  assert.deepEqual(remove.keys.slice(-2).map((k) => [k.address, k.isWritable, k.isSigner]), [[intent, true, false], [derivePermissionAddress(intent), true, false]]);
});

test("owner event builders match the IDL", () => {
  assertMatchesIdl("unfreeze", buildUnfreezeInstruction({ owner, cardId }, PROGRAM), ctx());
  assert.equal(assertMatchesIdl("freeze", buildFreezeInstruction({ owner, cardId }, PROGRAM), ctx()).reason, 1);
  const resolved = assertMatchesIdl("resolve_exception", buildResolveExceptionInstruction({ owner, cardId, eventIdHash: new Uint8Array(32).fill(9), resolution: 1 }, PROGRAM), ctx());
  assert.equal(resolved.resolution, 1);
  assertMatchesIdl("confirm_reconciled", buildConfirmReconciledInstruction({ owner, cardId, reconDigest: new Uint8Array(32).fill(3) }, PROGRAM), ctx());
  assertMatchesIdl("close_card", buildCloseCardInstruction({ owner, cardId }, PROGRAM), ctx());
});

test("restore is co-signed and carries exception_cents in IDL order", async () => {
  const restore = {
    policy: await policyArgs(),
    periodIndex: 4,
    capturedCents: 1_200n,
    reservedCents: 300n,
    refundedCents: 50n,
    purchasesCount: 2,
    exceptionCents: 77n,
    statementOutstandingCents: 1_500n,
    ledgerHead: new Uint8Array(32).fill(5),
    ledgerSeq: 19n,
    reconDigest: new Uint8Array(32).fill(6),
  };
  const args = assertMatchesIdl("restore", buildRestoreInstruction({ owner, cardId, authorizer, restore }, PROGRAM), ctx());
  assert.equal(args.args.exception_cents, 77n);
  assert.equal(args.args.statement_outstanding_cents, 1_500n);
  assert.equal(args.args.ledger_seq, 19n);
  assert.throws(() => buildRestoreInstruction({ owner, cardId, authorizer: owner, restore }, PROGRAM), /can't be the owner/);
});

test("checkout intent builders match the IDL", () => {
  const extra = { accounts: { intent: deriveCheckoutIntentAddress(a.policy, intentId, PROGRAM) } };
  assertMatchesIdl("cancel_checkout_intent", buildCancelCheckoutIntentInstruction({ owner, cardId, intentId }, PROGRAM), ctx(extra));
  assertMatchesIdl("close_checkout_intent", buildCloseCheckoutIntentInstruction({ owner, cardId, intentId }, PROGRAM), ctx(extra));
});

test("wipe_card and write_commitment match the IDL", () => {
  const intent = deriveCheckoutIntentAddress(a.policy, intentId, PROGRAM);
  assertMatchesIdl("wipe_card", buildWipeCardInstruction({ owner, cardId, ephemeralAccounts: [intent] }, PROGRAM), ctx(), { remaining: 2 });
  const args = assertMatchesIdl(
    "write_commitment",
    buildWriteCommitmentInstruction({ owner, cardId, root: new Uint8Array(32).fill(1), seq: 3n, policyVersion: 2, periodIndex: 1 }, PROGRAM),
    ctx({ accounts: { escrow_auth: a.policy, escrow: a.escrow } }),
  );
  assert.equal(args.seq, 3n);
});
