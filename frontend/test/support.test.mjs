import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { build } from "esbuild";

// Bundled next to this file (gitignored) so @solana/web3.js resolves from node_modules.
const outfile = new URL("./.tmp-support.mjs", import.meta.url).pathname;
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
const { PublicKey, SystemProgram } = await import("@solana/web3.js");

const PROGRAM = "D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const donor = new PublicKey("7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9");
const accounts = support.supportAccounts(PROGRAM, USDC);

const discriminator = (name) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];

test("amounts parse to exact base units and reject anything ambiguous", () => {
  assert.equal(support.toBaseUnits("0.1", 9), 100_000_000n);
  assert.equal(support.toBaseUnits("25", 6), 25_000_000n);
  assert.equal(support.toBaseUnits("0.000001", 6), 1n);
  for (const bad of ["", "0", "0.0", "-1", "1e3", "1.2345678", "1,000", " . ", "18446744073709.551616"]) {
    assert.equal(support.toBaseUnits(bad, 6), null, bad);
  }
  assert.equal(support.formatUnits(1_234_500_000n, 9), "1.2345");
  assert.equal(support.formatUnits(0n, 6), "0");
});

test("memo is bounded, plain text, and carries the hide flag", () => {
  assert.equal(support.buildMemo("", false), "chainpay-support:v1");
  assert.equal(support.buildMemo("  gm\u0007 \n world ", true), "chainpay-support:v1 anon=1 note=gm world");
  const long = support.buildMemo("x".repeat(200), false);
  assert.equal(long, `chainpay-support:v1 note=${"x".repeat(80)}`);
});

test("vault and vault USDC account match the program's PDA + canonical ATA", () => {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey(PROGRAM));
  assert.equal(accounts.vault.toBase58(), vault.toBase58());
  assert.equal(accounts.vaultUsdc.toBase58(), support.associatedTokenAddress(vault, new PublicKey(USDC)).toBase58());
});

test("a SOL contribution is exactly transfer → memo → allocate_sol", () => {
  const ixs = support.contributionInstructions({ donor, asset: "SOL", amount: 100_000_000n, note: "hi", hideAddress: false, accounts });
  assert.equal(ixs.length, 3);
  assert.equal(ixs[0].programId.toBase58(), SystemProgram.programId.toBase58());
  assert.equal(ixs[0].keys[1].pubkey.toBase58(), accounts.vault.toBase58());
  assert.equal(ixs[0].data.readBigUInt64LE(4), 100_000_000n);
  assert.equal(ixs[1].programId.toBase58(), MEMO);
  assert.equal(Buffer.from(ixs[1].data).toString(), "chainpay-support:v1 note=hi");
  assert.equal(ixs[2].programId.toBase58(), PROGRAM);
  assert.deepEqual([...ixs[2].data], discriminator("allocate_sol"));
  assert.deepEqual(ixs[2].keys.map((k) => [k.pubkey.toBase58(), k.isWritable]), [[accounts.vault.toBase58(), true]]);
});

test("a USDC contribution uses transferChecked into the vault ATA, then allocate_usdc", () => {
  const ixs = support.contributionInstructions({ donor, asset: "USDC", amount: 5_000_000n, note: "", hideAddress: true, accounts });
  assert.equal(ixs[0].programId.toBase58(), TOKEN);
  assert.equal(ixs[0].data[0], 12);
  assert.equal(ixs[0].data.readBigUInt64LE(1), 5_000_000n);
  assert.equal(ixs[0].data[9], 6);
  assert.equal(ixs[0].keys[0].pubkey.toBase58(), support.associatedTokenAddress(donor, new PublicKey(USDC)).toBase58());
  assert.equal(ixs[0].keys[2].pubkey.toBase58(), accounts.vaultUsdc.toBase58());
  assert.equal(ixs[0].keys[3].pubkey.toBase58(), donor.toBase58());
  assert.equal(Buffer.from(ixs[1].data).toString(), "chainpay-support:v1 anon=1");
  assert.deepEqual([...ixs[2].data], discriminator("allocate_usdc"));
});

test("payout instructions carry the side and pay only to the recipient", () => {
  const recipient = new PublicKey("6TcyBfPdBt1kjsvDZLzmBFnuMaLWiTaAt4RjUr9VA5YD");
  const [sol] = support.payoutInstructions({ asset: "SOL", side: 1, recipient, payer: donor, accounts });
  assert.deepEqual([...sol.data], [...discriminator("pay_sol"), 1]);
  assert.equal(sol.keys[1].pubkey.toBase58(), recipient.toBase58());
  const usdc = support.payoutInstructions({ asset: "USDC", side: 0, recipient, payer: donor, accounts });
  assert.equal(usdc.length, 2, "idempotent ATA create, then pay");
  assert.deepEqual([...usdc[1].data], [...discriminator("pay_usdc"), 0]);
  assert.equal(usdc[1].keys[2].pubkey.toBase58(), support.associatedTokenAddress(recipient, new PublicKey(USDC)).toBase58());
});

