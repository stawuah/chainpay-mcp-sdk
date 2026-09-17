import { Keypair } from "@solana/web3.js";
import {
  DEFAULT_PROGRAM_ID,
  buildExecutePaymentInstruction,
  deriveMandateAddress,
  deriveReceiptAddress,
  deriveX402PaymentReferences,
  hexToBytes,
  preparePayment,
  toWeb3Transaction,
} from "@chainpay/sdk";
import { encodeCanonicalBase58 } from "../dist/proof.js";

export const RESOURCE = "http://127.0.0.1:3402/data";
export const AMOUNT = "100000";
export const SLOT = 42;

export async function makeCustomSettlement(nonce = "fixture-nonce-1") {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const mint = Keypair.generate();
  const source = Keypair.generate();
  const recipient = Keypair.generate();
  const mandateAddress = deriveMandateAddress(owner.publicKey.toBase58(), DEFAULT_PROGRAM_ID, mint.publicKey.toBase58());
  const config = {
    port: 3402,
    resource: RESOURCE,
    mint: mint.publicKey.toBase58(),
    recipient: recipient.publicKey.toBase58(),
    amount: AMOUNT,
    tokenProgram: "spl-token",
    allowedAgent: agent.publicKey.toBase58(),
    programId: DEFAULT_PROGRAM_ID,
    rpcUrl: "http://127.0.0.1:9",
    nonce,
  };
  const references = await deriveX402PaymentReferences({
    mint: config.mint,
    recipient: config.recipient,
    amount: config.amount,
    resource: config.resource,
    tokenProgram: config.tokenProgram,
    nonce: config.nonce,
  });
  const invoiceHash = hexToBytes(references.invoiceHash, "invoiceHash");
  const receiptAddress = deriveReceiptAddress(mandateAddress, invoiceHash, DEFAULT_PROGRAM_ID);
  const request = preparePayment({
    mandate: mandateAddress,
    invoiceHash,
    paymentId: hexToBytes(references.paymentId, "paymentId"),
    signatureReference: hexToBytes(references.signatureReference, "signatureReference"),
    mint: config.mint,
    recipient: config.recipient,
    amount: BigInt(AMOUNT),
    tokenProgram: "spl-token",
  });
  const mandate = {
    address: mandateAddress,
    owner: owner.publicKey.toBase58(),
    approvedAgent: agent.publicKey.toBase58(),
    sourceTokenAccount: source.publicKey.toBase58(),
    allowedMint: mint.publicKey.toBase58(),
    maxPerPayment: 1_000_000n,
    totalLimit: 1_000_000n,
    amountSpent: 0n,
    paymentCount: 0n,
    expiresAtSlot: 10_000_000n,
    maxPaymentCount: 0n,
    cooldownSlots: 0n,
    lastPaymentSlot: 0n,
    paused: false,
    revoked: false,
    status: "active",
    tokenProgram: "spl-token",
  };
  const instruction = buildExecutePaymentInstruction(request, agent.publicKey.toBase58(), mandate, DEFAULT_PROGRAM_ID);
  const transaction = toWeb3Transaction({
    instructions: [instruction],
    requiredSigners: [agent.publicKey.toBase58()],
    feePayer: agent.publicKey.toBase58(),
  }, Keypair.generate().publicKey.toBase58());
  transaction.sign(agent);
  const wire = transaction.serialize();
  const signature = encodeCanonicalBase58(transaction.signature);
  const receipt = {
    address: receiptAddress,
    mandate: mandateAddress,
    invoiceHash,
    paymentId: hexToBytes(references.paymentId, "paymentId"),
    mint: config.mint,
    recipient: config.recipient,
    sourceTokenAccount: source.publicKey.toBase58(),
    recipientTokenAccount: config.recipient,
    amount: BigInt(AMOUNT),
    agent: config.allowedAgent,
    executedAtSlot: BigInt(SLOT),
    signatureReference: hexToBytes(references.signatureReference, "signatureReference"),
    status: "confirmed",
    onChainStatus: 1,
    bump: 255,
  };
  const proof = {
    version: "x402/1.0",
    scheme: "exact",
    network: "solana-devnet",
    payload: { signature, receiptPDA: receiptAddress },
  };
  const wireResult = {
    slot: SLOT,
    transaction: [Buffer.from(wire).toString("base64"), "base64"],
    meta: { err: null },
  };
  return { config, references, proof, receipt, wireResult, owner: owner.publicKey.toBase58() };
}
