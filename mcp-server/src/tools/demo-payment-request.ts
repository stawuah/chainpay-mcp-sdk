import { createPrivateKey, sign as signMessage } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  canonicalPaymentRequest,
  paymentRequestTokenProgramAddress,
  type PaymentRequestPayload,
} from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { requiredString, solanaAddress, tokenProgram, toolResult, unsignedInteger } from "./common.js";

const DEFAULT_MINT = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
const DEFAULT_RECIPIENT = "3JwwEZaFDMUNAoptGtg69qTB7MXYkZX7k8Anf3pAvZFY";
const DEFAULT_TOKEN_PROGRAM = "token-2022" as const;
const DEFAULT_AMOUNT = "1000000";

type DemoMerchant = {
  keypair: Keypair;
  persistent: boolean;
};

let cachedMerchant: DemoMerchant | undefined;

function demoMerchant(): DemoMerchant {
  if (cachedMerchant) return cachedMerchant;

  const encoded = process.env.CHAINPAY_DEMO_MERCHANT_SECRET_KEY?.trim();
  if (!encoded) {
    cachedMerchant = { keypair: Keypair.generate(), persistent: false };
    return cachedMerchant;
  }

  try {
    const secret = encoded.startsWith("[")
      ? Uint8Array.from(JSON.parse(encoded) as number[])
      : Uint8Array.from(Buffer.from(encoded, "base64"));
    cachedMerchant = { keypair: Keypair.fromSecretKey(secret), persistent: true };
    return cachedMerchant;
  } catch (error) {
    throw new Error(`CHAINPAY_DEMO_MERCHANT_SECRET_KEY is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function signCanonicalPayload(payload: PaymentRequestPayload, merchant: Keypair): string {
  const message = Buffer.from(canonicalPaymentRequest(payload), "utf8");
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(merchant.secretKey.slice(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return signMessage(null, message, privateKey).toString("base64");
}

async function assertRecipientTokenAccount(
  context: ChainPayMcpContext,
  recipient: string,
  mint: string,
  selectedTokenProgram: "spl-token" | "token-2022",
): Promise<void> {
  const account = await context.client.connection.getAccountInfo(new PublicKey(recipient), context.client.commitment);
  if (!account) throw new Error(`Demo recipient token account does not exist on Devnet: ${recipient}`);
  const expectedProgram = paymentRequestTokenProgramAddress({
    version: 1,
    cluster: "devnet",
    merchant: recipient,
    invoice: "demo",
    mint,
    tokenProgram: selectedTokenProgram,
    recipient,
    amount: DEFAULT_AMOUNT,
    decimals: 6,
    nonce: "demo",
  });
  if (account.owner.toBase58() !== expectedProgram) {
    throw new Error(`Demo recipient uses ${account.owner.toBase58()}, not the requested ${selectedTokenProgram} program`);
  }
  if (account.data.length < 32 || new PublicKey(Buffer.from(account.data.subarray(0, 32))).toBase58() !== mint) {
    throw new Error("Demo recipient token account does not belong to the requested mint");
  }
}

export async function createDemoPaymentRequest(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const selectedTokenProgram = args.tokenProgram === undefined
    ? DEFAULT_TOKEN_PROGRAM
    : tokenProgram(args.tokenProgram);
  const mint = solanaAddress(args.mint ?? process.env.CHAINPAY_DEMO_MINT ?? DEFAULT_MINT, "mint");
  const recipient = solanaAddress(args.recipient ?? process.env.CHAINPAY_DEMO_RECIPIENT ?? DEFAULT_RECIPIENT, "recipient");
  const amount = args.amount === undefined
    ? process.env.CHAINPAY_DEMO_AMOUNT ?? DEFAULT_AMOUNT
    : unsignedInteger(args.amount, "amount").toString();
  const invoice = args.invoice === undefined
    ? `chainpay-demo-${Date.now()}`
    : requiredString(args.invoice, "invoice");
  const resource = args.resource === undefined
    ? "chainpay://demo/devnet/api-credits"
    : requiredString(args.resource, "resource");
  const description = args.description === undefined
    ? "Devnet API credits"
    : requiredString(args.description, "description");

  await assertRecipientTokenAccount(context, recipient, mint, selectedTokenProgram);
  const merchant = demoMerchant();
  const decimals = await context.client.getMintDecimals(mint);
  const currentSlot = await context.client.getCurrentSlot();
  const payload: PaymentRequestPayload = {
    version: 1,
    cluster: "devnet",
    merchant: merchant.keypair.publicKey.toBase58(),
    invoice,
    mint,
    tokenProgram: selectedTokenProgram,
    recipient,
    amount,
    decimals,
    nonce: Keypair.generate().publicKey.toBase58(),
    expiresAtSlot: (currentSlot + 5_000n).toString(),
    resource,
  };
  const signature = signCanonicalPayload(payload, merchant.keypair);

  return toolResult({
    action: "demo_payment_request_created",
    request: { payload, signature },
    display: {
      description,
      amount,
      decimals,
      token: selectedTokenProgram === "token-2022" ? "PYUSD" : "USDC",
      network: "Solana Devnet",
      recipient,
      merchant: payload.merchant,
      persistentMerchant: merchant.persistent,
    },
    message: merchant.persistent
      ? "Created a signed Devnet demo payment request with the configured merchant signer."
      : "Created a signed Devnet demo payment request with an in-memory merchant signer. Set CHAINPAY_DEMO_MERCHANT_SECRET_KEY to keep the merchant identity stable across restarts.",
  });
}