test("decodes the Vault account layout", () => {
  const data = new Uint8Array(8 + 64 + 40 + 40 + 1);
  const view = new DataView(data.buffer);
  data.set(donor.toBytes(), 8);
  data.set(new PublicKey(USDC).toBytes(), 40);
  view.setBigUint64(72, 5n, true);
  view.setBigUint64(80, 7n, true);
  view.setBigUint64(88, 9n, true);
  view.setBigUint64(120, 11n, true);
  view.setBigUint64(144, 13n, true);
  const vault = support.decodeVault(data);
  assert.deepEqual(vault.recipients, [donor.toBase58(), USDC]);
  assert.deepEqual(vault.sol.owed, [5n, 7n]);
  assert.equal(vault.sol.allocatedEach, 9n);
  assert.deepEqual(vault.usdc.owed, [0n, 11n]);
  assert.deepEqual(vault.usdc.paid, [0n, 13n]);
});

// ---- v2 page logic (ruling P4, P5, P10) ----
const bundle = async (entry, name) => {
  const out = new URL(`./.tmp-${name}.mjs`, import.meta.url).pathname;
  await build({
    entryPoints: [new URL(entry, import.meta.url).pathname],
    bundle: true,
    outfile: out,
    platform: "node",
    format: "esm",
    external: ["@solana/web3.js", "react", "react/jsx-runtime"],
    loader: { ".svg": "dataurl", ".png": "dataurl" },
    define: { "import.meta.env": "{}" },
  });
  const mod = await import(out);
  await rm(out);
  return mod;
};
const price = await bundle("../src/support/price.ts", "price");
const wallets = await bundle("../src/support/wallets.ts", "wallets");
const panel = await bundle("../src/support/PayoutPanel.tsx", "panel");

test("price hint: exact for USDC, hidden without a price, never a guess", async () => {
  assert.equal(price.usdHint("USDC", 5_000_000n, null), "≈ $5.00");
  assert.equal(price.usdHint("SOL", 100_000_000n, null), null);
  assert.equal(price.usdHint("SOL", 100_000_000n, 124), "≈ $12.40");
  assert.equal(price.usdHint("SOL", 1n, 124), "< $0.01");
  assert.equal(price.usdHint("SOL", null, 124), null);

  price.resetPriceCache();
  const down = async () => { throw new Error("offline"); };
  assert.equal(await price.fetchSolUsd(down), null);
  const garbage = async () => ({ ok: true, json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: "NaN" } }) });
  assert.equal(await price.fetchSolUsd(garbage), null);
  const good = async () => ({ ok: true, json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: 120 } }) });
  assert.equal(await price.fetchSolUsd(good, 1_000), 120);
  assert.equal(await price.fetchSolUsd(down, 30_000), 120, "served from the 60s cache");
  assert.equal(await price.fetchSolUsd(down, 70_000), null, "cache expires");
});

test("wallet grid: the four featured wallets in order, detected ones paired, others listed", () => {
  assert.deepEqual(wallets.FEATURED_WALLETS.map((w) => w.name), ["Phantom", "Solflare", "Backpack", "Jupiter", "MetaMask"]);
  const { featured, others } = wallets.arrangeWallets([
    { id: "standard:Backpack", name: "Backpack", standard: true },
    { id: "legacy:phantom", name: "Phantom", standard: false },
    { id: "standard:Glow", name: "Glow", standard: true },
    { id: "standard:Phantom Secure", name: "Phantom Secure", standard: true },
  ]);
  assert.equal(featured[0].option.id, "legacy:phantom");
  assert.equal(featured[1].option, undefined);
  assert.equal(featured[2].option.id, "standard:Backpack");
  assert.deepEqual(others.map((o) => o.name), ["Glow", "Phantom Secure"], "look-alike names don't get the real logo slot");
});

test("maintainer panel only matches an exact on-chain recipient", () => {
  const vault = { recipients: ["AAAA", "BBBB"] };
  assert.equal(panel.recipientSide(vault, "AAAA"), 0);
  assert.equal(panel.recipientSide(vault, "BBBB"), 1);
  assert.equal(panel.recipientSide(vault, "CCCC"), null);
  assert.equal(panel.recipientSide(null, "AAAA"), null);
  assert.equal(panel.recipientSide(vault, undefined), null);
});
