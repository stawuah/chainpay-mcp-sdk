// card_policy live integration on Solana Devnet + MagicBlock Devnet TEE (PER).
// Devnet only. Never prints auth tokens or secret keys.
//
// init_card -> escrow top-up -> delegate_card -> init_permission -> set_policy ->
// open intents -> authorize $20 (ok) -> authorize $40 (declined) -> second-wallet
// reads return null -> freeze -> authorize declined -> checkpoint lands on base.
//
// Run: cd programs/card_policy/scripts && npm i && npx tsx per-integration.ts
// Env: OWNER_KEYPAIR (default ~/.config/solana/id.json), OUT (result JSON path).
import * as anchor from "@coral-xyz/anchor";
import { web3, Program, BN } from "@coral-xyz/anchor";
import {
  getAuthToken,
  createTopUpEscrowInstruction,
  escrowPdaFromEscrowAuthority,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const idl = JSON.parse(readFileSync(new URL("../idl/card_policy.json", import.meta.url), "utf8"));
const BASE = "https://api.devnet.solana.com";
const TEE = "https://devnet-tee.magicblock.app";
const TEE_VALIDATOR = new web3.PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const OUT = process.env.OUT ?? new URL("./per-integration-result.json", import.meta.url).pathname;

const out: Record<string, unknown> = { ranAt: new Date().toISOString(), cluster: "devnet" };
const log = (k: string, v: unknown) => {
  out[k] = v;
  console.log(k, typeof v === "string" ? v : JSON.stringify(v));
};
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const owner = web3.Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(process.env.OWNER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`, "utf8")),
  ),
);
const authorizer = web3.Keypair.generate();
const stranger = web3.Keypair.generate();
const sign = (kp: web3.Keypair) => (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, kp.secretKey));

const base = new web3.Connection(BASE, "confirmed");
const program = new Program(idl, new anchor.AnchorProvider(base, new anchor.Wallet(owner), { commitment: "confirmed" }));
const PID = program.programId;
const pda = (...seeds: (Buffer | Uint8Array)[]) => web3.PublicKey.findProgramAddressSync(seeds, PID)[0];
const sha256 = (...parts: (Buffer | Uint8Array)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

const ERRORS: string[] = idl.errors.map((e: { name: string }) => e.name);
function errorName(err: unknown): string {
  const ie = (err as any)?.InstructionError;
  const code = ie?.[1]?.Custom;
  if (typeof code === "number" && code >= 6000) return ERRORS[code - 6000] ?? `custom ${code}`;
  return JSON.stringify(err);
}

async function erSend(conn: web3.Connection, signer: web3.Keypair, ix: web3.TransactionInstruction) {
  const tx = new web3.Transaction().add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  const st = await conn.getSignatureStatus(sig);
  return { sig, err: st.value?.err ? errorName(st.value.err) : null };
}

async function expectOk(label: string, p: Promise<{ sig: string; err: string | null }>) {
  const r = await p;
  log(label, r);
  if (r.err) throw new Error(`${label} failed: ${r.err}`);
  return r.sig;
}

async function expectErr(label: string, p: Promise<{ sig: string; err: string | null }>, want: string) {
  const r = await p;
  log(label, { ...r, expected: want, pass: r.err === want });
  if (r.err !== want) throw new Error(`${label}: expected ${want}, got ${r.err}`);
}

const decode = (name: string, data: Buffer) =>
  program.coder.accounts.decode(name[0].toLowerCase() + name.slice(1), data);

async function waitFor<T>(label: string, f: () => Promise<T | null | undefined>, tries = 40, ms = 1500): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---- commitment root (contracts.md §1.6 + changelog leaf encodings) ----
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: BN | bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n.toString())); return b; };
const i64 = (n: BN | bigint | number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n.toString())); return b; };

export function commitmentRoot(policy: any, period: any, masterSalt: Buffer): Buffer {
  const merchants = (policy.merchantIdHashes as number[][])
    .slice(0, policy.merchantCount)
    .map((m) => Buffer.from(m))
    .sort(Buffer.compare);
  const mccs = (policy.mccs as number[]).slice(0, policy.mccCount).sort((a, b) => a - b);
  const values: Buffer[] = [
    policy.binding.toBuffer(),
    u32(policy.policyVersion),
    u64(policy.budgetCents),
    u64(policy.maxPurchaseCents),
    u16(policy.maxPurchasesPerPeriod),
    sha256(...merchants),
    sha256(Buffer.concat(mccs.map(u16))),
    Buffer.concat([i64(policy.expiresAt), Buffer.from([policy.recurringAllowed ? 1 : 0]), u16(policy.feeBps)]),
    Buffer.concat([u32(period.periodIndex), i64(period.periodStart), i64(period.periodEnd)]),
    u64(period.capturedCents),
    u64(period.reservedCents),
    u64(period.refundedCents),
    u16(period.purchasesCount),
    u64(policy.statementOutstandingCents),
    Buffer.from([policy.frozen ? 1 : 0, policy.recoveryState]),
    Buffer.concat([Buffer.from(policy.ledgerHead), u64(policy.ledgerSeq)]),
  ];
  let level = values.map((v, i) =>
    sha256(Buffer.from("chainpay-card-leaf:v1\n"), Buffer.from([i]), sha256(masterSalt, Buffer.from([i])), v),
  );
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(Buffer.from([1]), level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

async function main() {
  log("programId", PID.toBase58());
  log("owner", owner.publicKey.toBase58());
  log("authorizer", authorizer.publicKey.toBase58());
  log("stranger", stranger.publicKey.toBase58());
  log("teeRpcIntegrity", await verifyTeeRpcIntegrity(TEE).then(() => "ok", (e) => `failed: ${e?.message ?? e}`));

  const cardId = randomBytes(32);
  const binding = pda(Buffer.from("card_binding"), owner.publicKey.toBuffer(), cardId);
  const policy = pda(Buffer.from("card_policy"), binding.toBuffer());
  const period = pda(Buffer.from("card_period"), binding.toBuffer());
  const commitment = pda(Buffer.from("card_commit"), binding.toBuffer());
  const escrow = escrowPdaFromEscrowAuthority(policy);
  log("accounts", {
    binding: binding.toBase58(), policy: policy.toBase58(), period: period.toBase58(),
    commitment: commitment.toBase58(), escrow: escrow.toBase58(),
  });

  // ---- base layer: fund authorizer, init card, top up the card's action escrow, delegate ----
  const fund = new web3.Transaction().add(
    web3.SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: authorizer.publicKey, lamports: 10_000_000 }),
  );
  log("fundAuthorizerSig", await program.provider.sendAndConfirm!(fund));

  const initSig = await program.methods
    .initCard([...cardId], 2, [...randomBytes(32)], new BN(5_000_000))
    .accountsPartial({ owner: owner.publicKey, binding, policy, period, commitment })
    .rpc();
  log("initCardSig", initSig);
  const topUp = new web3.Transaction().add(createTopUpEscrowInstruction(escrow, policy, owner.publicKey, 20_000_000));
  log("escrowTopUpSig", await program.provider.sendAndConfirm!(topUp));
  const policyBaseBefore = (await base.getAccountInfo(policy))!;

  const delegateSig = await program.methods
    .delegateCard(TEE_VALIDATOR)
    .accountsPartial({ owner: owner.publicKey, binding, policy, period })
    .rpc();
  log("delegateCardSig", delegateSig);
  const notAllowed = await program.methods
    .delegateCard(web3.Keypair.generate().publicKey)
    .accountsPartial({ owner: owner.publicKey, binding, policy, period })
    .rpc()
    .then(() => "UNEXPECTED SUCCESS", (e) => (String(e).includes("ValidatorNotAllowed") ? "ValidatorNotAllowed" : String(e).slice(0, 200)));
  log("delegateOtherValidator", notAllowed);

  // ---- PER sessions (each party uses its own token) ----
  const ownerTok = (await getAuthToken(TEE, owner.publicKey, sign(owner))).token;
  const authTok = (await getAuthToken(TEE, authorizer.publicKey, sign(authorizer))).token;
  const strangerTok = (await getAuthToken(TEE, stranger.publicKey, sign(stranger))).token;
  const erOwner = new web3.Connection(`${TEE}?token=${ownerTok}`, "confirmed");
  const erAuth = new web3.Connection(`${TEE}?token=${authTok}`, "confirmed");
  const erStranger = new web3.Connection(`${TEE}?token=${strangerTok}`, "confirmed");
  await waitFor("policy on PER", () => erOwner.getAccountInfo(policy));

  const permAccounts = {
    owner: owner.publicKey, policy, period,
    policyPermission: permissionPdaFromAccount(policy),
    periodPermission: permissionPdaFromAccount(period),
  };
  await expectOk("initPermission", erSend(erOwner, owner,
    await program.methods.initPermission(authorizer.publicKey).accountsPartial(permAccounts).instruction()));

  const merchant = sha256(Buffer.from("chainpay-merchant:v1\n"), Buffer.from("DEMO-DATAAPI"));
  const otherMerchant = sha256(Buffer.from("chainpay-merchant:v1\n"), Buffer.from("DEMO-UNAPPROVED-SHOP"));
  const policyArgs = {
    budgetCents: new BN(5_000), maxPurchaseCents: new BN(4_000), maxPurchasesPerPeriod: 0,
    periodSeconds: 30 * 86_400, currency: [...Buffer.from("USD")], merchantIdHashes: [[...merchant]],
    mccs: [], expiresAt: new BN(0), recurringAllowed: false, feeBps: 50, authorizer: authorizer.publicKey,
  };
  await expectOk("setPolicy", erSend(erOwner, owner,
    await program.methods.setPolicy(policyArgs).accountsPartial(permAccounts).instruction()));
  // The authorizer cannot loosen the policy.
  await expectErr("setPolicyByAuthorizer", erSend(erAuth, authorizer,
    await program.methods.setPolicy({ ...policyArgs, budgetCents: new BN(900_000) })
      .accountsPartial({ ...permAccounts, owner: authorizer.publicKey }).instruction()), "Unauthorized");

  // ---- intents + authorizations ----
  const nowSec = () => Math.floor(Date.now() / 1000);
  const openIntent = async (label: string, idByte: number, max: number, merchantHash = merchant) => {
    const intentId = Buffer.alloc(16, idByte);
    const intent = pda(Buffer.from("intent"), policy.toBuffer(), intentId);
    const ix = await program.methods.openCheckoutIntent({
      intentId: [...intentId], agent: web3.Keypair.generate().publicKey, merchantIdHash: [...merchantHash],
      mcc: 0, maxAmountCents: new BN(max), currency: [...Buffer.from("USD")], expiresAt: new BN(nowSec() + 540),
    }).accountsPartial({ authorizer: authorizer.publicKey, policy, period, intent, intentPermission: permissionPdaFromAccount(intent) })
      .instruction();
    return { intentId, intent, result: erSend(erAuth, authorizer, ix), label };
  };
  const authorizeIx = async (authId: Buffer, intentId: Buffer, amount: number) => {
    const intent = pda(Buffer.from("intent"), policy.toBuffer(), intentId);
    const reservation = pda(Buffer.from("res"), policy.toBuffer(), authId);
    const ix = await program.methods.authorize({
      authIdHash: [...authId], intentId: [...intentId], amountCents: new BN(amount), currency: [...Buffer.from("USD")],
      merchantIdHash: [...merchant], mcc: 5734, merchantInitiated: false, singleMessage: false,
    }).accountsPartial({ authorizer: authorizer.publicKey, policy, period, intent, reservation, reservationPermission: permissionPdaFromAccount(reservation) })
      .instruction();
    return { reservation, ix };
  };

  const a = await openIntent("openIntentA_20", 1, 2_000);
  await expectOk("openIntentA_20", a.result);
  const b = await openIntent("openIntentB_40", 2, 4_000);
  await expectOk("openIntentB_40", b.result);
  const off = await openIntent("openIntentUnapprovedMerchant", 9, 1_000, otherMerchant);
  await expectErr("openIntentUnapprovedMerchant", off.result, "MerchantNotAllowed");

  const authA = sha256(Buffer.from("chainpay-auth-id:v1\n"), Buffer.from([2]), randomBytes(16));
  const t0 = Date.now();
  const resA = await authorizeIx(authA, a.intentId, 2_000);
  await expectOk("authorize20", erSend(erAuth, authorizer, resA.ix));
  log("authorize20LatencyMs", Date.now() - t0);
  const authB = sha256(Buffer.from("chainpay-auth-id:v1\n"), Buffer.from([2]), randomBytes(16));
  const resB = await authorizeIx(authB, b.intentId, 4_000);
  await expectErr("authorize40", erSend(erAuth, authorizer, resB.ix), "BudgetExceeded");
  const replay = await authorizeIx(authA, b.intentId, 2_000);
  await expectErr("authorizeReplay", erSend(erAuth, authorizer, replay.ix), "DuplicateAuthorization");

  // ---- privacy: members see, a second wallet sees null (CD-4) ----
  const visible = async (conn: web3.Connection, key: web3.PublicKey) => {
    const info = await conn.getAccountInfo(key, "confirmed");
    return info ? "visible" : "null";
  };
  const reads: Record<string, Record<string, string>> = {};
  for (const [name, key] of Object.entries({ policy, period, intentA: a.intent, reservationA: resA.reservation })) {
    reads[name] = {
      owner: await visible(erOwner, key),
      authorizer: await visible(erAuth, key),
      stranger: await visible(erStranger, key),
      noToken: await visible(new web3.Connection(TEE, "confirmed"), key),
    };
  }
  log("perReads", reads);
  const resInfo = (await erAuth.getAccountInfo(resA.reservation))!;
  const res: any = decode("Reservation", resInfo.data);
  log("reservationA", { state: res.state, amountReservedCents: res.amountReservedCents.toString(), ownerProgram: resInfo.owner.toBase58() });
  const pol: any = decode("CardPolicy", (await erOwner.getAccountInfo(policy))!.data);
  const per: any = decode("CardPeriod", (await erOwner.getAccountInfo(period))!.data);
  log("perState", { policyVersion: pol.policyVersion, budgetCents: pol.budgetCents.toString(), reservedCents: per.reservedCents.toString(), purchases: per.purchasesCount });
  const txView = await erStranger.getTransaction(await (async () => (out.authorize20 as any).sig)(), { maxSupportedTransactionVersion: 0 }).catch(() => null);
  log("strangerTxView", txView ? { accountKeys: txView.transaction.message.staticAccountKeys.length, logs: txView.meta?.logMessages?.length ?? 0 } : null);

  // ---- base layer shows no policy bytes ----
  const policyBase = (await base.getAccountInfo(policy))!;
  const basePolicy: any = decode("CardPolicy", policyBase.data);
  log("basePolicySnapshot", {
    owner: policyBase.owner.toBase58(),
    bytesUnchangedSinceInit: Buffer.from(policyBase.data).equals(Buffer.from(policyBaseBefore.data)),
    budgetCents: basePolicy.budgetCents.toString(), authorizer: basePolicy.authorizer.toBase58(), memberCount: basePolicy.memberCount,
  });

  // ---- freeze, then decline ----
  const c = await openIntent("openIntentC_10", 3, 1_000);
  await expectOk("openIntentC_10", c.result);
  await expectOk("freezeByOwner", erSend(erOwner, owner,
    await program.methods.freeze(1).accountsPartial({ signer: owner.publicKey, policy, period }).instruction()));
  const authC = sha256(Buffer.from("chainpay-auth-id:v1\n"), Buffer.from([2]), randomBytes(16));
  const resC = await authorizeIx(authC, c.intentId, 1_000);
  await expectErr("authorizeWhileFrozen", erSend(erAuth, authorizer, resC.ix), "CardFrozen");
  await expectErr("unfreezeByAuthorizer", erSend(erAuth, authorizer,
    await program.methods.unfreeze().accountsPartial({ owner: authorizer.publicKey, policy, period }).instruction()), "Unauthorized");

  // ---- checkpoint: Magic Action writes the salted root on base ----
  const masterSalt = randomBytes(32);
  const t1 = Date.now();
  const cpSig = await expectOk("checkpointEr", erSend(erAuth, authorizer,
    await program.methods.checkpoint([...masterSalt], new BN(1))
      .accountsPartial({ authorizer: authorizer.publicKey, policy, period, binding, commitment }).instruction()));
  const polAfter: any = decode("CardPolicy", (await erOwner.getAccountInfo(policy))!.data);
  const perAfter: any = decode("CardPeriod", (await erOwner.getAccountInfo(period))!.data);
  const expected = commitmentRoot(polAfter, perAfter, masterSalt);
  const landed: any = await waitFor("base commitment seq 1", async () => {
    const cm: any = decode("CardCommitment", (await base.getAccountInfo(commitment))!.data);
    return cm.seq.toString() === "1" ? cm : null;
  });
  log("checkpointBaseLatencyMs", Date.now() - t1);
  const sigs = await base.getSignaturesForAddress(commitment, { limit: 5 });
  const actionSig = sigs.find((s) => s.signature !== initSig)?.signature ?? null;
  let actionKeys: string[] = [];
  if (actionSig) {
    const btx = await base.getTransaction(actionSig, { maxSupportedTransactionVersion: 0 });
    actionKeys = btx?.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58()) ?? [];
  }
  log("checkpointBase", {
    erSig: cpSig, baseActionSig: actionSig, seq: landed.seq.toString(),
    root: Buffer.from(landed.root).toString("hex"), matchesExpected: Buffer.from(landed.root).equals(expected),
    policyVersion: landed.policyVersion, periodIndex: landed.periodIndex,
    actionTxReferencesPolicy: actionKeys.includes(policy.toBase58()),
    actionTxReferencesPeriod: actionKeys.includes(period.toBase58()),
  });
  const policyBaseAfter = (await base.getAccountInfo(policy))!;
  log("basePolicyUnchangedAfterCheckpoint", Buffer.from(policyBaseAfter.data).equals(Buffer.from(policyBaseBefore.data)));
  const stale = await erSend(erAuth, authorizer,
    await program.methods.checkpoint([...masterSalt], new BN(1))
      .accountsPartial({ authorizer: authorizer.publicKey, policy, period, binding, commitment }).instruction());
  log("checkpointStaleSeq", { ...stale, pass: stale.err === "StaleCommitment" });
  out.pass = true;
}

main()
  .catch((e) => {
    console.error("FAILED", e?.message ?? e);
    out.fatal = String(e?.message ?? e);
    out.pass = false;
  })
  .finally(save);
