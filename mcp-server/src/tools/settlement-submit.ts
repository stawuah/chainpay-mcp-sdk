import { createHash } from "node:crypto";
import type { ChainPayMcpContext } from "./context.js";

/** Transport failure carries a deterministic status reference, never a new invoice. */
export async function submitSettlement(context: ChainPayMcpContext, endpoint: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body)) as { idempotency_key: string };
  const wallet = context.principal?.wallet;
  try { return await fetch(endpoint, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch {
    if (!wallet) throw new Error("Submission outcome is unknown; the authenticated owner must reconcile the original idempotency key");
    const paymentId = `payment_${createHash("sha256").update(`${wallet}:${body.idempotency_key}`).digest("hex")}`;
    return Response.json({ action: "payment_pending", status: "submitted", payment_id: paymentId, error: "Submission response was lost. Poll this payment_id; do not approve a replacement.", continuation: { tool: "wait_for_payment", arguments: { paymentId } } });
  }
}
