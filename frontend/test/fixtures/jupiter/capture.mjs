// Captures real Jupiter swap-instructions for the support tests. Read-only: it
// asks Jupiter's public API to build (not send) swaps from a fixed donor address
// into the vault USDC account of the test program id used in support.test.mjs.
// Nothing is signed. Re-run to refresh: node test/fixtures/jupiter/capture.mjs
//
// It also refreshes src/support/jupiter-idl.json: the two route instructions and
// the types they need, read from Jupiter's on-chain Anchor IDL account. When
// Jupiter adds a new DEX, routes through it are refused until this is re-run.
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DONOR = "7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9";
// supportAccounts("D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH", USDC).vaultUsdc
const VAULT_USDC = "4pVHQ2vWFtEJXSgPSADGEQFzqwxPugq1GFgcHCUCqq5p";
const KEEP = ["tokenLedgerInstruction", "computeBudgetInstructions", "setupInstructions", "swapInstruction", "cleanupInstruction", "otherInstructions", "addressLookupTableAddresses"];

const cases = [
  ["usdt-shared", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 1_000_000n, true],
  ["bonk-shared", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", 100_000_000_000n, true],
  ["jup-route", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", 5_000_000n, false],
];
for (const [name, mint, amount, shared] of cases) {
  const quote = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC}&amount=${amount}&slippageBps=50&swapMode=ExactIn`)).json();
  const response = await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: DONOR,
      destinationTokenAccount: VAULT_USDC,
      wrapAndUnwrapSol: false,
      useSharedAccounts: shared,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "medium" } },
    }),
  });
  const body = await response.json();
  const swapInstructions = Object.fromEntries(KEEP.map((key) => [key, body[key] ?? null]));
  writeFileSync(new URL(`./${name}.json`, import.meta.url), `${JSON.stringify({ capturedAt: new Date().toISOString(), quote, swapInstructions }, null, 2)}\n`);
  console.log(name, "ok");
}

// ---- trimmed Jupiter IDL ----
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const [base] = PublicKey.findProgramAddressSync([], JUPITER);
const idlAddress = await PublicKey.createWithSeed(base, "anchor:idl", JUPITER);
const rpc = await (await fetch("https://api.mainnet-beta.solana.com", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [idlAddress.toBase58(), { encoding: "base64" }] }),
})).json();
const account = Buffer.from(rpc.result.value.data[0], "base64");
// Anchor IDL account: 8 discriminator + 32 authority + u32 length + zlib JSON.
const idl = JSON.parse(inflateSync(account.subarray(44, 44 + account.readUInt32LE(40))).toString());
const wanted = ["route", "shared_accounts_route"];
const instructions = idl.instructions
  .filter((ix) => wanted.includes(ix.name))
  .map((ix) => ({ name: ix.name, discriminator: ix.discriminator, accounts: ix.accounts.map((a) => a.name), args: ix.args }));
const byName = new Map(idl.types.map((t) => [t.name, t]));
const types = new Map();
const visit = (type) => {
  if (!type || typeof type !== "object") return;
  if (type.defined) {
    const name = type.defined.name;
    if (types.has(name)) return;
    const found = byName.get(name);
    if (!found) throw new Error(`IDL type ${name} missing`);
    types.set(name, found);
    for (const field of found.type.fields ?? []) visit(field.type ?? field);
    for (const variant of found.type.variants ?? []) for (const field of variant.fields ?? []) visit(field.type ?? field);
    return;
  }
  for (const inner of [type.vec, type.option, type.array?.[0]]) visit(inner);
};
for (const ix of instructions) for (const arg of ix.args) visit(arg.type);
const trimmed = { address: idl.address, source: `on-chain Anchor IDL ${idlAddress.toBase58()}, read ${new Date().toISOString().slice(0, 10)}`, instructions, types: [...types.values()] };
writeFileSync(new URL("../../../src/support/jupiter-idl.json", import.meta.url), `${JSON.stringify(trimmed)}\n`);
console.log("jupiter-idl.json ok", types.size, "types");
