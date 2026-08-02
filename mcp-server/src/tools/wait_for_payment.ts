import type { ChainPayMcpContext } from "./context.js";
import { requiredString, toolResult, unsignedInteger } from "./common.js";

const TERMINAL_STATUSES = new Set(["confirmed", "failed"]);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForPayment(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  if (!context.backendUrl) {
    return toolResult({
      action: "backend_required",
      message: "CHAINPAY_BACKEND_URL must be configured to wait for backend payment status.",
    }, true);
  }

  const paymentId = requiredString(args.paymentId, "paymentId");
  const timeoutMs = Number(args.timeoutMs === undefined ? 30_000n : unsignedInteger(args.timeoutMs, "timeoutMs"));
  const pollMs = Number(args.pollMs === undefined ? 500n : unsignedInteger(args.pollMs, "pollMs"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
    throw new Error("timeoutMs must be between 0 and 120000");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 10_000) {
    throw new Error("pollMs must be between 50 and 10000");
  }

  const endpoint = `${context.backendUrl.replace(/\/$/, "")}/v1/payments/${encodeURIComponent(paymentId)}`;
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> | undefined;
  do {
    const response = await fetch(endpoint, {
      headers: context.backendAuthToken
        ? { Authorization: `Bearer ${context.backendAuthToken}` }
        : undefined,
    });
    if (response.ok) {
      latest = await response.json() as Record<string, unknown>;
      if (TERMINAL_STATUSES.has(String(latest.status))) {
        return toolResult({ action: "payment_terminal", ...latest }, latest.status === "failed");
      }
    } else if (response.status !== 404) {
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      return toolResult({ action: "backend_rejected", ...payload }, true);
    }

    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return toolResult({
    action: "payment_pending",
    paymentId,
    payment: latest,
    timeoutMs,
  });
}
