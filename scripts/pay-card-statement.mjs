// Devnet-only operator tooling (never CI): pay a simulated-credit card
// statement through the existing execute_payment path. The owner approves a
// one-payment mandate, the agent key executes it, and the receipt PDA is
// ["receipt", mandate, invoice_hash = statement digest]. Then submit the
// receipt to POST /v1/cards/{cardId}/statements/{statementId}/repayment.
//
//   npm --prefix sdk run build
//   OWNER_KEYPAIR=... AGENT_KEYPAIR=... CARDS_PARTNER_TOKEN_ACCOUNT=... \
//     node scripts/pay-card-statement.mjs <statement digest hex> <amount base units> <label>
//
// Amount is in token base units (USDC: cents x 10_000). Passing a wrong
// amount on purpose is how the negative evidence run was produced.
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ChainPayClient, toWeb3Transaction } from "../sdk/dist/index.js";

const [digestHex, amountArg, label] = process.argv.slice(2);
const RPC = process.env.CHAINPAY_RPC_URL ?? "https://api.devnet.solana.com";
if (!RPC.includes("devnet")) throw new Error("Devnet only");
const PROGRAM = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const USDC = process.env.CARDS_REPAYMENT_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PARTNER = process.env.CARDS_PARTNER_TOKEN_ACCOUNT;
if (!PARTNER || !digestHex || !/^[0-9a-f]{64}$/.test(digestHex) || !/^[1-9][0-9]*$/.test(amountArg ?? "")) {
  throw new Error("usage: CARDS_PARTNER_TOKEN_ACCOUNT=... node scripts/pay-card-statement.mjs <digest hex> <amount base units> <label>");
}
const key = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const owner = key(process.env.OWNER_KEYPAIR);
const agent = key(process.env.AGENT_KEYPAIR);
const connection = new Connection(RPC, "confirmed");
const client = new ChainPayClient({ rpcUrl: RPC, programId: PROGRAM, commitment: "confirmed" });
const ata = PublicKey.findProgramAddressSync(
  [owner.publicKey.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(USDC).toBuffer()],
  new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
)[0];
const amount = BigInt(amountArg);

async function send(prepared, signers, commitment) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = toWeb3Transaction(prepared, latest.blockhash);
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await connection.confirmTransaction({ signature: sig, ...latest }, commitment);
  if (res.value.err) throw new Error(`${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

const slot = BigInt(await connection.getSlot("confirmed"));
const mandate = await client.buildCreateMandate({
  approvedAgent: agent.publicKey.toBase58(),
  sourceTokenAccount: ata.toBase58(),
  allowedMint: USDC,
  maxPerPayment: amount,
  totalLimit: amount,
  expiresAtSlot: slot + 500_000n,
  maxPaymentCount: 1n,
  cooldownSlots: 0n,
  tokenProgram: "spl-token",
  delegateAmount: amount,
}, owner.publicKey.toBase58());
const mandateSig = await send(mandate.transaction, [owner], "confirmed");
const rand = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return b; };
const prepared = await client.preparePayment({
  mandate: mandate.mandateAddress,
  invoiceHash: Uint8Array.from(Buffer.from(digestHex, "hex")),
  paymentId: rand(),
  signatureReference: rand(),
  mint: USDC,
  recipient: PARTNER,
  amount,
  tokenProgram: "spl-token",
}, agent.publicKey.toBase58());
const paymentSig = await send(prepared.transaction, [agent], "finalized");
console.log(JSON.stringify({ label, mandate: mandate.mandateAddress, mandateTx: mandateSig, receipt: prepared.receiptAddress, executePaymentTx: paymentSig, amountBaseUnits: amount.toString(), invoiceHash: digestHex }, null, 2));
