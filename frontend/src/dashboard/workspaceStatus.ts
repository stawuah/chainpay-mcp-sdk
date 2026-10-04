import { statusFor, type StatusProps } from "../ui/workspace/Status";
import type { AgentConnection } from "../owner/runtime";
import { connectionIsLive } from "../owner/purchaseCard";

/*
  Domain wording for the shared Status component. Each domain keeps its own
  words; the tone and icon come from the one meaning table.
*/
export function requestStageStatus(stage: string, options: { blockedByCheckout?: boolean } = {}): StatusProps {
  if (options.blockedByCheckout) return statusFor("review", "Blocked");
  switch (stage) {
    case "waiting_for_approval": return statusFor("pending", "Waiting for approval");
    case "needs_details": return statusFor("review", "Details needed");
    case "blocked": return statusFor("review", "Blocked");
    case "approved": return statusFor("settled", "Approved");
    case "receipt_ready": return statusFor("settled", "Receipt ready");
    case "received":
    case "understood": return statusFor("pending", "In progress");
    default: return statusFor("unknown", stage ? stage.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()) : "Unknown");
  }
}

/** Local settlement operations (pending-settlement store). */
export function settlementStatus(status: string): StatusProps {
  switch (status) {
    case "confirmed": return statusFor("settled", "Settled");
    case "failed":
    case "rejected": return statusFor("failed", "Failed");
    case "pending":
    case "submitted":
    case "signing": return statusFor("pending", "Pending");
    default: return statusFor("unknown", status ? status.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()) : "Unknown");
  }
}

export function activityStatus(row: { source: "inbox" | "settlement"; status: string }): StatusProps {
  return row.source === "inbox" ? requestStageStatus(row.status) : settlementStatus(row.status);
}

export function connectionStatusProps(connection: Pick<AgentConnection, "lastSeenAt">): StatusProps {
  return connectionIsLive(connection.lastSeenAt)
    ? statusFor("active", "Connected")
    : statusFor("pending", "Waiting for first call");
}
