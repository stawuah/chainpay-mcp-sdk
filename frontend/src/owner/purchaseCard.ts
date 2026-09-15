import type { Mandate } from "@chainpay/sdk";
import type { AgentCheck, AgentInboxItem, AgentInboxStage, StablecoinOption } from "./runtime";
import { formatTokenAmount } from "./amounts";
import { shortAddress } from "../ui/marks";

export type PurchaseAttentionStage =
  | "needs_details"
  | "blocked"
  | "waiting_for_approval"
  | "receipt_ready"
  | "ready"
  | "in_progress"
  | "other";

export type PurchaseCardView = {
  id: string;
  description: string;
  amountLabel: string;
  tokenLabel: string;
  recipientLabel: string;
  status: PurchaseAttentionStage;
  statusLabel: string;
  limitDetail?: string;
  checks: AgentCheck[];
  showChecks: boolean;
};

export type InboxAttentionCounts = {
  waiting: number;
  needsDetails: number;
  blocked: number;
  receiptReady: number;
  pendingTotal: number;
};

function purchaseDescription(item: AgentInboxItem): string {
  const title = item.title?.trim();
  if (title && !/^demo payment request$/i.test(title)) return title;
  const prompt = item.prompt?.trim();
  if (prompt && prompt.length <= 160) return prompt;
  if (item.source === "invoice") return "Invoice or document request";
  return "Purchase description unavailable";
}

function tokenLabelForMint(mint: string | undefined, stablecoinOptions: StablecoinOption[]): string {
  if (!mint) return "token";
  return stablecoinOptions.find((option) => option.mint === mint)?.label ?? "token";
}

function formatPaymentAmount(
  amount: string | undefined,
  mint: string | undefined,
  mandate: Mandate | null | undefined,
  mandateDecimals: number | null,
): string {
  if (!amount) return "—";
  // `mandateDecimals` describes the selected mandate's mint, not necessarily the
  // mint this payment is denominated in. Applying 6 to a 9-decimal token — or
  // the reverse — misstates the headline amount by 1000x while still labelling
  // it with the payment's own token. Only apply the decimals when the two mints
  // are the same; otherwise keep the exact integer and say what it is.
  const mintsMatch = Boolean(mint) && Boolean(mandate?.allowedMint) && mint === mandate?.allowedMint;
  if (!mintsMatch || mandateDecimals === null) return `${amount} base units`;
  try {
    return formatTokenAmount(BigInt(amount), mandateDecimals);
  } catch {
    return `${amount} base units`;
  }
}

function limitDetailFromRequirements(item: AgentInboxItem, mandate: Mandate | null | undefined): string | undefined {
  const limitsCheck = item.requirements?.checks.find((check) => check.key === "limits");
  if (limitsCheck?.status === "fail" && limitsCheck.detail) return limitsCheck.detail;
  if (!mandate) return undefined;
  return `This permission allows up to ${mandate.maxPerPayment.toString()} base units per payment and ${mandate.totalLimit.toString()} base units total.`;
}

export function purchaseAttentionStage(stage: AgentInboxStage): PurchaseAttentionStage {
  switch (stage) {
    case "needs_details":
      return "needs_details";
    case "blocked":
      return "blocked";
    case "waiting_for_approval":
      return "waiting_for_approval";
    case "receipt_ready":
      return "receipt_ready";
    case "policy_checked":
    case "mandate_prepared":
      return "ready";
    case "received":
    case "understood":
      return "in_progress";
    default:
      return "other";
  }
}

export function purchaseStatusLabel(stage: PurchaseAttentionStage): string {
  switch (stage) {
    case "needs_details":
      return "Details needed";
    case "blocked":
      return "Blocked";
    case "waiting_for_approval":
      return "Waiting for wallet approval";
    case "receipt_ready":
      return "Receipt ready";
    case "ready":
      return "Ready for approval";
    case "in_progress":
      return "Checking request";
    default:
      return "In progress";
  }
}

export function inboxAttentionCounts(inbox: AgentInboxItem[]): InboxAttentionCounts {
  const waiting = inbox.filter((item) => item.stage === "waiting_for_approval").length;
  const needsDetails = inbox.filter((item) => item.stage === "needs_details").length;
  const blocked = inbox.filter((item) => item.stage === "blocked").length;
  const receiptReady = inbox.filter((item) => item.stage === "receipt_ready").length;
  return {
    waiting,
    needsDetails,
    blocked,
    receiptReady,
    pendingTotal: waiting + needsDetails + blocked,
  };
}

export function purchaseCardFromInboxItem(
  item: AgentInboxItem,
  options: {
    stablecoinOptions: StablecoinOption[];
    mandateDecimals: number | null;
    mandate?: Mandate | null;
  },
): PurchaseCardView {
  const payment = item.approval?.kind === "payment" && item.approval.payment && typeof item.approval.payment === "object"
    ? item.approval.payment as Record<string, unknown>
    : undefined;
  const mint = typeof payment?.mint === "string" ? payment.mint : undefined;
  const amount = typeof payment?.amount === "string" ? payment.amount : undefined;
  const recipient = typeof payment?.recipient === "string" ? payment.recipient : undefined;
  const tokenLabel = tokenLabelForMint(mint, options.stablecoinOptions);
  const status = purchaseAttentionStage(item.stage);

  return {
    id: item.id,
    description: purchaseDescription(item),
    amountLabel: formatPaymentAmount(amount, mint, options.mandate, options.mandateDecimals),
    tokenLabel,
    recipientLabel: recipient ? shortAddress(recipient) : "—",
    status,
    statusLabel: purchaseStatusLabel(status),
    limitDetail: limitDetailFromRequirements(item, options.mandate),
    checks: item.requirements?.checks ?? [],
    showChecks: Boolean(item.requirements && item.requirements.checks.length > 0),
  };
}

export function attentionInboxItems(inbox: AgentInboxItem[]): AgentInboxItem[] {
  return inbox.filter((item) => (
    item.stage === "waiting_for_approval"
    || item.stage === "needs_details"
    || item.stage === "blocked"
    || item.stage === "receipt_ready"
    || item.stage === "policy_checked"
  ));
}

export function preparedRequestReceiptAddresses(inbox: AgentInboxItem[]): Set<string> {
  return new Set(
    inbox
      .map((item) => item.outcome?.receiptAddress)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

export function connectionIsLive(lastSeenAt: string | null): boolean {
  return Boolean(lastSeenAt);
}
