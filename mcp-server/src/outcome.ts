export type NormalizedOutcome = {
  kind: "mandate_approval_required" | "token_account_approval_required" | "payment_approval_required" | "payment_settled" | "payment_blocked" | "details_required" | "payment_pending";
  receiptAddress?: string;
  signature?: string;
  status?: string;
  paymentId?: string;
  resourceStatus?: string;
  receiptUrl?: string;
};

const BLOCKED_ACTIONS = new Set([
  "rejected_by_preflight",
  "x402_rejected_by_preflight",
  "managed_payment_failed",
  "managed_backend_rejected",
  "payment_failed",
  "x402_payment_failed",
  "requirements_blocked",
  "payment_request_blocked",
  "payment_request_rejected",
  "backend_rejected",
  "backend_not_finalized",
  "backend_required",
  "agent_identity_mismatch",
  "x402_settled_resource_rejected",
  "x402_resource_rejected",
  "delegated_signature_rejected",
]);

const SETTLED_ACTIONS = new Set([
  "managed_payment_settled",
  "backend_relayed",
  "payment_confirmed",
  "x402_verified",
]);

const PENDING_ACTIONS = new Set([
  "payment_pending",
  "x402_payment_pending",
]);

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function receiptUrlForAddress(receiptAddress?: string): string | undefined {
  if (!receiptAddress) return undefined;
  const appUrl = process.env.CHAINPAY_APP_URL?.trim().replace(/\/$/, "");
  if (!appUrl) return undefined;
  return `${appUrl}/verify/${encodeURIComponent(receiptAddress)}`;
}

export function normalizeToolOutcome(result: unknown): NormalizedOutcome | undefined {
  if (!result || typeof result !== "object") return undefined;
  const response = result as { structuredContent?: unknown; isError?: unknown };
  const structured = response.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const data = structured as Record<string, unknown>;
  const payment = nestedRecord(data.payment);
  const settlement = nestedRecord(data.settlement);
  const action = typeof data.action === "string" ? data.action : "";
  const receiptAddress = pickString(
    data.receiptAddress,
    data.receipt_address,
    payment?.receipt_address,
    settlement?.receipt_address,
  );
  const signature = pickString(
    data.signature,
    payment?.signature,
    settlement?.signature,
  );
  const status = pickString(data.status, payment?.status, settlement?.status);
  const paymentId = pickString(data.paymentId, data.payment_id, payment?.payment_id, settlement?.payment_id);
  const resourceStatus = pickString(
    data.resourceStatus,
    data.resource_status,
    data.httpStatus !== undefined ? String(data.httpStatus) : undefined,
  );
  const receiptUrl = receiptUrlForAddress(receiptAddress);
  const base = { receiptAddress, signature, status, paymentId, resourceStatus, ...(receiptUrl ? { receiptUrl } : {}) };

  if (action === "owner_wallet_signature_required") {
    return { kind: "mandate_approval_required", ...base };
  }
  if (action === "token_account_signature_required") {
    return { kind: "token_account_approval_required", ...base };
  }
  if (action === "agent_signature_required" || action === "x402_agent_signature_required") {
    if (response.isError === true) {
      return { kind: "payment_blocked", ...base, status: status ?? "blocked" };
    }
    return { kind: "payment_approval_required", ...base };
  }
  if (action === "details_required" || status === "needs_details") {
    return { kind: "details_required", ...base };
  }
  if (
    response.isError === true ||
    status === "failed" ||
    BLOCKED_ACTIONS.has(action)
  ) {
    return { kind: "payment_blocked", ...base };
  }
  if (PENDING_ACTIONS.has(action)) {
    return { kind: "payment_pending", ...base, status: status ?? "pending" };
  }
  if (action === "payment_terminal") {
    if (status === "confirmed" && signature && receiptAddress) {
      return { kind: "payment_settled", ...base };
    }
    if (status === "failed") {
      return { kind: "payment_blocked", ...base };
    }
    return { kind: "payment_pending", ...base, status: status ?? "pending" };
  }
  if (
    SETTLED_ACTIONS.has(action) ||
    ((action === "backend_relayed" || action === "payment_confirmed") && status === "confirmed" && signature && receiptAddress)
  ) {
    if (status === "confirmed" && signature && receiptAddress) {
      return { kind: "payment_settled", ...base };
    }
    return undefined;
  }
  if (action === "managed_payment_settled" && signature && receiptAddress) {
    return { kind: "payment_settled", ...base, status: status ?? "confirmed" };
  }
  return undefined;
}
