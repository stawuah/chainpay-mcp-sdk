import { Keypair } from "@solana/web3.js";
import { publicKey, type TokenProgram } from "@chainpay/sdk";

const MAX_U64 = 18_446_744_073_709_551_615n;

export type MerchantConfig = {
  port: number;
  resource: string;
  mint: string;
  /** Custom x402/1.0 payTo: recipient token account, not a merchant owner address. */
  recipient: string;
  amount: string;
  tokenProgram: TokenProgram;
  allowedAgent: string;
  programId: string;
  rpcUrl: string;
  nonce?: string;
};

/** Optional PR-07 publisher. Absent when the host key or Axum URL is unset. */
export type SellerPublishConfig = {
  backendUrl: string;
  programId: string;
  seller: string;
  secretKey: Uint8Array;
};

export type CustomPaymentRequired = {
  version: "x402/1.0";
  accepts: Array<{
    scheme: "exact";
    network: "solana-devnet";
    maxAmountRequired: string;
    asset: string;
    payTo: string;
    resource: string;
    tokenProgram: TokenProgram;
    nonce?: string;
  }>;
};

function requiredEnvironment(env: NodeJS.Dict<string>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function canonicalAmount(value: string, name: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a canonical positive unsigned 64-bit integer string`);
  }
  const amount = BigInt(value);
  if (amount > MAX_U64) {
    throw new Error(`${name} must be a canonical positive unsigned 64-bit integer string`);
  }
  return value;
}

/** Reject credentials and fragments without echoing the URL. */
export function assertSafeHttpUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.hash) {
    throw new Error(`${name} must not contain a fragment`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return parsed;
}

export function loadMerchantConfig(env: NodeJS.Dict<string> = process.env): MerchantConfig {
  const port = Number(env.PORT ?? "3402");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const resource = assertSafeHttpUrl(
    env.CHAINPAY_X402_RESOURCE_URL?.trim() || `http://127.0.0.1:${port}/data`,
    "CHAINPAY_X402_RESOURCE_URL",
  ).toString();
  const mint = publicKey(env.CHAINPAY_X402_MINT?.trim() || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").toBase58();
  const recipient = publicKey(requiredEnvironment(env, "CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT")).toBase58();
  const allowedAgent = publicKey(requiredEnvironment(env, "CHAINPAY_X402_ALLOWED_AGENT")).toBase58();
  const amount = canonicalAmount(env.CHAINPAY_X402_AMOUNT?.trim() || "100000", "CHAINPAY_X402_AMOUNT");
  const tokenProgram = env.CHAINPAY_X402_TOKEN_PROGRAM?.trim() || "spl-token";
  if (tokenProgram !== "spl-token" && tokenProgram !== "token-2022") {
    throw new Error("CHAINPAY_X402_TOKEN_PROGRAM must be spl-token or token-2022");
  }
  const programId = publicKey(
    env.CHAINPAY_PROGRAM_ID?.trim() || "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4",
  ).toBase58();
  const rpcUrl = assertSafeHttpUrl(
    env.CHAINPAY_RPC_URL?.trim() || "https://api.devnet.solana.com",
    "CHAINPAY_RPC_URL",
  ).toString();
  const nonce = env.CHAINPAY_X402_NONCE?.trim() || undefined;
  if (nonce && nonce.length > 128) throw new Error("CHAINPAY_X402_NONCE is too long");
  return {
    port,
    resource,
    mint,
    recipient,
    amount,
    tokenProgram,
    allowedAgent,
    programId,
    rpcUrl,
    ...(nonce ? { nonce } : {}),
  };
}

/** Custom ChainPay receipt-proof challenge. payTo is a recipient token account. */
export function customPaymentRequired(config: MerchantConfig): CustomPaymentRequired {
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

export function sanitizedResourceLabel(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}${url.pathname}`;
}

/**
 * Host-only seller attestation. Disabled when the signing key or Axum URL is
 * unset. Never logs or returns the secret. Does not read
 * CHAINPAY_DEMO_MERCHANT_SECRET_KEY (that is the MCP demo payment-request signer).
 */
export function loadSellerPublishConfig(
  env: NodeJS.Dict<string> = process.env,
  programId: string,
): SellerPublishConfig | undefined {
  const encoded = env.CHAINPAY_SELLER_SECRET_KEY?.trim();
  const backend = env.CHAINPAY_BACKEND_URL?.trim();
  if (!encoded || !backend) return undefined;
  const backendUrl = assertSafeHttpUrl(backend, "CHAINPAY_BACKEND_URL").toString().replace(/\/$/, "");
  return sellerPublishConfigFromSecret({
    backendUrl,
    programId,
    secretKey: parseSellerSecretKey(encoded),
    trustedSeller: env.CHAINPAY_TRUSTED_SELLER?.trim() || undefined,
  });
}

export function sellerPublishConfigFromSecret(input: {
  backendUrl: string;
  programId: string;
  secretKey: Uint8Array;
  trustedSeller?: string;
}): SellerPublishConfig {
  const identity = sellerIdentity(input.secretKey);
  if (input.trustedSeller) {
    const expected = publicKey(input.trustedSeller).toBase58();
    if (expected !== identity.seller) {
      throw new Error("CHAINPAY_TRUSTED_SELLER does not match the configured seller signing key");
    }
  }
  return {
    backendUrl: input.backendUrl.replace(/\/$/, ""),
    programId: publicKey(input.programId).toBase58(),
    seller: identity.seller,
    secretKey: identity.secretKey,
  };
}

function parseSellerSecretKey(encoded: string): Uint8Array {
  try {
    if (encoded.startsWith("[")) {
      const values: unknown = JSON.parse(encoded);
      if (
        !Array.isArray(values)
        || !values.every((value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255)
      ) {
        throw new Error("invalid");
      }
      return Uint8Array.from(values as number[]);
    }
    if (/^[0-9a-fA-F]+$/.test(encoded) && (encoded.length === 64 || encoded.length === 128)) {
      return Uint8Array.from(Buffer.from(encoded, "hex"));
    }
    return Uint8Array.from(Buffer.from(encoded, "base64"));
  } catch {
    throw new Error("CHAINPAY_SELLER_SECRET_KEY is invalid");
  }
}

function sellerIdentity(secret: Uint8Array): { secretKey: Uint8Array; seller: string } {
  try {
    if (secret.length === 32) {
      return { secretKey: new Uint8Array(secret), seller: Keypair.fromSeed(secret).publicKey.toBase58() };
    }
    if (secret.length === 64) {
      return { secretKey: new Uint8Array(secret), seller: Keypair.fromSecretKey(secret).publicKey.toBase58() };
    }
  } catch {
    throw new Error("CHAINPAY_SELLER_SECRET_KEY is invalid");
  }
  throw new Error("CHAINPAY_SELLER_SECRET_KEY is invalid");
}
