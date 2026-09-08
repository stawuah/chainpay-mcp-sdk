import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import express, { type Request, type Response } from "express";
import { publicKey } from "@chainpay/sdk";

const CORBITS_FACILITATOR_URL = "https://facilitator.corbits.dev";
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

type MerchantConfig = {
  port: number;
  resource: string;
  mint: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  facilitator: string;
  rpcUrl: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpsOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${label} must be a credential-free HTTPS origin`);
  }
  return url.toString().replace(/\/$/, "");
}

function configuration(): MerchantConfig {
  const port = Number(process.env.PORT ?? "3402");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const resource = new URL(process.env.CHAINPAY_X402_RESOURCE_URL?.trim() || `http://127.0.0.1:${port}/data`).toString();
  const mint = publicKey(process.env.CHAINPAY_X402_MINT?.trim() || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").toBase58();
  const payTo = publicKey(requiredEnvironment("CHAINPAY_X402_PAY_TO")).toBase58();
  const amount = process.env.CHAINPAY_X402_AMOUNT?.trim() || "100000";
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) > 18_446_744_073_709_551_615n) {
    throw new Error("CHAINPAY_X402_AMOUNT must be a positive unsigned 64-bit integer");
  }
  const maxTimeoutSeconds = Number(process.env.CHAINPAY_X402_MAX_TIMEOUT_SECONDS ?? "60");
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error("CHAINPAY_X402_MAX_TIMEOUT_SECONDS must be a positive integer");
  }
  return {
    port,
    resource,
    mint,
    payTo,
    amount,
    maxTimeoutSeconds,
    facilitator: httpsOrigin(process.env.CHAINPAY_X402_FACILITATOR_URL ?? CORBITS_FACILITATOR_URL, "CHAINPAY_X402_FACILITATOR_URL"),
    rpcUrl: process.env.CHAINPAY_RPC_URL ?? "https://api.devnet.solana.com",
  };
}

async function main() {
  const config = configuration();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  const facilitator = new HTTPFacilitatorClient({ url: config.facilitator });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(SOLANA_DEVNET_CAIP2, new ExactSvmScheme({ rpcUrl: config.rpcUrl }));
  await resourceServer.initialize();

  app.get("/healthz", (_request: Request, response: Response) => response.json({ ok: true, facilitator: config.facilitator }));
  app.use(paymentMiddleware({
    "GET /data": {
      accepts: {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        payTo: config.payTo,
        price: { asset: config.mint, amount: config.amount },
        maxTimeoutSeconds: config.maxTimeoutSeconds,
      },
      resource: config.resource,
      description: "ChainPay standard x402 Devnet resource",
      mimeType: "application/json",
    },
  }, resourceServer));
  app.get("/data", (_request: Request, response: Response) => {
    response.set("Cache-Control", "no-store").json({
      data: "Premium resource content",
      settlement: "verified and settled by the configured x402 facilitator",
    });
  });

  app.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`ChainPay standard x402 demo merchant listening at ${config.resource}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
