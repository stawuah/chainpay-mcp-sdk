import type { IncomingMessage } from "node:http";
import type { Mandate } from "@chainpayhq/sdk";
import type { ChainPayMcpContext } from "./tools/context.js";
import type { McpConnectionRegistry } from "./connections.js";

/**
 * `cards` (optional, additive) lists the 64-hex card ids an agent connection
 * may act on. A connection may be cards-only (empty `mandates`).
 */
export type ConnectionScope = { version: 1; mandates: string[]; tools: string[]; agents: Record<string, string>; cards?: string[] };
export type Principal = { wallet: string; scope: ConnectionScope | null };
export class AuthorizationError extends Error {}
export const PUBLIC_TOOLS = new Set(["get_protocol_config", "get_asset", "get_supported_assets", "verify_payment_request"]);
const OWNER_TOOLS = new Set(["create_mandate", "update_mandate", "pause_mandate", "revoke_mandate", "prepare_token_accounts", "freeze_agent_card"]);
/** Card tools authorize against `scope.cards`, never against mandates (contracts.md §10). */
export const CARD_TOOLS = new Set(["prepare_agent_card", "request_card_checkout", "get_card_activity", "get_statement", "freeze_agent_card"]);
const CARD_ID = /^[0-9a-f]{64}$/;

export function parseScope(value: string): ConnectionScope {
  let scope: ConnectionScope;
  try { scope = JSON.parse(value) as ConnectionScope; } catch { throw new AuthorizationError("Legacy Unscoped connection. Reconnect and select a mandate and permitted tools."); }
  const cards = scope && typeof scope === "object" ? scope.cards : undefined;
  if (cards !== undefined && (!Array.isArray(cards) || cards.length > 20 || !cards.every(v => typeof v === "string" && CARD_ID.test(v)))) throw new AuthorizationError("Invalid connection scope. Reconnect with explicit permissions.");
  const hasCards = Array.isArray(cards) && cards.length > 0;
  if (!scope || typeof scope !== "object" || scope.version !== 1 || !Array.isArray(scope.mandates) || (!scope.mandates.length && !hasCards) || scope.mandates.length > 20 || !scope.mandates.every(v => typeof v === "string") || !Array.isArray(scope.tools) || !scope.tools.length || scope.tools.length > 30 || !scope.tools.every(v => typeof v === "string") || !scope.agents || typeof scope.agents !== "object" || Array.isArray(scope.agents)) throw new AuthorizationError("Invalid connection scope. Reconnect with explicit permissions.");
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

/**
 * Whether a scoped connection may see this mandate at all. The scope pins the
 * agent that was approved when the owner connected; a mandate whose agent has
 * since changed stays hidden until the owner reconnects. Every list-shaped read
 * (list_mandates, find_compatible_mandate, get_spend_overview, list_receipts,
 * export_receipts)
 * must apply this same test, so they never disagree about what exists.
 */
export function mandateInScope(context: ChainPayMcpContext): (mandate: Mandate) => boolean {
  const scope = context.principal?.scope;
  if (!scope) return () => true;
  return (mandate) => scope.mandates.includes(mandate.address) && scope.agents[mandate.address] === mandate.approvedAgent;
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
  if (CARD_TOOLS.has(name)) return authorizeCardTool(principal, name, args);
  if (["list_mandates", "find_compatible_mandate", "create_mandate", "prepare_token_accounts", "get_spend_overview", "list_receipts", "export_receipts"].includes(name)) args.owner = principal.wallet;
  // Existing-operation resume is authorized again by Axum against the stored
  // owner and mandate. It never prepares or signs a new payment.
  if (["execute_x402_payment", "execute_crossmint_payment", "get_crossmint_payment"].includes(name) && typeof args.paymentId === "string" && /^payment_/.test(args.paymentId)) return;
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
  } else if (!PUBLIC_TOOLS.has(name) && !["list_mandates", "find_compatible_mandate", "create_mandate", "prepare_token_accounts", "create_demo_payment_request", "quote_payment_request", "wait_for_payment", "get_spend_overview", "list_receipts", "export_receipts"].includes(name)) {
    throw new AuthorizationError("An explicit owned mandate is required");
  }
}

/**
 * Card tools. Scoped connections reach only the cards listed in their scope;
 * owner sessions reach their own cards (Axum re-checks ownership).
 * request_card_checkout needs an agent connection: an owner session has no
 * agent identity to bind the checkout to.
 */
function authorizeCardTool(principal: Principal, name: string, args: Record<string, unknown>) {
  if (name === "prepare_agent_card") return;
  const cardId = args.cardId;
  if (typeof cardId !== "string" || !CARD_ID.test(cardId)) throw new AuthorizationError("A card id (64 lowercase hex characters) is required");
  if (name === "request_card_checkout" && !principal.scope) throw new AuthorizationError("Card checkout needs an agent connection scoped to this card");
  if (principal.scope && !(principal.scope.cards ?? []).includes(cardId)) throw new AuthorizationError("Card is outside this connection's scope");
}

/**
 * Before a connection is scoped to a card, confirm the calling owner session
 * owns it. Axum's GET /v1/cards/{cardId} is owner-scoped, so only a 200 counts;
 * anything else (404, 401, backend down) refuses the scope.
 */
export async function authorizeOwnedCard(context: ChainPayMcpContext, cardId: string): Promise<void> {
  if (!CARD_ID.test(cardId)) throw new AuthorizationError("Invalid card id");
  if (!context.principal || context.principal.scope) throw new AuthorizationError("Owner session required to scope a card");
  if (!context.backendUrl || !context.backendAuthToken) throw new AuthorizationError("Card ownership can't be checked right now");
  let ok = false;
  try {
    const response = await fetch(`${context.backendUrl.replace(/\/$/, "")}/v1/cards/${cardId}`, { headers: { Authorization: `Bearer ${context.backendAuthToken}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    ok = response.status === 200;
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthorizationError("Card is not owned by this session");
}
