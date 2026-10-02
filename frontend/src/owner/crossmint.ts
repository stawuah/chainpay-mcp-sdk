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

/** Crossmint's order status as the receipt's seller statement. */
export function crossmintSellerStatement(request: CrossmintRequest): SellerStatementState {
  return {
    status: "crossmint",
    phase: request.phase ?? "",
    refunded: Boolean(request.refunded),
    ...(request.reportedAt ? { reportedAt: request.reportedAt } : {}),
  };
}
