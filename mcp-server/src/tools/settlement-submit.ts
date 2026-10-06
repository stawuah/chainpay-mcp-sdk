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
  catch (cause) {
    // The reason is the only thing that distinguishes a relay too slow to answer
    // from one that was never reached, and discarding it leaves a stranded
    // payment with no way to tell those apart. AbortSignal.timeout raises
    // TimeoutError, so a timeout names itself.
    const transport = describeTransportFailure(cause);
    console.error(`[chainpay] settlement submission failed: ${transport}`);
    if (!wallet) throw new Error(`Submission outcome is unknown (${transport}); the authenticated owner must reconcile the original idempotency key`);
    const paymentId = relayPaymentId(wallet, body.idempotency_key);
    return Response.json({
      action: "payment_outcome_unknown",
      status: "unknown",
      payment_id: paymentId,
      transport_error: transport,
      error: `No response from the relay (${transport}), so this payment may have settled or may never have been sent. Check its status: if the relay has no record of it the request never started and can be cancelled, and if it does, recover it with the original signed bytes. Do not approve a replacement.`,
      continuation: { tool: "wait_for_payment", arguments: { paymentId } },
    });
  }
}

/**
 * A short reason for a failed submission, safe to hand to the browser.
 *
 * Only the error's own name and message are used: the endpoint and the request
 * carry the owner's authorization and signed bytes, and neither belongs in a
 * response or a log line.
 */
function describeTransportFailure(cause: unknown): string {
  if (cause instanceof Error) {
    const name = cause.name === "TimeoutError" ? `timed out after ${SUBMIT_TIMEOUT_MS / 1000}s` : cause.name;
    return cause.message && cause.name !== "TimeoutError" ? `${name}: ${cause.message}` : name;
  }
  return "unknown transport failure";
}

/**
 * The relay's payment id for a settlement: `deterministic_id("payment", …)` over
 * the owner-scoped idempotency key, as `backend/src/server_recovery.rs` derives it.
 */
export function relayPaymentId(wallet: string, idempotencyKey: string): string {
  return `payment_${createHash("sha256").update(`${wallet}:${idempotencyKey}`).digest("hex")}`;
}

/**
 * Relay answers that prove a settlement was refused before broadcast. The same
 * set as the dashboard (`frontend/src/owner/runtime.ts`). Every other non-OK
 * answer (5xx, 409, a proxy or gateway error) can arrive after the relay sent
 * the transaction, so it must never be reported as a rejection.
 */
const RELAY_REJECTED_BEFORE_BROADCAST = new Set([400, 401, 403, 404, 422]);

export function relayRejectedBeforeBroadcast(status: number): boolean {
  return RELAY_REJECTED_BEFORE_BROADCAST.has(status);
}

/**
 * The settlement payload for a non-OK relay answer that is not a pre-broadcast
 * rejection: status unknown, the deterministic payment id to resume with, and
 * an explicit instruction not to retry. Callers treat it like a pending payment.
 */
export function relayOutcomeUnknown(
  context: ChainPayMcpContext,
  idempotencyKey: string,
  httpStatus: number,
  relayPayload: Record<string, unknown>,
): Record<string, unknown> {
  const wallet = context.principal?.wallet;
  const paymentId = wallet ? relayPaymentId(wallet, idempotencyKey) : undefined;
  return {
    status: "unknown",
    ...(paymentId ? { payment_id: paymentId } : { idempotency_key: idempotencyKey }),
    httpStatus,
    ...(typeof relayPayload.error === "string" ? { relayError: relayPayload.error } : {}),
    ...(paymentId ? { continuation: { tool: "wait_for_payment", arguments: { paymentId } } } : {}),
    message: `The relay answered HTTP ${httpStatus}, so this payment may already have been sent. `
      + (paymentId ? "Check it with this paymentId. " : "The authenticated owner must reconcile the original idempotency key. ")
      + "Do not retry, sign, or approve a replacement.",
  };
}
