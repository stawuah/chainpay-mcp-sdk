import type { Mandate, PaymentRequestPayload } from "@chainpayhq/sdk";
import type { ChainPayMcpContext } from "../tools/context.js";
import { formatTokenAmount, tokenLabel } from "../tools/token-amount.js";
import { receiptUrlForAddress } from "../outcome.js";
import { merchantDisplayName } from "./merchants.js";

/**
 * What the payment widget renders. Every field is derived from a tool result
 * or an on-chain read; the widget never advances a step on a timer. A field the
 * server cannot prove is left out, and the widget shows it as unavailable.
 */
export type PaymentWidgetState = "ready" | "paying" | "confirming" | "settled" | "blocked" | "signature" | "unknown";

export type PaymentWidgetView = {
  version: 1;
  state: PaymentWidgetState;
  amount?: string;
  symbol?: string;
  decimals?: number;
  merchant?: string;
  product?: string;
  cluster: string;
  recipient?: string;
  recipientShort?: string;
  /** Plain-language checks, present only when each one is proven by this result. */
  checks?: string[];
  limits?: {
    requested?: string;
    cap?: string;
    remaining?: string;
    after?: string;
    withinLimits?: boolean;
  };
  /** Index into the six progress steps of the step in progress. */
  currentStep?: number;
  paymentId?: string;
  mandate?: string;
  signature?: string;
  txShort?: string;
  receipt?: string;
  receiptShort?: string;
  receiptUrl?: string;
  explorerUrl?: string;
  reason?: string;
  reasonKind?: "limits" | "signature" | "expired" | "paid" | "recipient" | "permission" | "funds" | "other";
  /** True only when this call was refused before submitting a new payment. */
  rejectedBeforeBroadcast?: boolean;
};

export const WIDGET_TOOLS = new Set(["quote_payment_request", "execute_payment", "wait_for_payment"]);

/** Execution/quote results that prove this call submitted no new payment. */
const REJECTED_BEFORE_BROADCAST = new Set([
  "payment_request_rejected",
  "payment_request_blocked",
  "payment_request_mismatch",
  "rejected_by_preflight",
  "duplicate_invoice",
  "backend_rejected",
  "managed_backend_rejected",
  "agent_identity_mismatch",
  "delegated_signature_rejected",
  "backend_required",
  "managed_backend_required",
]);

const CHECK_LABELS = {
  signature: "Merchant signature verified",
  unused: "Payment request has not been used",
  active: "Permission is active",
  token: "Token matches permission",
  recipient: "Recipient verified",
  unexpired: "Request has not expired",
} as const;

type Record_ = Record<string, unknown>;
type PolicyCheck = { name: string; ok: boolean; message: string };

