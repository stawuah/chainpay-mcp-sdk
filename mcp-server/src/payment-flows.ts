import { randomBytes } from "node:crypto";
import type { PaymentFlowRecord } from "./connections.js";
import type { ChainPayMcpContext } from "./tools/context.js";
import type { PaymentWidgetView } from "./widget/view.js";

/**
 * A live payment card: the agent drives the payment with its own authority and
 * each tool records the step it really reached here. The inline card and the
 * /pay/<flowId> page only read it. A flow holds what the card shows and
 * nothing else: no tokens, no keys, no request signature.
 */
export type PaymentFlowStore = {
  putFlow(record: PaymentFlowRecord): Promise<void>;
  getFlow(flowId: string, now?: number): Promise<PaymentFlowRecord | undefined>;
};

export const FLOW_TTL_MS = 24 * 60 * 60 * 1000;
const FLOW_ID = /^[A-Za-z0-9_-]{22}$/;

export function isFlowId(value: unknown): value is string {
  return typeof value === "string" && FLOW_ID.test(value);
}

/** Public origin of this MCP server, used for the watch link and the card's CSP. */
export function publicMcpOrigin(): string {
  const configured = process.env.CHAINPAY_PUBLIC_MCP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the hosted default.
    }
  }
  return "https://chainpay-mcp.vercel.app";
}

export function flowUrl(flowId: string): string {
  return `${publicMcpOrigin()}/pay/${flowId}`;
}

/** Only the fields a viewer of the card may see. */
function publicView(view: PaymentWidgetView): Record<string, unknown> {
  const { mandate: _mandate, recipient: _recipient, ...visible } = view;
  return visible;
}

export async function createFlow(context: ChainPayMcpContext, view: PaymentWidgetView): Promise<string | undefined> {
  const wallet = context.principal?.wallet;
  if (!context.flows || !wallet) return undefined;
  const flowId = randomBytes(16).toString("base64url");
  const now = Date.now();
  await context.flows.putFlow({
    flowId,
    wallet,
    view: publicView({ ...view, flowId, flowUrl: flowUrl(flowId) }),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + FLOW_TTL_MS,
  });
  return flowId;
}

/**
 * Refuses a flowId that belongs to another wallet. An unknown or expired card,
 * or storage being unavailable, never blocks a payment: the card just stops
 * updating, and recordFlow re-checks the owner before every write.
 */
export async function assertFlowOwner(context: ChainPayMcpContext, flowId: string): Promise<void> {
  if (!context.flows) return;
  const flow = await context.flows.getFlow(flowId).catch(() => undefined);
  if (flow && flow.wallet !== context.principal?.wallet) throw new Error("This payment card belongs to another wallet");
}

/**
 * Best effort: a storage failure is logged and never changes a payment. Fields
 * the new view can't prove (merchant, product) are kept from the earlier one.
 */
export async function recordFlow(context: ChainPayMcpContext, flowId: string | undefined, view: Partial<PaymentWidgetView>): Promise<void> {
  if (!flowId || !context.flows || !context.principal?.wallet) return;
  try {
    const existing = await context.flows.getFlow(flowId);
    if (!existing || existing.wallet !== context.principal.wallet) return;
    const merged: Record<string, unknown> = { ...existing.view };
    for (const [key, value] of Object.entries(publicView(view as PaymentWidgetView))) {
      if (value !== undefined) merged[key] = value;
    }
    if (view.limits) merged.limits = { ...(existing.view.limits as object | undefined), ...view.limits };
    if (merged.state !== "ready" && merged.limits && typeof merged.limits === "object") {
      if (merged.state === "settled" || merged.state === "blocked") delete (merged.limits as Record<string, unknown>).after;
    }
    await context.flows.putFlow({ ...existing, view: merged, updatedAt: Date.now() });
  } catch (error) {
    console.error(`[chainpay] payment card update skipped: ${error instanceof Error ? error.name : "unknown"}`);
  }
}
