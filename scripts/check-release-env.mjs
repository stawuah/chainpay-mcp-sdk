// Fail a hosted build before it silently falls back to the review stack.
import { readFileSync } from "node:fs";
const production = JSON.parse(readFileSync(new URL("./production-release.json", import.meta.url), "utf8"));
import { pathToFileURL } from "node:url";
const LITHIC_SANDBOX_HOST = "sandbox.lithic.com";
const lithicHost = value => { const url = new URL(value); return { url, host: url.hostname.replace(/\.$/, "").toLowerCase() }; };
// Real (non-sandbox) Lithic API host anywhere in a value: api.lithic.com, any case, optional trailing dot.
const LITHIC_PRODUCTION = /(^|[^a-z0-9.-])api\.lithic\.com\.?(?![a-z0-9-])/i;
// Key names that hold (or could hold) a production Lithic key. Hosted builds take only LITHIC_SANDBOX_API_KEY.
const LITHIC_PRODUCTION_KEY = /^LITHIC_(API_KEY|.*(PROD|PRODUCTION|LIVE).*)$/;
/**
 * ChainPay runs on Solana Devnet in every Vercel environment, including the one Vercel calls
 * `production` (the public Devnet MVP). Real Lithic production endpoints and keys are refused
 * everywhere; the card connector is allowed only on Devnet against the Lithic sandbox.
 */