function record(value: unknown): Record_ | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function shortAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length < 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function explorerUrl(signature: string, cluster: string): string {
  const query = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${query}`;
}

function clusterLabel(cluster: string): string {
  return cluster === "mainnet-beta" ? "Solana" : `Solana ${cluster[0]!.toUpperCase()}${cluster.slice(1)}`;
}

/** Preflight checks from whichever nested result carries them. */
function preflightChecks(data: Record_): PolicyCheck[] {
  const candidates = [data.preflight, record(data.quote)?.preflight, record(data.check)?.preflight];
  for (const candidate of candidates) {
    const checks = record(candidate)?.checks;
    if (Array.isArray(checks)) {
      return checks.filter((item): item is PolicyCheck => {
        const value = record(item);
        return typeof value?.name === "string" && typeof value.ok === "boolean";
      });
    }
  }
  return [];
}

function passed(checks: PolicyCheck[], ...names: string[]): boolean {
  return names.every((name) => checks.some((item) => item.name === name && item.ok));
}

function toUnits(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

async function readMandate(context: ChainPayMcpContext, address: string | undefined): Promise<Mandate | undefined> {
  if (!address) return undefined;
  try {
    return (await context.client.getMandate(address)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function mintDecimals(context: ChainPayMcpContext, mint: string | undefined, fallback?: number): Promise<number | undefined> {
  if (!mint) return fallback;
  try {
    return await context.client.getMintDecimals(mint);
  } catch {
    return fallback;
  }
}

/** The plain reason a payment was refused, from the most specific evidence present. */
function blockedReason(
  data: Record_,
  checks: PolicyCheck[],
  amounts: { cap?: string; remaining?: string; symbol?: string },
): Pick<PaymentWidgetView, "reason" | "reasonKind"> {
  const failed = new Set(checks.filter((item) => !item.ok).map((item) => item.name));
  const symbol = amounts.symbol ?? "";
  const verification = record(data.verification);
  const message = text(verification?.reason) ?? text(data.message) ?? text(data.error) ?? "";
  const action = text(data.action);

  if (action === "duplicate_invoice" || failed.has("duplicate_invoice")) {
    return { reason: "This invoice has already been paid.", reasonKind: "paid" };
  }
  if (failed.has("per_payment_limit")) {
    return {
      reason: amounts.cap ? `Requested amount exceeds the ${amounts.cap} ${symbol} per-payment cap.` : "Requested amount exceeds the per-payment cap.",
      reasonKind: "limits",
    };
  }
  if (failed.has("total_limit")) {
    return {
      reason: amounts.remaining ? `Requested amount exceeds the ${amounts.remaining} ${symbol} left on this permission.` : "Requested amount exceeds what is left on this permission.",
      reasonKind: "limits",
    };
  }
  if (failed.has("delegated_amount") || failed.has("source_balance")) {
    return { reason: "The funding account doesn't have enough approved balance for this payment.", reasonKind: "funds" };
  }
  if (failed.has("mandate_status")) {
    const status = checks.find((item) => item.name === "mandate_status")?.message.replace(/^Mandate is /, "") ?? "inactive";
    return { reason: `This spending permission is ${status}.`, reasonKind: "permission" };
  }
  if (failed.has("expiry")) return { reason: "This spending permission has expired.", reasonKind: "permission" };
  if (failed.has("mint") || failed.has("token_program") || failed.has("asset_registry")) {
    return { reason: "The requested token doesn't match this spending permission.", reasonKind: "other" };
  }
  if (/signature/i.test(message) && /invalid|64 bytes/i.test(message)) {
    return { reason: "The merchant signature is invalid.", reasonKind: "signature" };
  }
  if (/expired/i.test(message) && /request/i.test(message)) {
    return { reason: "This payment request has expired.", reasonKind: "expired" };
  }
  if (action === "payment_request_mismatch") {
    return { reason: "The payment doesn't match what the merchant signed.", reasonKind: "recipient" };
  }
  if (/paused|revoked/i.test(message)) {
    return { reason: `This spending permission is ${/revoked/i.test(message) ? "revoked" : "paused"}.`, reasonKind: "permission" };
  }
  const first = checks.find((item) => !item.ok)?.message ?? message;
  return { reason: first ? `${first.replace(/\.$/, "")}.` : "This payment was refused.", reasonKind: "other" };
}

function stateFor(action: string | undefined, data: Record_, signingMode: string | undefined): {
  state: PaymentWidgetState;
  currentStep?: number;
} {
  const status = text(data.status);
  const hasSignature = Boolean(text(data.signature));
  switch (action) {
    case "payment_request_quoted":
      return { state: "ready" };
    case "managed_payment_settled":
    case "backend_relayed":
      return { state: "settled" };
    case "payment_terminal":
      if (status === "confirmed" && hasSignature) return { state: "settled" };
      return { state: status === "failed" && hasSignature ? "blocked" : "unknown" };
    case "payment_pending":
      // Signed and sent: the chain is what we are waiting on. Without a
      // signature the relay has not confirmed it broadcast anything, so the
      // card stops at the step it can prove: submission (human mode signed
      // before the call) or delegated authorization (the relay signs).
      if (hasSignature) return { state: "confirming", currentStep: 4 };
      return { state: "paying", currentStep: signingMode === "delegated" ? 2 : 3 };
    case "agent_signature_required":
      return { state: "signature" };
    case "payment_failed":
    case "managed_payment_failed":
      return { state: hasSignature ? "blocked" : "unknown" };
    case "payment_outcome_unknown":
      return { state: "unknown" };
    default:
      if (action && REJECTED_BEFORE_BROADCAST.has(action)) return { state: "blocked" };
      return { state: "unknown" };
  }
}

/**
 * The widget view for one ChainPay payment tool result, or undefined when the
 * tool has no payment card. Reads the mandate once for limits; any read that
 * fails leaves its field out rather than failing the tool.
 */
export async function paymentWidgetView(
  context: ChainPayMcpContext,
  toolName: string,
  args: Record_,
  result: unknown,
): Promise<PaymentWidgetView | undefined> {
  if (!WIDGET_TOOLS.has(toolName)) return undefined;
  const raw = record(record(result)?.structuredContent);
  if (!raw) return undefined;
  // wait_for_payment nests the latest record while settlement is pending.
  const data = raw.action === "payment_pending" ? { ...record(raw.payment), ...raw } : raw;
  const action = text(data.action);

  const verification = record(data.verification);
  const verifiedPayload = verification?.valid === true ? record(verification.payload) as unknown as PaymentRequestPayload | undefined : undefined;
  const argPayload = record(record(args.request)?.payload) as unknown as PaymentRequestPayload | undefined;
  // The merchant's name and description are shown only from a verified request.
  const trustedPayload = verifiedPayload
    ?? (action !== "payment_request_rejected" && action !== "payment_request_mismatch" && toolName === "execute_payment" ? argPayload : undefined);
  const payload = trustedPayload ?? argPayload;

  const mint = text(payload?.mint) ?? text(data.mint) ?? text(args.mint);
  const recipient = text(payload?.recipient) ?? text(data.recipient) ?? text(args.recipient);
  const mandateAddress = text(args.mandate) ?? text(data.mandate);
  const amountUnits = toUnits(payload?.amount) ?? toUnits(data.amount) ?? toUnits(args.amount);
  const cluster = text(payload?.cluster) ?? "devnet";

  const [decimals, mandate] = await Promise.all([
    mintDecimals(context, mint),
    readMandate(context, mandateAddress),
  ]);
  const format = (value: bigint | undefined) => value === undefined || decimals === undefined ? undefined : formatTokenAmount(value, decimals);
  const symbol = mint ? tokenLabel(mint) : undefined;

  const checks = preflightChecks(data);
  const signingMode = text(args.signingMode) ?? text(data.signing_mode) ?? text(data.signingMode);
  let { state, currentStep } = stateFor(action, data, signingMode);
  // A status lookup failure says nothing about a previously submitted payment.
  if (toolName === "wait_for_payment" && (
    (action !== "payment_terminal" && action !== "payment_pending")
    || (action === "payment_pending" && !text(data.signature))
  )) {
    state = "unknown";
    currentStep = undefined;
  }
  if (action === "payment_request_quoted" && record(result)?.isError === true) state = "blocked";

  const remainingUnits = mandate ? mandate.totalLimit - mandate.amountSpent : undefined;
  const limits: PaymentWidgetView["limits"] = mandate && mandate.allowedMint === mint
    ? {
        requested: format(amountUnits),
        cap: format(mandate.maxPerPayment),
        remaining: format(remainingUnits),
        ...(state === "ready" && amountUnits !== undefined && remainingUnits !== undefined && amountUnits <= remainingUnits
          ? { after: format(remainingUnits - amountUnits) }
          : {}),
        ...(checks.length ? { withinLimits: passed(checks, "per_payment_limit", "total_limit") } : {}),
      }
    : undefined;

  const signature = text(data.signature);
  const receipt = text(data.receiptAddress) ?? text(data.receipt_address);
  const view: PaymentWidgetView = {
    version: 1,
    state,
    ...(currentStep === undefined ? {} : { currentStep }),
    amount: format(amountUnits),
    symbol,
    decimals,
    merchant: trustedPayload?.merchant ? merchantDisplayName(trustedPayload.merchant) : undefined,
    product: text(trustedPayload?.description) ?? text(trustedPayload?.lineItems?.[0]?.label),
    cluster: clusterLabel(cluster),
    recipient,
    recipientShort: shortAddress(recipient),
    limits,
    mandate: mandateAddress,
    paymentId: text(data.payment_id) ?? text(data.paymentId) ?? (toolName === "wait_for_payment" ? text(args.paymentId) : undefined),
  };

  if (state === "ready") {
    const proven: string[] = [];
    if (verifiedPayload) proven.push(CHECK_LABELS.signature);
    if (passed(checks, "duplicate_invoice")) proven.push(CHECK_LABELS.unused);
    if (passed(checks, "mandate_status")) proven.push(CHECK_LABELS.active);
    if (passed(checks, "mint")) proven.push(CHECK_LABELS.token);
    if (verifiedPayload && passed(checks, "recipient")) proven.push(CHECK_LABELS.recipient);
    // verifyPaymentRequest refuses an expired request, so a verified one is unexpired.
    if (verifiedPayload) proven.push(CHECK_LABELS.unexpired);
    view.checks = proven;
  }

  if (signature) {
    view.signature = signature;
    view.txShort = shortAddress(signature);
    view.explorerUrl = explorerUrl(signature, cluster);
  }
  if (receipt && state === "settled") {
    view.receipt = receipt;
    view.receiptShort = shortAddress(receipt);
    view.receiptUrl = receiptUrlForAddress(receipt);
  }
  if (state === "settled" && view.limits && remainingUnits !== undefined) {
    // The mandate read happens after confirmation, so its spend already includes this payment.
    view.limits = { ...view.limits, remaining: format(remainingUnits), after: undefined };
  }
  if (state === "blocked") {
    Object.assign(view, blockedReason(data, checks, { cap: limits?.cap, remaining: limits?.remaining, symbol }));
    if (toolName !== "wait_for_payment" && action && (REJECTED_BEFORE_BROADCAST.has(action) || action === "payment_request_quoted")) {
      view.rejectedBeforeBroadcast = true;
    }
  }
  return view;
}
