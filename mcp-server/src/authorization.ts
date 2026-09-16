import type { IncomingMessage } from "node:http";
import type { ChainPayMcpContext } from "./tools/context.js";
import type { McpConnectionRegistry } from "./connections.js";

export type ConnectionScope = { version: 1; mandates: string[]; tools: string[]; agents: Record<string, string> };
export type Principal = { wallet: string; scope: ConnectionScope | null };
export class AuthorizationError extends Error {}
export const PUBLIC_TOOLS = new Set(["get_protocol_config", "get_asset", "get_supported_assets", "verify_payment_request"]);
const OWNER_TOOLS = new Set(["create_mandate", "update_mandate", "pause_mandate", "revoke_mandate"]);

export function parseScope(value: string): ConnectionScope {
  let scope: ConnectionScope;
  try { scope = JSON.parse(value) as ConnectionScope; } catch { throw new AuthorizationError("Legacy Unscoped connection. Reconnect and select a mandate and permitted tools."); }
  if (!scope || typeof scope !== "object" || scope.version !== 1 || !Array.isArray(scope.mandates) || !scope.mandates.length || scope.mandates.length > 20 || !scope.mandates.every(v => typeof v === "string") || !Array.isArray(scope.tools) || !scope.tools.length || scope.tools.length > 30 || !scope.tools.every(v => typeof v === "string") || !scope.agents || typeof scope.agents !== "object" || Array.isArray(scope.agents)) throw new AuthorizationError("Invalid connection scope. Reconnect with explicit permissions.");
  return scope;
}

export async function requestContext(base: ChainPayMcpContext, req: IncomingMessage, registry: McpConnectionRegistry): Promise<ChainPayMcpContext> {
  const token = req.headers.authorization?.match(/^Bearer ([^ ]{32,256})$/)?.[1];
  if (!token) throw new AuthorizationError("Sign in with your wallet to continue.");
  const connection = await registry.identify(req);
  if (connection) return { ...base, backendAuthToken: token, principal: { wallet: connection.wallet, scope: parseScope(connection.scope) }, assertActive: async () => {
    if (!await registry.identify(req)) throw new AuthorizationError("Connection revoked. Reconnect to continue.");
  } };
  if (!base.backendUrl) throw new AuthorizationError("Wallet session backend is not configured");
  const response = await fetch(`${base.backendUrl.replace(/\/$/, "")}/v1/auth/session`, { headers: { Authorization: `Bearer ${token}`, ...(req.headers.origin ? { Origin: req.headers.origin } : {}) }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new AuthorizationError("Wallet session expired. Sign in again.");
  const session = await response.json() as { wallet?: string; expires_at_ms?: number };
  if (!session.wallet || !session.expires_at_ms || session.expires_at_ms <= Date.now()) throw new AuthorizationError("Invalid wallet session");
  return { ...base, backendAuthToken: token, principal: { wallet: session.wallet, scope: null }, assertActive: async () => {
    const active = await fetch(`${base.backendUrl!.replace(/\/$/, "")}/v1/auth/session`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!active.ok) throw new AuthorizationError("Wallet session expired. Sign in again.");
  } };
}

export async function authorizeMandate(context: ChainPayMcpContext, address: string) {
  const principal = context.principal;
  if (!principal) throw new AuthorizationError("Verified wallet or scoped connection required");
  if (principal.scope && !principal.scope.mandates.includes(address)) throw new AuthorizationError("Mandate is outside this connection's scope");
  const mandate = await context.client.getMandate(address);
  if (!mandate || mandate.owner !== principal.wallet) throw new AuthorizationError("Mandate is not owned by this session");
  if (principal.scope && principal.scope.agents[address] !== mandate.approvedAgent) throw new AuthorizationError("Mandate agent changed. Reconnect to authorize the current agent.");
  return mandate;
}

export async function authorizeTool(context: ChainPayMcpContext, name: string, args: Record<string, unknown>) {
  if (PUBLIC_TOOLS.has(name) && !context.principal) return;
  const principal = context.principal;
  if (!principal) throw new AuthorizationError("Sign in with a wallet session or reconnect with a scoped connection");
  await context.assertActive?.();
  if (principal.scope && (!principal.scope.tools.includes(name) || OWNER_TOOLS.has(name))) throw new AuthorizationError("Tool is not permitted by this connection");
  for (const field of ["owner", "wallet", "ownerWallet"]) {
    if (args[field] !== undefined && args[field] !== principal.wallet) throw new AuthorizationError("Wallet differs from verified owner");
  }
  if (["list_mandates", "find_compatible_mandate", "create_mandate"].includes(name)) args.owner = principal.wallet;
  let address = name === "get_mandate" && typeof args.address === "string" ? args.address : typeof args.mandate === "string" ? args.mandate : typeof args.mandateAddress === "string" ? args.mandateAddress : undefined;
  if (!address && typeof args.receiptAddress === "string") {
    const receipt = await context.client.getPayment(args.receiptAddress);
    if (!receipt) throw new AuthorizationError("Receipt unavailable");
    address = receipt.mandate;
  }
  if (address) {
    const mandate = await authorizeMandate(context, address);
    context.agentAddress = mandate.approvedAgent;
    if (args.agent !== undefined && args.agent !== mandate.approvedAgent) throw new AuthorizationError("Agent differs from approved mandate agent");
  } else if (!PUBLIC_TOOLS.has(name) && !["list_mandates", "find_compatible_mandate", "create_mandate", "create_demo_payment_request", "quote_payment_request", "wait_for_payment"].includes(name)) {
    throw new AuthorizationError("An explicit owned mandate is required");
  }
}