function checkLithicSandboxOnly(context, env) {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && LITHIC_PRODUCTION.test(value)) throw new Error(`${name} points at the Lithic production API; only ${LITHIC_SANDBOX_HOST} is allowed`);
    if (LITHIC_PRODUCTION_KEY.test(name) && value && (context === "production" || name !== "LITHIC_API_KEY")) throw new Error(`${name} is a production Lithic key variable; use LITHIC_SANDBOX_API_KEY`);
  }
  if (env.CARDS_CONNECTOR_ENABLED !== undefined && !["true", "false"].includes(env.CARDS_CONNECTOR_ENABLED)) throw new Error("CARDS_CONNECTOR_ENABLED must be true or false");
  // Unset means on. The relay fails closed on anything else; the release check names the typo.
  if (env.CARDS_NEW_ACTIVATION_ENABLED !== undefined && !["true", "false"].includes(env.CARDS_NEW_ACTIVATION_ENABLED)) throw new Error("CARDS_NEW_ACTIVATION_ENABLED must be true or false");
}
export function checkReleaseEnvironment(service, env) {
  if (!["frontend", "backend", "mcp"].includes(service)) throw new Error("Unknown service");
  const required = name => { if (!env[name]) throw new Error(`${name} is required`); return env[name]; };
  const origin = name => { const url = new URL(required(name)); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be a public HTTPS URL without credentials`); return url; };
  const context = required("CHAINPAY_RELEASE_ENVIRONMENT");
  if (!["preview", "production"].includes(context) || env.VERCEL_ENV && env.VERCEL_ENV !== context) throw new Error("Release environment does not match Vercel target");
  const type = required("CHAINPAY_CONVEX_DEPLOYMENT_TYPE");
  if (context === "production" ? type !== "prod" : !["dev", "preview"].includes(type)) throw new Error("Convex deployment type does not match release environment");
  required("CHAINPAY_RELEASE_GROUP"); // Identifies the same DB + service origins across all three projects.
  checkLithicSandboxOnly(context, env);
  if (service === "frontend") {
    for (const key of ["VITE_CHAINPAY_BACKEND_URL", "VITE_CHAINPAY_RPC_URL", "VITE_CHAINPAY_MCP_URL", "VITE_CHAINPAY_AGENT_URL"]) origin(key);
    const backend = origin("VITE_CHAINPAY_BACKEND_URL"), mcp = origin("VITE_CHAINPAY_MCP_URL");
    if (backend.pathname !== "/" || mcp.pathname !== "/mcp" || origin("VITE_CHAINPAY_RPC_URL").href !== new URL("/rpc", backend).href || origin("VITE_CHAINPAY_AGENT_URL").href !== new URL("/agent/chat", mcp).href) throw new Error("Frontend service URLs must describe one relay and one MCP service");
  } else {
    if (required("CHAINPAY_STORAGE") !== "convex") throw new Error("Hosted services require Convex storage");
    const site = origin("CHAINPAY_CONVEX_SITE_URL");
    if (!site.hostname.endsWith(".convex.site") || site.pathname !== "/") throw new Error("Expected the selected Convex HTTP action origin");
    const key = service === "backend" ? "CHAINPAY_CONVEX_BACKEND_SECRET" : "CHAINPAY_CONVEX_MCP_SECRET";
    if (required(key).length < 32) throw new Error(`${key} must have at least 32 characters`);
    for (const value of required("CHAINPAY_ALLOWED_ORIGINS").split(",")) {
      const parsed = new URL(value.trim());
      if (parsed.origin !== value.trim() || parsed.protocol !== "https:" || value.includes("*")) throw new Error("Allowed origins must be exact HTTPS origins");
    }
    origin("CHAINPAY_RPC_URL");
    if (service === "backend" && env.CARDS_CONNECTOR_ENABLED === "true") {
      // Private agent cards: Solana Devnet + Lithic sandbox only, in preview and in the public
      // Devnet MVP that Vercel calls `production` (approved on #40, 2026-10-04).
      if ((env.CHAINPAY_CLUSTER ?? "devnet") !== "devnet") throw new Error("The card connector runs on Solana Devnet only (CHAINPAY_CLUSTER=devnet)");
      if (context === "production") {
        // Explicit, not a default: production must name the sandbox host and the sandbox key.
        if (lithicHost(required("LITHIC_API_URL")).host !== LITHIC_SANDBOX_HOST) throw new Error(`LITHIC_API_URL must be https://${LITHIC_SANDBOX_HOST}`);
        required("LITHIC_SANDBOX_API_KEY");
        if (env.CARDS_TEE_ATTESTATION_MODE && env.CARDS_TEE_ATTESTATION_MODE !== "enforce") throw new Error("CARDS_TEE_ATTESTATION_MODE must be enforce in production");
      }
      if (!env.LITHIC_SANDBOX_API_KEY && !env.LITHIC_API_KEY) throw new Error("LITHIC_SANDBOX_API_KEY is required for the card connector");
      for (const key of ["CARDS_AUTHORIZER_KEY", "CARDS_RECORD_KID", "LITHIC_ASA_SECRET", "LITHIC_EVENTS_SECRET", "CRON_SECRET"]) required(key);
      if (!env[`CARDS_RECORD_KEY_${env.CARDS_RECORD_KID}`]) throw new Error("CARDS_RECORD_KEY_<CARDS_RECORD_KID> is required for the card connector");
      if (env.CRON_SECRET.length < 16) throw new Error("CRON_SECRET must have at least 16 characters");
      if (env.CARDS_CHECKOUT_RUNNER_SECRET && env.CARDS_CHECKOUT_RUNNER_SECRET.length < 32) throw new Error("CARDS_CHECKOUT_RUNNER_SECRET must have at least 32 characters");
      // Unset means enforce: TEE attestation gates every approval. `report` is an explicit opt-out.
      if (env.CARDS_TEE_ATTESTATION_MODE && !["enforce", "report"].includes(env.CARDS_TEE_ATTESTATION_MODE)) throw new Error("CARDS_TEE_ATTESTATION_MODE must be enforce or report");
      if (env.LITHIC_API_URL) {
        const { url: lithic, host } = lithicHost(env.LITHIC_API_URL);
        if (lithic.protocol !== "https:" || lithic.username || lithic.password || host !== LITHIC_SANDBOX_HOST) throw new Error(`LITHIC_API_URL must be https://${LITHIC_SANDBOX_HOST}`);
      }
    }
    if (env.CHAINPAY_CROSSMINT_ENABLED === "true") {
      if (required("CHAINPAY_CROSSMINT_AUTH_SECRET").length < 32) throw new Error("Crossmint authorization secret must have at least 32 characters");
      required("CROSSMINT_API_KEY");
    }
    if (service === "mcp") {
      const backend = origin("CHAINPAY_BACKEND_URL"), app = origin("CHAINPAY_APP_URL");
      if (backend.pathname !== "/" || app.pathname !== "/" || origin("CHAINPAY_RPC_URL").href !== new URL("/rpc", backend).href) throw new Error("MCP must use its paired relay RPC and application origin");
      if (!env.CHAINPAY_ALLOWED_ORIGINS.split(",").map(x => x.trim()).includes(app.origin)) throw new Error("Application origin must be allowed by MCP CORS");
    }
  }
  if (context === "production") {
    const exact = (name, value) => { if (required(name) !== value) throw new Error(`${name} does not match the reviewed production release`); };
    exact("CHAINPAY_RELEASE_GROUP", production.group);
    if (service === "frontend") {
      exact("VITE_CHAINPAY_BACKEND_URL", production.relayOrigin);
      exact("VITE_CHAINPAY_RPC_URL", `${production.relayOrigin}/rpc`);
      exact("VITE_CHAINPAY_MCP_URL", `${production.mcpOrigin}/mcp`);
      exact("VITE_CHAINPAY_AGENT_URL", `${production.mcpOrigin}/agent/chat`);
    } else {
      exact("CHAINPAY_CONVEX_SITE_URL", production.convexSite);
      const origins = required("CHAINPAY_ALLOWED_ORIGINS").split(",").map(value => value.trim()).sort();
      if (JSON.stringify(origins) !== JSON.stringify([...production.webOrigins].sort())) throw new Error("CORS does not match the reviewed production release");
      if (service === "mcp") {
        exact("CHAINPAY_BACKEND_URL", production.relayOrigin);
        exact("CHAINPAY_RPC_URL", `${production.relayOrigin}/rpc`);
        exact("CHAINPAY_APP_URL", production.webOrigin);
      }
    }
  }
  return { service, environment: context, storageType: type, group: env.CHAINPAY_RELEASE_GROUP };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(checkReleaseEnvironment(process.argv[2], process.env))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
