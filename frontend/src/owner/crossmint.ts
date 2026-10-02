import type { SellerStatementState } from "../receipts/model";
import type { AgentCheck, CrossmintRequest } from "./runtime";

/** Copy for a Crossmint order that cannot be paid. Every case says nothing was submitted. */
export const CROSSMINT_BLOCKED_COPY = {
  closed: "This Crossmint order no longer accepts payment. Nothing was submitted.",
  alreadyPaid: "This Crossmint order already has a payment. Nothing new was submitted.",
} as const;

/**
 * A quote that disagrees with the payment Crossmint prepared is a failed check,
 * never a warning to click through: the owner does not approve a mismatched amount.
 */
export function crossmintQuoteCheck(
  request: CrossmintRequest,
  quoted: string,
  paying: string,
): AgentCheck | undefined {
  if (request.quoteCheck !== "mismatch") return undefined;
  return {
    key: "crossmint_quote",
    label: "Crossmint quote",
    status: "fail",
    detail: `Crossmint quoted ${quoted}; this payment is ${paying}. Ask your agent for a new quote.`,
  };
}

/** Every reason a Crossmint order cannot be approved, as failed checks. */
export function crossmintBlockingChecks(request: CrossmintRequest, quoted: string, paying: string): AgentCheck[] {
  const checks: AgentCheck[] = [];
  const quote = crossmintQuoteCheck(request, quoted, paying);
  if (quote) checks.push(quote);
  if (request.blockedReason) {
    checks.push({
      key: "crossmint_order",
      label: "Crossmint order",
      status: "fail",
      detail: request.blockedReason === "closed" ? CROSSMINT_BLOCKED_COPY.closed : CROSSMINT_BLOCKED_COPY.alreadyPaid,
    });
  }
  return checks;
}

/** True when the owner must not be offered a wallet approval for this request. */
export function crossmintBlocksApproval(request: CrossmintRequest | undefined): boolean {
  return Boolean(request && (request.quoteCheck === "mismatch" || request.blockedReason));
}

/** Crossmint's order status as the receipt's seller statement. */
export function crossmintSellerStatement(request: CrossmintRequest): SellerStatementState {
  return {
    status: "crossmint",
    phase: request.phase ?? "",
    refunded: Boolean(request.refunded),
    ...(request.reportedAt ? { reportedAt: request.reportedAt } : {}),
  };
}
