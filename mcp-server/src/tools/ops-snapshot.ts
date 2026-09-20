import { loadOpsSnapshot, receiptListFromSnapshot } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, toolResult, unsignedInteger } from "./common.js";

function scopedMandateFilter(context: ChainPayMcpContext, requested?: string): string[] | undefined {
  const scope = context.principal?.scope;
  if (requested) {
    if (scope && !scope.mandates.includes(requested)) return [];
    return [requested];
  }
  if (!scope) return undefined;
  return scope.mandates.filter((address) => scope.agents[address]);
}

export async function getSpendOverview(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const requested = args.mandate === undefined ? undefined : solanaAddress(args.mandate, "mandate");
  const snapshot = await loadOpsSnapshot(context.client, {
    owner,
    mandateFilter: scopedMandateFilter(context, requested),
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
  const limit = args.limit === undefined ? undefined : Number(unsignedInteger(args.limit, "limit"));
  const snapshot = await loadOpsSnapshot(context.client, {
    owner,
    mandateFilter: scopedMandateFilter(context, requested),
    receiptLimit: limit,
    appUrl: process.env.CHAINPAY_APP_URL,
  });
  return toolResult(receiptListFromSnapshot(snapshot));
}
