// Fail a hosted build before it silently falls back to the review stack.
import { pathToFileURL } from "node:url";
export function checkReleaseEnvironment(service, env) {
  if (!["frontend", "backend", "mcp"].includes(service)) throw new Error("Unknown service");
  const required = name => { if (!env[name]) throw new Error(`${name} is required`); return env[name]; };
  const origin = name => { const url = new URL(required(name)); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be a public HTTPS URL without credentials`); return url; };
  const context = required("CHAINPAY_RELEASE_ENVIRONMENT");
  if (!["preview", "production"].includes(context) || env.VERCEL_ENV && env.VERCEL_ENV !== context) throw new Error("Release environment does not match Vercel target");
  const type = required("CHAINPAY_CONVEX_DEPLOYMENT_TYPE");
  if (context === "production" ? type !== "prod" : !["dev", "preview"].includes(type)) throw new Error("Convex deployment type does not match release environment");
  required("CHAINPAY_RELEASE_GROUP"); // Identifies the same DB + service origins across all three projects.
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
  return { service, environment: context, storageType: type, group: env.CHAINPAY_RELEASE_GROUP };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(checkReleaseEnvironment(process.argv[2], process.env))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
