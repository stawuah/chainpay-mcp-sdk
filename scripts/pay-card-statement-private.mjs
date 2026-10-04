// Devnet-only operator tooling (never CI): pay a simulated-credit card
// statement privately through MagicBlock Private Payments, using the SDK's
// `payStatementPrivately` exactly as the browser does. The owner keypair signs
// the MagicBlock login, the vault deposit (if any) and the private transfer.
// The MagicBlock token stays in this process's memory and is never printed.
//
//   npm --prefix sdk run build
//   cargo run -p chainpay-backend --example cards_live_sandbox -- private-prepare state.json attempt.json <label>
//   OWNER_KEYPAIR=... node scripts/pay-card-statement-private.mjs attempt.json [override base units]
//   cargo run -p chainpay-backend --example cards_live_sandbox -- private-submit state.json <attemptId> <label>
//
// Passing an override amount on purpose is how the negative evidence run is
// produced (the attempt's reference, the wrong amount).
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { payStatementPrivately } from "../sdk/dist/cards/private-repayment.js";

const [attemptPath, override] = process.argv.slice(2);
const RPC = process.env.CHAINPAY_RPC_URL ?? "https://api.devnet.solana.com";
if (!RPC.includes("devnet")) throw new Error("Devnet only");
if (!attemptPath || (override && !/^[1-9][0-9]*$/.test(override))) {
  throw new Error("usage: OWNER_KEYPAIR=... node scripts/pay-card-statement-private.mjs <attempt.json> [override base units]");
}
const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
if (override) attempt.amountBaseUnits = override;
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.OWNER_KEYPAIR, "utf8"))));
const connection = new Connection(RPC, "confirmed");

const signer = {
  publicKey: owner.publicKey.toBase58(),
  async signMessage(message) {
    return ed25519.sign(message, owner.secretKey.slice(0, 32));
  },
  async signTransaction(b64) {
    const raw = Buffer.from(b64, "base64");
    try {
      const tx = VersionedTransaction.deserialize(raw);
      tx.sign([owner]);
      return Buffer.from(tx.serialize()).toString("base64");
    } catch {
      const tx = Transaction.from(raw);
      tx.partialSign(owner);
      return tx.serialize({ requireAllSignatures: false }).toString("base64");
    }
  },
};

const started = Date.now();
const out = await payStatementPrivately({
  attempt,
  signer,
  sendBase: async (signed, built) => {
    const signature = await connection.sendRawTransaction(Buffer.from(signed, "base64"));
    await connection.confirmTransaction({ signature, blockhash: built.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
    return signature;
  },
  onStep: (step) => console.error(`step ${JSON.stringify(step)}`),
});
console.log(JSON.stringify({ attemptId: attempt.attemptId, amountBaseUnits: attempt.amountBaseUnits, override: Boolean(override), ms: Date.now() - started, ...out }, null, 2));
