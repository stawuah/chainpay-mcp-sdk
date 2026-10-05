import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { backendOperations, mcpOperations } from "./storage";
import { MAX_BODY_BYTES, UPSTREAM_TIMEOUT_MS, checkRelayRequest, clientKey, readLimited } from "./supportRpc";

function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
// Compare fixed-size digests so secret contents do not affect comparison time.
async function matches(token: string, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [left, right] = await Promise.all([digest(token), digest(secret)]);
  let difference = 0; for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i]; return difference === 0;
}
const http = httpRouter();
// Public, read-only, no secrets: what /status on the web app renders.
// Served from Convex so the page still loads when the relay it reports on is down.
http.route({ path: "/status/v1", method: "GET", handler: httpAction(async (ctx) => {
  const body = await ctx.runQuery(internal.status.summary, { now: Date.now() });
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30", "Access-Control-Allow-Origin": "*" } });
}) });
http.route({ path: "/internal/storage/v1", method: "POST", handler: httpAction(async (ctx, req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return response({ error: { code: "unauthorized", message: "Service authentication required" } }, 401);
  const secrets = [process.env.CHAINPAY_CONVEX_BACKEND_SECRET, process.env.CHAINPAY_CONVEX_MCP_SECRET, process.env.CHAINPAY_CONVEX_MIGRATION_SECRET];
  const configured = secrets.filter(Boolean);
  if (new Set(configured).size !== configured.length) return response({ error: { code: "configuration", message: "Service credentials must be distinct" } }, 503);
  const token = auth.slice(7);
  const verified = await Promise.all(secrets.map(secret => matches(token, secret)));
  const role = verified[0] ? "backend" : verified[1] ? "mcp" : verified[2] ? "migration" : null;
  if (!role) return response({ error: { code: "unauthorized", message: "Invalid service credential" } }, 401);
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > 900_000) return response({ error: { code: "too_large", message: "Request exceeds 900000 bytes" } }, 413);
    const body = JSON.parse(text);
    if (!body || typeof body.operation !== "string" || !body.args || typeof body.args !== "object" || Array.isArray(body.args)) return response({ error: { code: "invalid_argument", message: "Expected operation and args" } }, 400);
    const { operation, args } = body;
    if (role === "migration") {
      if (process.env.CHAINPAY_CONVEX_MIGRATION_ENABLED !== "true" || process.env.CHAINPAY_MAINTENANCE !== "true") return response({ error: { code: "forbidden", message: "Migration requires maintenance and migration mode" } }, 403);
      if (operation === "migration.import") return response({ value: await ctx.runMutation(internal.migration.importRows, args) });
      if (operation === "migration.export") return response({ value: await ctx.runQuery(internal.migration.exportRows, args) });
      return response({ error: { code: "forbidden", message: "Migration operation not permitted" } }, 403);
    }
    if (!(role === "backend" ? backendOperations : mcpOperations).has(operation)) return response({ error: { code: "forbidden", message: "Operation not permitted" } }, 403);
    return response({ value: await ctx.runMutation(internal.storage.execute, { role, operation, args }) });
  } catch (error) {
    if (error instanceof SyntaxError) return response({ error: { code: "invalid_argument", message: "Invalid JSON" } }, 400);
    if (error instanceof ConvexError && error.data && typeof error.data === "object" && "code" in error.data) {
      const raw = error.data as { code: string; message: string; retryAfterSeconds?: unknown };
      const data = { code: raw.code, message: raw.message, ...(raw.code === "rate_limited" && typeof raw.retryAfterSeconds === "number" && Number.isInteger(raw.retryAfterSeconds) && raw.retryAfterSeconds >= 1 && raw.retryAfterSeconds <= 86_400 ? { retryAfterSeconds: raw.retryAfterSeconds } : {}) };
      return response({ error: data }, ["maintenance", "unavailable"].includes(data.code) ? 503 : data.code === "unauthorized" ? 401 : data.code === "rate_limited" ? 429 : data.code === "forbidden" ? 403 : data.code === "conflict" ? 409 : 400);
    }
    // Never expose database payloads, provider identifiers, or token hashes.
    console.error("Storage operation failed", error instanceof Error ? error.name : "unknown");
    return response({ error: { code: "storage_error", message: "Storage operation failed; reconcile before retrying side effects" } }, 500);
  }
}) });
// Public, read-only support tracker. Only exact on-chain amounts; no secrets.
const supportHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
http.route({ path: "/support/v1", method: "GET", handler: httpAction(async (ctx) => {
  try {
    const summary = await ctx.runQuery(internal.support.publicSummary, {});
    return new Response(JSON.stringify(summary), { status: 200, headers: { ...supportHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  } catch (error) {
    console.error("Support summary failed", error instanceof Error ? error.name : "unknown");
    return new Response(JSON.stringify({ error: { code: "unavailable", message: "Support tracker unavailable" } }), { status: 503, headers: { ...supportHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
}) });
http.route({ path: "/support/v1", method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: { ...supportHeaders, "Access-Control-Max-Age": "86400" } })) });
// Narrow RPC relay for the /support page (see supportRpc.ts). Its key stays in
// SUPPORT_RELAY_RPC_URL, separate from the tracker's SUPPORT_RPC_URL.
const relayHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const relayError = (status: number, message: string, id: unknown = null) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: status === 429 ? -32005 : -32600, message } }), { status, headers: { ...relayHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
http.route({ path: "/support/rpc", method: "POST", handler: httpAction(async (ctx, req) => {
  // Cheap checks first, so a flood costs no database writes or upstream calls.
  const upstream = process.env.SUPPORT_RELAY_RPC_URL;
  const programId = process.env.SUPPORT_PROGRAM_ID;
  // Devnet only in this release: a relay pointed at any other cluster stays off.
  if (process.env.SUPPORT_LIVE !== "true" || process.env.SUPPORT_CLUSTER !== "devnet" || !upstream || !programId) return relayError(503, "Support RPC is off");
  const text = await readLimited(req, MAX_BODY_BYTES);
  if (text === null) return relayError(413, "Request too large");
  const check = checkRelayRequest(text, { programId });
  if (!check.ok) return relayError(check.status, check.message);
  const allowed = await ctx.runMutation(internal.support.relayAllowed, { client: await clientKey(req.headers), send: check.body.method === "sendTransaction" });
  if (!allowed) return relayError(429, "Too many requests; try again in a minute", check.body.id);
  try {
    const res = await fetch(upstream, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(check.body), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const body = await readLimited(res);
    if (body === null) return relayError(502, "Upstream response too large", check.body.id);
    return new Response(body, { status: res.status, headers: { ...relayHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return relayError(502, "Upstream RPC unavailable", check.body.id);
  }
}) });
http.route({ path: "/support/rpc", method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: { ...relayHeaders, "Access-Control-Max-Age": "86400" } })) });
export default http;
