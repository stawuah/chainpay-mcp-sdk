import express, { type Request, type Response } from "express";
import {
  ChainPayClient,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  bytesToHex,
  deriveX402PaymentReferences,
  publicKey,
  type TokenProgram,
} from "@chainpay/sdk";

type MerchantConfig = {
  port: number;
  resource: string;
  mint: string;
  recipient: string;
  amount: string;
  tokenProgram: TokenProgram;
  allowedAgent: string;
  nonce?: string;
};

type PaymentProof = {
  version: "x402/1.0";
  scheme: "exact";
  network: "solana-devnet";
  payload: { signature: string; receiptPDA: string };
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configuration(): MerchantConfig {
  const port = Number(process.env.PORT ?? "3402");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const resource = new URL(process.env.CHAINPAY_X402_RESOURCE_URL?.trim() || `http://127.0.0.1:${port}/data`).toString();
  const mint = publicKey(process.env.CHAINPAY_X402_MINT?.trim() || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").toBase58();
  const recipient = publicKey(requiredEnvironment("CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT")).toBase58();
  const allowedAgent = publicKey(requiredEnvironment("CHAINPAY_X402_ALLOWED_AGENT")).toBase58();
  const amount = process.env.CHAINPAY_X402_AMOUNT?.trim() || "100000";
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) > 18_446_744_073_709_551_615n) {
    throw new Error("CHAINPAY_X402_AMOUNT must be a positive unsigned 64-bit integer");
  }
  const tokenProgram = process.env.CHAINPAY_X402_TOKEN_PROGRAM?.trim() || "spl-token";
  if (tokenProgram !== "spl-token" && tokenProgram !== "token-2022") {
    throw new Error("CHAINPAY_X402_TOKEN_PROGRAM must be spl-token or token-2022");
  }
  const nonce = process.env.CHAINPAY_X402_NONCE?.trim() || undefined;
  return { port, resource, mint, recipient, amount, tokenProgram, allowedAgent, ...(nonce ? { nonce } : {}) };
}

function parseProof(value: string): PaymentProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    } catch {
      throw new Error("X-PAYMENT is not valid JSON or base64 JSON");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("X-PAYMENT proof must be an object");
  const proof = parsed as Partial<PaymentProof>;
  if (proof.version !== "x402/1.0" || proof.scheme !== "exact" || proof.network !== "solana-devnet") {
    throw new Error("X-PAYMENT proof protocol is unsupported");
  }
  if (!proof.payload || typeof proof.payload.signature !== "string" || typeof proof.payload.receiptPDA !== "string") {
    throw new Error("X-PAYMENT proof payload is incomplete");
  }
  return proof as PaymentProof;
}

function paymentRequired(config: MerchantConfig) {
  return {
    version: "x402/1.0",
    accepts: [{
      scheme: "exact",
      network: "solana-devnet",
      maxAmountRequired: config.amount,
      asset: config.mint,
      payTo: config.recipient,
      resource: config.resource,
      tokenProgram: config.tokenProgram,
      ...(config.nonce ? { nonce: config.nonce } : {}),
    }],
  };
}

async function main() {
  const config = configuration();
  const client = new ChainPayClient({
    rpcUrl: process.env.CHAINPAY_RPC_URL,
    programId: process.env.CHAINPAY_PROGRAM_ID,
    commitment: "finalized",
  });
  const challenge = paymentRequired(config);
  const references = await deriveX402PaymentReferences({
    mint: config.mint,
    recipient: config.recipient,
    amount: config.amount,
    resource: config.resource,
    tokenProgram: config.tokenProgram,
    ...(config.nonce ? { nonce: config.nonce } : {}),
  });
  const expectedTokenProgram = config.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  const asset = await client.getSupportedAsset(config.mint);
  if (!asset?.enabled || asset.tokenProgram !== expectedTokenProgram) {
    throw new Error("Merchant asset is not enabled with the expected token program in ChainPay SupportedAsset");
  }

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_request: Request, response: Response) => response.json({ ok: true }));
  app.get("/data", async (request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    const paymentHeader = request.header("x-payment");
    if (!paymentHeader) {
      const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
      return response.status(402).set("X-Payment-Required", encoded).json(challenge);
    }

    try {
      const proof = parseProof(paymentHeader);
      const receiptAddress = publicKey(proof.payload.receiptPDA).toBase58();
      const receipt = await client.getPayment(receiptAddress);
      if (!receipt || receipt.status !== "confirmed") throw new Error("receipt is missing or not settled");
      if (receipt.address !== receiptAddress) throw new Error("receipt PDA mismatch");
      if (bytesToHex(receipt.invoiceHash) !== references.invoiceHash) throw new Error("invoice hash mismatch");
      if (receipt.mint !== config.mint) throw new Error("mint mismatch");
      if (receipt.recipient !== config.recipient) throw new Error("recipient mismatch");
      if (receipt.amount !== BigInt(config.amount)) throw new Error("amount mismatch");
      if (receipt.agent !== config.allowedAgent) throw new Error("approved agent mismatch");

      const transaction = await client.connection.getTransaction(proof.payload.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!transaction || transaction.meta?.err !== null) throw new Error("settlement transaction is missing or failed");
      if (BigInt(transaction.slot) !== receipt.executedAtSlot) throw new Error("transaction slot does not match receipt");
      const keys = transaction.transaction.message.getAccountKeys({ accountKeysFromLookups: transaction.meta?.loadedAddresses });
      if (!Array.from({ length: keys.length }, (_unused, index) => keys.get(index)?.toBase58()).includes(receiptAddress)) {
        throw new Error("settlement transaction does not reference the receipt PDA");
      }
      if (!transaction.meta.logMessages?.some((line) => line.includes("Instruction: ExecutePayment"))) {
        throw new Error("transaction did not execute ChainPay payment settlement");
      }

      return response.json({
        data: "Premium resource content",
        paidWith: receiptAddress,
        transactionSignature: proof.payload.signature,
      });
    } catch (error) {
      return response.status(402).json({
        error: "Payment verification failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`ChainPay x402 demo merchant listening at ${config.resource}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
