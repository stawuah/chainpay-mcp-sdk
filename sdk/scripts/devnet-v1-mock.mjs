#!/usr/bin/env node
/**
 * One-shot Devnet v1 proof with a generated mock signer. Not Jupiter.
 *
 * Network: Solana Devnet
 * Amount: 10000 lamports
 * Recipient: generated mock pubkey
 * Signer: generated mock pubkey, funded by requestAirdrop
 */
import { createPrivateKey, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { getTransactionEncoder } from "@solana/transactions";
import {
  V1_COMPUTE_UNIT_LIMIT,
  V1_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  compileV1TransactionBytes,
  decodeSupportedTransaction,
  systemTransferInstruction,
} from "../dist/index.js";

const RPC = process.env.CHAINPAY_RPC_URL ?? "https://api.devnet.solana.com";
const AMOUNT_LAMPORTS = 10_000n;
const AIRDROP_LAMPORTS = 1_000_000_000;

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

async function waitForBalance(address, minLamports) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const balance = await rpc("getBalance", [address, { commitment: "confirmed" }]);
    if ((balance.value ?? balance) >= minLamports) return balance.value ?? balance;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Airdrop did not credit ${address}`);
}

const payer = Keypair.generate();
const recipient = Keypair.generate();
console.log(JSON.stringify({
  network: RPC.includes("127.0.0.1") || RPC.includes("localhost") ? "solana-localnet" : "solana-devnet",
  rpc: RPC,
  amountLamports: AMOUNT_LAMPORTS.toString(),
  signer: payer.publicKey.toBase58(),
  recipient: recipient.publicKey.toBase58(),
  wallet: "generated-mock",
  jupiter: "not-used",
}, null, 2));

await rpc("requestAirdrop", [payer.publicKey.toBase58(), AIRDROP_LAMPORTS]);
await waitForBalance(payer.publicKey.toBase58(), AIRDROP_LAMPORTS);
await rpc("requestAirdrop", [recipient.publicKey.toBase58(), AIRDROP_LAMPORTS]);
await waitForBalance(recipient.publicKey.toBase58(), AIRDROP_LAMPORTS);

const latest = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
const blockhash = latest.value.blockhash;
const lastValidBlockHeight = BigInt(latest.value.lastValidBlockHeight);
const prepared = {
  instructions: [systemTransferInstruction(payer.publicKey.toBase58(), recipient.publicKey.toBase58(), AMOUNT_LAMPORTS)],
  requiredSigners: [payer.publicKey.toBase58()],
  feePayer: payer.publicKey.toBase58(),
};
const unsigned = compileV1TransactionBytes(prepared, {
  version: 1,
  lifetime: { blockhash, lastValidBlockHeight },
  computeUnitLimit: V1_COMPUTE_UNIT_LIMIT,
  loadedAccountsDataSizeLimit: V1_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
});
const decoded = decodeSupportedTransaction(unsigned);
if (decoded.message.version !== 1) throw new Error("compile did not produce v1");

const simulation = await rpc("simulateTransaction", [
  Buffer.from(unsigned).toString("base64"),
  { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false },
]);
if (simulation.value.err) {
  throw new Error(`simulate failed: ${JSON.stringify(simulation.value.err)} logs=${JSON.stringify(simulation.value.logs)}`);
}

const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(payer.secretKey.subarray(0, 32))]),
  format: "der",
  type: "pkcs8",
});
const signatureBytes = sign(null, decoded.transaction.messageBytes, privateKey);
const signed = getTransactionEncoder().encode({
  messageBytes: decoded.transaction.messageBytes,
  signatures: { [payer.publicKey.toBase58()]: signatureBytes },
});
const signedDecoded = decodeSupportedTransaction(signed);
if (signedDecoded.message.version !== 1) throw new Error("signed wire is not v1");

const signature = await rpc("sendTransaction", [
  Buffer.from(signed).toString("base64"),
  { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
]);
console.log(JSON.stringify({ signature, wireBytes: signed.length }, null, 2));

let confirmed;
for (let attempt = 0; attempt < 30; attempt++) {
  confirmed = await rpc("getTransaction", [signature, {
    encoding: "base64",
    commitment: "confirmed",
    maxSupportedTransactionVersion: 1,
  }]);
  if (confirmed) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!confirmed) throw new Error("transaction was not readable back");
const [wire] = confirmed.transaction ?? [];
const readBack = wire ? decodeSupportedTransaction(Buffer.from(wire, "base64")) : null;
const recipientBalance = await rpc("getBalance", [recipient.publicKey.toBase58(), { commitment: "confirmed" }]);
const expected = BigInt(AIRDROP_LAMPORTS) + AMOUNT_LAMPORTS;
console.log(JSON.stringify({
  confirmedSlot: confirmed.slot,
  readBackVersion: readBack?.message.version ?? null,
  recipientLamports: String(recipientBalance.value ?? recipientBalance),
  amountLamports: AMOUNT_LAMPORTS.toString(),
}, null, 2));
if (readBack?.message.version !== 1) throw new Error("read-back was not v1");
if (BigInt(recipientBalance.value ?? recipientBalance) !== expected) {
  throw new Error(`recipient balance is not airdrop plus ${AMOUNT_LAMPORTS} lamports`);
}
