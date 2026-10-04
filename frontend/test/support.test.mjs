import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

// ---- swap safety (any token -> USDC) ----
// Real swap-instructions captured from Jupiter's API (test/fixtures/jupiter/capture.mjs),
// plus forged variants of them. Each forged one must be refused before signing.
const swapMod = await bundle("../src/support/swap.ts", "swap");
const DONOR = donor.toBase58();
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const THIEF = "6TcyBfPdBt1kjsvDZLzmBFnuMaLWiTaAt4RjUr9VA5YD";
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/jupiter/${name}.json`, import.meta.url), "utf8"));
const FIXTURES = ["usdt-shared", "bonk-shared", "jup-route"];
const quoteOf = (f) => ({ inputMint: f.quote.inputMint, inAmount: f.quote.inAmount, outAmount: f.quote.outAmount, otherAmountThreshold: f.quote.otherAmountThreshold, raw: f.quote });
const check = (f, response = f.swapInstructions) => swapMod.assertSafeSwap(response, DONOR, accounts, quoteOf(f));

// Route args end with in_amount u64 | quoted_out_amount u64 | slippage_bps u16 | platform_fee_bps u8.
const withArgs = (f, { inAmount, outAmount, slippage, fee, suffix = Buffer.alloc(0) }) => {
  const s = structuredClone(f.swapInstructions);
  const data = Buffer.from(s.swapInstruction.data, "base64");
  const tail = data.length - 19;
  if (inAmount !== undefined) data.writeBigUInt64LE(inAmount, tail);
  if (outAmount !== undefined) data.writeBigUInt64LE(outAmount, tail + 8);
  if (slippage !== undefined) data.writeUInt16LE(slippage, tail + 16);
  if (fee !== undefined) data.writeUInt8(fee, tail + 18);
  s.swapInstruction.data = Buffer.concat([data, suffix]).toString("base64");
  return s;
};
const destinationIndex = (s) => s.swapInstruction.accounts.findIndex((a) => a.pubkey === accounts.vaultUsdc.toBase58());
const computePrice = (microLamports) => { const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(microLamports, 1); return d.toString("base64"); };

test("swap safety: real Jupiter routes into the vault pass, and report their fee", () => {
  for (const name of FIXTURES) {
    const f = fixture(name);
    const plan = check(f);
    assert.ok(plan.priorityFeeLamports <= swapMod.MAX_PRIORITY_FEE_LAMPORTS, name);
    // Jupiter creates the donor's USDC account in setup; that's rent the card must show.
    assert.ok(plan.createsAccounts.some((a) => a.rentLamports === 2_039_280n), name);
  }
});

test("swap safety: the reviewer's forged route is refused (thief destination, 100% slippage, fee, huge price)", () => {
  const f = fixture("jup-route");
  const s = withArgs(f, { inAmount: 10n ** 12n, outAmount: 1n, slippage: 10_000, fee: 255 });
  const dest = destinationIndex(s);
  s.swapInstruction.accounts[dest] = { pubkey: THIEF, isSigner: false, isWritable: true };
  s.swapInstruction.accounts[6] = { pubkey: THIEF, isSigner: false, isWritable: true }; // platform_fee_account
  s.swapInstruction.accounts.push({ pubkey: accounts.vaultUsdc.toBase58(), isSigner: false, isWritable: true });
  s.computeBudgetInstructions = [{ programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: computePrice(2n ** 62n) }];
  assert.throws(() => check(f, s));
});

test("swap safety: each forged field is refused on its own", () => {
  const cases = [
    ["destination is someone else, vault only as a remaining account", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.swapInstruction.accounts[destinationIndex(s)].pubkey = THIEF;
      s.swapInstruction.accounts.push({ pubkey: accounts.vaultUsdc.toBase58(), isSigner: false, isWritable: true });
      return s;
    }, /doesn't deliver to the support vault/],
    ["route destination is someone else", "jup-route", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.swapInstruction.accounts[4].pubkey = THIEF;
      s.swapInstruction.accounts.push({ pubkey: accounts.vaultUsdc.toBase58(), isSigner: false, isWritable: true });
      return s;
    }, /doesn't deliver to the support vault/],
    ["in_amount above the quote", "usdt-shared", (f) => withArgs(f, { inAmount: 10n ** 12n }), /different amount/],
    ["quoted_out_amount below the quote", "bonk-shared", (f) => withArgs(f, { outAmount: 1n }), /price you saw/],
    ["slippage 100%", "jup-route", (f) => withArgs(f, { slippage: 10_000 }), /slippage/],
    ["platform fee bps", "usdt-shared", (f) => withArgs(f, { fee: 255 }), /platform fee/],
    ["platform fee account", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.swapInstruction.accounts[9].pubkey = THIEF;
      return s;
    }, /platform fee/],
    ["good-looking args appended after forged ones", "usdt-shared", (f) => {
      const good = Buffer.from(f.swapInstructions.swapInstruction.data, "base64").subarray(-19);
      return withArgs(f, { inAmount: 10n ** 12n, slippage: 10_000, suffix: good });
    }, /extra bytes/],
    ["unknown Jupiter instruction (exact-out)", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      const data = Buffer.from(s.swapInstruction.data, "base64");
      Buffer.from(createHash("sha256").update("global:shared_accounts_exact_out_route").digest().subarray(0, 8)).copy(data);
      s.swapInstruction.data = data.toString("base64");
      return s;
    }, /doesn't allow/],
    ["a DEX missing from the IDL", "jup-route", (f) => {
      const s = structuredClone(f.swapInstructions);
      const data = Buffer.from(s.swapInstruction.data, "base64");
      data[12] = 250; // first route step's DEX variant
      s.swapInstruction.data = data.toString("base64");
      return s;
    }, /doesn't recognise/],
    ["priority fee 2^62 micro-lamports", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.computeBudgetInstructions[1].data = computePrice(2n ** 62n);
      return s;
    }, /priority fee/],
    ["priority fee just over the lamport cap", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.computeBudgetInstructions[1].data = computePrice(200_000n);
      return s;
    }, /priority fee/],
    ["other compute budget instruction (heap frame)", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.computeBudgetInstructions.push({ programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: Buffer.from([1, 0, 0, 4, 0]).toString("base64") });
      return s;
    }, /compute instruction/],
    ["compute budget from another program", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.computeBudgetInstructions[0].programId = TOKEN;
      return s;
    }, /compute instruction/],
    ["setup creates an account that isn't the donor's ATA", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.setupInstructions[0].accounts[1].pubkey = THIEF;
      return s;
    }, /isn't yours/],
    ["setup owner isn't the donor", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.setupInstructions[0].accounts[2].pubkey = THIEF;
      return s;
    }, /isn't yours/],
    ["setup from another program", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.setupInstructions[0].programId = TOKEN;
      return s;
    }, /isn't yours/],
    ["not Jupiter", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.swapInstruction.programId = THIEF;
      return s;
    }, /isn't routed through Jupiter/],
    ["outputs another mint", "jup-route", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.swapInstruction.accounts[5].pubkey = THIEF;
      return s;
    }, /doesn't output USDC/],
    ["extra signer", "usdt-shared", (f) => {
      const s = structuredClone(f.swapInstructions);
      s.swapInstruction.accounts.push({ pubkey: THIEF, isSigner: true, isWritable: true });
      return s;
    }, /unexpected signer/],
    ["extra instructions", "usdt-shared", (f) => ({ ...structuredClone(f.swapInstructions), otherInstructions: [{ programId: TOKEN, accounts: [], data: "" }] }), /extra instructions/],
    ["token ledger mode", "usdt-shared", (f) => ({ ...structuredClone(f.swapInstructions), tokenLedgerInstruction: { programId: JUPITER, accounts: [], data: "" } }), /token-ledger/],
    ["cleanup pays someone else", "usdt-shared", (f) => ({ ...structuredClone(f.swapInstructions), cleanupInstruction: { programId: TOKEN, accounts: [{ pubkey: "W" }, { pubkey: THIEF }, { pubkey: DONOR }], data: Buffer.from([9]).toString("base64") } }), /cleanup/],
    ["Jupiter error", "usdt-shared", (f) => ({ ...structuredClone(f.swapInstructions), error: "no route" }), /couldn't build/],
  ];
  for (const [label, name, forge, reason] of cases) {
    const f = fixture(name);
    assert.throws(() => check(f, forge(f)), reason, label);
  }
});

test("swap quote: refuses quotes that don't match what the card shows", async () => {
  const f = fixture("usdt-shared");
  const answer = (patch) => async () => ({ ok: true, json: async () => ({ ...f.quote, ...patch }) });
  const amount = BigInt(f.quote.inAmount);
  assert.ok(await swapMod.quoteToUsdc(f.quote.inputMint, amount, USDC, answer({})));
  for (const patch of [{ slippageBps: 10_000 }, { swapMode: "ExactOut" }, { platformFee: { amount: "5", feeBps: 50 } }, { inAmount: "1" }, { otherAmountThreshold: "1" }, { inputMint: THIEF }]) {
    assert.equal(await swapMod.quoteToUsdc(f.quote.inputMint, amount, USDC, answer(patch)), null, JSON.stringify(patch));
  }
});

test("swap fee: the card shows rent for a new token account, and a worse fresh quote stops the send", async () => {
  const f = fixture("jup-route");
  const fetcher = async () => ({ ok: true, json: async () => structuredClone(f.swapInstructions) });
  const none = async () => new Set();
  const prepared = await swapMod.buildSwapTip({ donor, quote: quoteOf(f), note: "", hideAddress: false, accounts, fetcher, existingAccounts: none });
  assert.ok(prepared.rentLamports >= 2_039_280n, "the donor's USDC account would be created");
  assert.ok(prepared.feeLamports > 2_000_000n, "≈0.002 SOL, not '< $0.01'");
  const all = async (addresses) => new Set(addresses);
  const funded = await swapMod.buildSwapTip({ donor, quote: quoteOf(f), note: "", hideAddress: false, accounts, fetcher, existingAccounts: all });
  assert.equal(funded.rentLamports, 0n);

  // Shared routes don't touch the donor's own USDC account, so it isn't created.
  const shared = fixture("usdt-shared");
  const sharedFetcher = async () => ({ ok: true, json: async () => structuredClone(shared.swapInstructions) });
  const sharedTip = await swapMod.buildSwapTip({ donor, quote: quoteOf(shared), note: "", hideAddress: false, accounts, fetcher: sharedFetcher, existingAccounts: none });
  assert.equal(sharedTip.rentLamports, 0n);
  assert.ok(!sharedTip.instructions.some((ix) => ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));

  const shown = { quote: quoteOf(f), feeLamports: funded.feeLamports };
  assert.equal(swapMod.worseThanShown(shown, shown), null);
  assert.match(swapMod.worseThanShown(shown, { ...shown, quote: { ...shown.quote, otherAmountThreshold: (BigInt(shown.quote.otherAmountThreshold) - 1n).toString() } }), /price moved/);
  assert.match(swapMod.worseThanShown(shown, { ...shown, feeLamports: shown.feeLamports + 1n }), /fee went up/);
});

test("token search leaves out SOL and USDC, which have their own buttons", async () => {
  const fake = async () => ({ ok: true, json: async () => ([
    { id: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Wrapped SOL", decimals: 9, isVerified: true },
    { id: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, isVerified: true },
    { id: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "USDT", decimals: 6, isVerified: true },
  ]) });
  assert.deepEqual((await swapMod.searchTokens("sol", fake)).map((t) => t.symbol), ["USDT"]);
});

test("token search keeps verified tokens only", async () => {
  const fake = async () => ({ ok: true, json: async () => ([
    { id: "Good", symbol: "GOOD", name: "Good", decimals: 6, isVerified: true },
    { id: "Scam", symbol: "USDT", name: "Tether USD", decimals: 6, isVerified: false },
  ]) });
  const list = await swapMod.searchTokens("usdt", fake);
  assert.deepEqual(list.map((t) => t.mint), ["Good"]);
});
