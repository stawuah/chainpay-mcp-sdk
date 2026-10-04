// End-to-end on a local validator: the real splitter program + the page's own
// transaction builder. Not part of `npm test` (needs the Solana CLI).
//
//   make splitter-test        # builds target/splitter-test/support_splitter.so with test keys
//   node frontend/test/support.e2e.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PROGRAM = "D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC = "http://127.0.0.1:8899";
const so = new URL("../../target/splitter-test/support_splitter.so", import.meta.url).pathname;

// Test-config keys (same seeds as the LiteSVM suite).
const A = Keypair.fromSeed(new Uint8Array(32).fill(11));
const B = Keypair.fromSeed(new Uint8Array(32).fill(22));
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(33));

const outfile = new URL("./.tmp-support-e2e.mjs", import.meta.url).pathname;
await build({
  entryPoints: [new URL("../src/support/donation.ts", import.meta.url).pathname],
  bundle: true,
  outfile,
  platform: "node",
  format: "esm",
  external: ["@solana/web3.js"],
  define: { "import.meta.env": "{}" },
});
const support = await import(outfile);
await rm(outfile);

const ledger = await mkdtemp(join(tmpdir(), "support-e2e-"));
const validator = spawn(
  "solana-test-validator",
  ["--reset", "--quiet", "--ledger", ledger, "--bpf-program", PROGRAM, so],
  { stdio: "ignore" },
);
const rpc = new Connection(RPC, "confirmed");

async function waitForValidator() {
  for (let i = 0; i < 60; i++) {
    try {
      await rpc.getLatestBlockhash();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("validator did not start");
}

const send = (ixs, signers) => sendAndConfirmTransaction(rpc, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const tokenBalance = async (address) => BigInt((await rpc.getTokenAccountBalance(address)).value.amount);
const createAta = (payer, owner) =>
  new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: support.associatedTokenAddress(owner, MINT.publicKey), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: MINT.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

try {
  await waitForValidator();
  const payer = Keypair.generate();
  const donor = Keypair.generate();
  for (const k of [payer, donor, A, B]) {
    await rpc.confirmTransaction(await rpc.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
  }

  // USDC stand-in mint at the pinned test address.
  const mintRent = await rpc.getMinimumBalanceForRentExemption(82);
  await send(
    [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: MINT.publicKey, lamports: mintRent, space: 82, programId: TOKEN }),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [{ pubkey: MINT.publicKey, isSigner: false, isWritable: true }],
        data: Buffer.concat([Buffer.from([20, 6]), payer.publicKey.toBuffer(), Buffer.from([0])]),
      }),
    ],
    [payer, MINT],
  );

  const accounts = support.supportAccounts(PROGRAM, MINT.publicKey.toBase58());
  await send(
    [
      new TransactionInstruction({
        programId: accounts.programId,
        keys: [
          { pubkey: A.publicKey, isSigner: true, isWritable: false },
          { pubkey: B.publicKey, isSigner: true, isWritable: false },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: accounts.vault, isSigner: false, isWritable: true },
          { pubkey: accounts.vaultUsdc, isSigner: false, isWritable: true },
          { pubkey: MINT.publicKey, isSigner: false, isWritable: false },
          { pubkey: TOKEN, isSigner: false, isWritable: false },
          { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: disc("initialize"),
      }),
    ],
    [payer, A, B],
  );
  console.log("✓ initialized with both recipients signing");

  // Donor gets 50 USDC.
  const donorAta = support.associatedTokenAddress(donor.publicKey, MINT.publicKey);
  await send(
    [
      createAta(payer.publicKey, donor.publicKey),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: MINT.publicKey, isSigner: false, isWritable: true },
          { pubkey: donorAta, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([7]), u64(50_000_000n)]),
      }),
    ],
    [payer],
  );

  // Contributions built exactly as the page builds them.
  await send(
    support.contributionInstructions({ donor: donor.publicKey, asset: "SOL", amount: 1_000_000_001n, note: "gm", hideAddress: false, accounts }),
    [donor],
  );
  await send(
    support.contributionInstructions({ donor: donor.publicKey, asset: "USDC", amount: 5_000_001n, note: "", hideAddress: true, accounts }),
    [donor],
  );
  let vault = support.decodeVault((await rpc.getAccountInfo(accounts.vault)).data);
  assert.deepEqual(vault.sol.owed, [500_000_000n, 500_000_000n]);
  assert.deepEqual(vault.usdc.owed, [2_500_000n, 2_500_000n]);
  console.log("✓ page-built contributions allocated 50/50 in the same transaction");

  // Payouts, pressed by a stranger (the donor). USDC creates each ATA if missing.
  const before = [await rpc.getBalance(A.publicKey), await rpc.getBalance(B.publicKey)];
  for (const side of [0, 1]) {
    const recipient = side === 0 ? A.publicKey : B.publicKey;
    await send(
      [
        ...support.payoutInstructions({ asset: "SOL", side, recipient, payer: donor.publicKey, accounts }),
        ...support.payoutInstructions({ asset: "USDC", side, recipient, payer: donor.publicKey, accounts }),
      ],
      [donor],
    );
  }
  assert.equal((await rpc.getBalance(A.publicKey)) - before[0], 500_000_000);
  assert.equal((await rpc.getBalance(B.publicKey)) - before[1], 500_000_000);
  assert.equal(await tokenBalance(support.associatedTokenAddress(A.publicKey, MINT.publicKey)), 2_500_000n);
  assert.equal(await tokenBalance(support.associatedTokenAddress(B.publicKey, MINT.publicKey)), 2_500_000n);
  assert.equal(await tokenBalance(accounts.vaultUsdc), 1n, "odd unit waits in the vault");
  console.log("✓ each side paid exactly half, independently");

  // Rent case the LiteSVM suite can't cover: A rotates to an empty wallet and
  // is owed less than rent-exempt minimum. Only A's payout may fail.
  const empty = Keypair.generate().publicKey;
  await send(
    [
      new TransactionInstruction({
        programId: accounts.programId,
        keys: [
          { pubkey: A.publicKey, isSigner: true, isWritable: false },
          { pubkey: accounts.vault, isSigner: false, isWritable: true },
          { pubkey: accounts.vaultUsdc, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("rotate_recipient"), Buffer.from([0]), empty.toBuffer()]),
      }),
    ],
    [A],
  );
  await send(support.contributionInstructions({ donor: donor.publicKey, asset: "SOL", amount: 1_000n, note: "", hideAddress: false, accounts }), [donor]);
  await assert.rejects(
    send(support.payoutInstructions({ asset: "SOL", side: 0, recipient: empty, payer: donor.publicKey, accounts }), [donor]),
    "tiny payout to an empty wallet must fail",
  );
  await send(support.payoutInstructions({ asset: "SOL", side: 1, recipient: B.publicKey, payer: donor.publicKey, accounts }), [donor]);
  vault = support.decodeVault((await rpc.getAccountInfo(accounts.vault)).data);
  assert.equal(vault.recipients[0], empty.toBase58());
  assert.deepEqual(vault.sol.owed, [500n, 0n]);
  console.log("✓ a payout A can't receive leaves A owed and doesn't block B");

  console.log("\nAll end-to-end checks passed.");
} finally {
  validator.kill();
  await rm(ledger, { recursive: true, force: true });
}
// web3.js keeps retrying its websocket after the validator stops.
process.exit(0);
