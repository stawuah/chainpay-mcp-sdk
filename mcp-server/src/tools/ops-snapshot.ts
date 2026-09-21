import { loadOpsSnapshot, receiptListFromSnapshot, type Mandate } from "@chainpay/sdk";
import { mandateInScope } from "../authorization.js";
import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, toolResult, unsignedInteger } from "./common.js";

// authorizeTool has already proved a requested mandate is owned, in scope and
// still bound to the approved agent. Without one, the snapshot shows exactly
// the mandates list_mandates would.
function mandateFilter(context: ChainPayMcpContext, requested?: string): (mandate: Mandate) => boolean {
  const inScope = mandateInScope(context);
  if (!requested) return inScope;
  return (mandate) => mandate.address === requested && inScope(mandate);
}

function receiptLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const limit = unsignedInteger(value, "limit");
  if (limit === 0n) throw new Error("limit must be at least 1");
  return Number(limit);
}

export async function getSpendOverview(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const requested = args.mandate === undefined ? undefined : solanaAddress(args.mandate, "mandate");
  const snapshot = await loadOpsSnapshot(context.client, {
    owner,
    mandateFilter: mandateFilter(context, requested),
    appUrl: process.env.CHAINPAY_APP_URL,
  });
  return toolResult(snapshot);
}

export async function listReceipts(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const requested = args.mandate === undefined ? undefined : solanaAddress(args.mandate, "mandate");
  const snapshot = await loadOpsSnapshot(context.client, {
    owner,
    mandateFilter: mandateFilter(context, requested),
    receiptLimit: receiptLimit(args.limit),
    appUrl: process.env.CHAINPAY_APP_URL,
  });
  return toolResult(receiptListFromSnapshot(snapshot));
}
