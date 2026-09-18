import { createHash } from "node:crypto";
import type { ChainPayMcpContext } from "./context.js";

/**
 * The relay sleeps when idle and a cold start costs more than a few seconds, so
 * a submission is given long enough to survive one. Below this the timeout fires
 * on a healthy relay that is merely waking, and a payment the owner approved is
 * abandoned before it is ever sent.
 */
const SUBMIT_TIMEOUT_MS = 90_000;

/**
 * Relay a settlement and report the outcome honestly when no response arrives.
 *
 * A transport failure leaves the outcome genuinely unknown: the request may have
 * settled, or may never have left this process. Both are reported the same way
 * on purpose, because the owner must not be asked to approve a replacement for a
 * payment that might already exist.
 *
 * What it must never do is claim the payment was submitted. The relay records a
 * payment only once it has one, so a caller told "submitted" polls an id that
 * may not exist and sees nothing but 404 forever, with no signal that anything
 * is wrong. The status here says the outcome is unknown and names the operations
 * that resolve it, so the owner can recover the original approval or establish
 * that it never started.
 */
export async function submitSettlement(context: ChainPayMcpContext, endpoint: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body)) as { idempotency_key: string };
  const wallet = context.principal?.wallet;
  try { return await fetch(endpoint, { ...init, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) }); }
  catch {
    if (!wallet) throw new Error("Submission outcome is unknown; the authenticated owner must reconcile the original idempotency key");
    const paymentId = `payment_${createHash("sha256").update(`${wallet}:${body.idempotency_key}`).digest("hex")}`;
    return Response.json({
      action: "payment_outcome_unknown",
      status: "unknown",
      payment_id: paymentId,
      error: "No response from the relay, so this payment may have settled or may never have been sent. Check its status: if the relay has no record of it the request never started and can be cancelled, and if it does, recover it with the original signed bytes. Do not approve a replacement.",
      continuation: { tool: "wait_for_payment", arguments: { paymentId } },
    });
  }
}
