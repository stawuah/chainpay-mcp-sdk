import type { IncomingMessage, ServerResponse } from "node:http";
import { createConfiguredMerchant, type ConfiguredMerchant } from "./bootstrap.js";

/**
 * The resource URL is part of every invoice hash, so it has to be the URL
 * payers actually call. On a Vercel production deployment, default it to the
 * project's production domain. Preview deployments must set
 * CHAINPAY_X402_RESOURCE_URL themselves: their own URL changes per deploy.
 */
export function vercelMerchantEnvironment(env: NodeJS.Dict<string>): NodeJS.Dict<string> {
  if (env.CHAINPAY_X402_RESOURCE_URL?.trim()) return env;
  const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (env.VERCEL_ENV === "production" && productionHost) {
    return { ...env, CHAINPAY_X402_RESOURCE_URL: `https://${productionHost}/data` };
  }
  throw new Error("CHAINPAY_X402_RESOURCE_URL is required on a non-production Vercel deployment");
}

let ready: Promise<ConfiguredMerchant> | undefined;

/**
 * Vercel function entry (`api/index.js`). Vercel owns the socket, so
 * CHAINPAY_MERCHANT_HOST and PORT do not apply here. Startup checks (registry,
 * v2 merchant owner, recipient token account) run once per instance; a failure
 * answers 503 and is retried on the next request.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let merchant: ConfiguredMerchant;
  try {
    ready ??= Promise.resolve()
      .then(() => createConfiguredMerchant(vercelMerchantEnvironment(process.env)))
      .catch((error) => {
        ready = undefined;
        throw error;
      });
    merchant = await ready;
  } catch (error) {
    process.stderr.write(`demo merchant startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Merchant is not configured. Check the deployment logs." }));
    return;
  }
  merchant.app(req as Parameters<typeof merchant.app>[0], res as Parameters<typeof merchant.app>[1]);
}
