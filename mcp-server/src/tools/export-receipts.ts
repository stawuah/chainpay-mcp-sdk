import {
  assetLabel,
  receiptPolicy,
  receiptUrlForAddress,
  receiptsToCsv,
  type PaymentReceipt,
  type ReceiptCsvRow,
  type ReceiptPolicySource,
} from "@chainpayhq/sdk";
import { mandateInScope } from "../authorization.js";
import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, toolResult, unsignedInteger } from "./common.js";
import { receiptContext } from "./receipt-context.js";

const DEFAULT_EXPORT_LIMIT = 500;
const MAX_EXPORT_LIMIT = 1_000;

function exportLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_EXPORT_LIMIT;
  const limit = unsignedInteger(value, "limit");
  if (limit === 0n) throw new Error("limit must be at least 1");
  return Number(limit > BigInt(MAX_EXPORT_LIMIT) ? BigInt(MAX_EXPORT_LIMIT) : limit);
}

/**
 * Owner-scoped receipt export as one CSV. Same visibility as list_receipts:
 * the session's wallet, narrowed to in-scope mandates for a scoped connection.
 */
export async function exportReceipts(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const owner = solanaAddress(args.owner, "owner");
  const requested = args.mandate === undefined ? undefined : solanaAddress(args.mandate, "mandate");
  const limit = exportLimit(args.limit);
  const inScope = mandateInScope(context);
  const mandates = (await context.client.getMandatesByOwner(owner))
    .filter((mandate) => inScope(mandate) && (!requested || mandate.address === requested));
  const receipts: PaymentReceipt[] = (await Promise.all(
    mandates.map((mandate) => context.client.getPaymentsByMandate(mandate.address)),
  ))
    .flat()
    .sort((left, right) => (right.executedAtSlot > left.executedAtSlot ? 1 : right.executedAtSlot < left.executedAtSlot ? -1 : 0))
    .slice(0, limit);

  const decimalsByMint = new Map<string, number | null>();
  await Promise.all([...new Set(receipts.map((receipt) => receipt.mint))].map(async (mint) => {
    decimalsByMint.set(mint, await context.client.getMintDecimals(mint).catch(() => null));
  }));
  // Wall-clock time comes from the slot's block time. Unknown stays empty;
  // it is never estimated.
  const blockTimes = new Map<bigint, number | null>();
  await Promise.all([...new Set(receipts.map((receipt) => receipt.executedAtSlot))].map(async (slot) => {
    blockTimes.set(slot, await context.client.connection.getBlockTime(Number(slot)).catch(() => null));
  }));

  const appUrl = process.env.CHAINPAY_APP_URL;
  const rows: ReceiptCsvRow[] = await Promise.all(receipts.map(async (receipt) => {
    const extra = await receiptContext(context, receipt);
    const verifyUrl = receiptUrlForAddress(receipt.address, appUrl);
    return {
      receipt,
      decimals: decimalsByMint.get(receipt.mint) ?? null,
      // An unknown mint keeps its address in the Token column, not a generic word.
      symbol: assetLabel(receipt.mint, receipt.mint),
      blockTime: blockTimes.get(receipt.executedAtSlot) ?? null,
      policy: receiptPolicy(receipt, extra.relayPolicy),
      ...(extra.purpose ? { purpose: extra.purpose } : {}),
      ...(verifyUrl ? { verifyUrl } : {}),
    };
  }));

  const limitsSources: Record<ReceiptPolicySource, number> = { "on-chain": 0, "relay-observed": 0, "not-recorded": 0 };
  for (const row of rows) limitsSources[row.policy?.source ?? "not-recorded"] += 1;
  return toolResult({
    kind: "receipt_export",
    owner,
    format: "text/csv",
    filename: `chainpay-receipts-${new Date().toISOString().slice(0, 10)}.csv`,
    rowCount: rows.length,
    limitsSources,
    csv: receiptsToCsv(rows),
  });
}
