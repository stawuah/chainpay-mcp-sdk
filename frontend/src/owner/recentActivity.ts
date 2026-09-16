import type { AgentInboxItem } from "./runtime";
import type { Operation } from "../settlement";

export type RecentActivityRow = {
  id: string;
  source: "inbox" | "settlement";
  label: string;
  status: string;
  receiptAddress?: string;
};

function inboxReceiptAddress(item: AgentInboxItem): string | undefined {
  if (item.outcome?.receiptAddress) return item.outcome.receiptAddress;
  const approvalReceipt = item.approval?.receiptAddress;
  return typeof approvalReceipt === "string" ? approvalReceipt : undefined;
}

export function buildRecentActivity(inbox: AgentInboxItem[], settlements: Operation[]): RecentActivityRow[] {
  const seen = new Set<string>();
  const rows: RecentActivityRow[] = [];

  const inboxRows = [...inbox]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((item) => {
      const receiptAddress = inboxReceiptAddress(item);
      const key = receiptAddress ?? `inbox:${item.id}`;
      return {
        key,
        row: {
          id: item.id,
          source: "inbox" as const,
          label: item.title || item.prompt || "Agent request",
          status: item.stage,
          receiptAddress,
        },
      };
    });

  for (const entry of inboxRows) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    rows.push(entry.row);
  }

  for (const operation of [...settlements].reverse()) {
    const receiptAddress = operation.result?.receipt_address;
    const key = receiptAddress ?? `settlement:${operation.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: operation.id,
      source: "settlement",
      label: receiptAddress ? `Receipt ${receiptAddress.slice(0, 4)}…${receiptAddress.slice(-4)}` : `Settlement ${operation.id.slice(0, 16)}…`,
      status: operation.status,
      receiptAddress,
    });
  }

  return rows.slice(0, 20);
}
