const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type ReceiptAmountView = {
  baseUnits: string;
  decimals: number | null;
  display: string;
  displayKind: "ui-amount" | "base-units";
};

export type CurrentMandateView =
  | { status: "present"; fields: CurrentMandateFields }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type CurrentMandateFields = {
  status: string;
  paused: boolean;
  revoked: boolean;
  maxPerPayment: string;
  totalLimit: string;
  amountSpent: string;
  paymentCount: string;
  maxPaymentCount: string;
  cooldownSlots: string;
  expiresAtSlot: string;
  /**
   * Exact base units for the today check. Optional so an older cached view
   * without them reads as "not checked" instead of a guessed comparison.
   */
  baseUnits?: {
    maxPerPayment: string;
    totalLimit: string;
    amountSpent: string;
  };
};

/** Mandate limits beside a receipt, as exact base-unit and slot strings. */
export type PolicyLimitsView = {
  maxPerPayment: string;
  totalLimit: string;
  amountSpentAfter: string;
  paymentCountAfter: string;
  /** "0" means no payment-count cap. */
  maxPaymentCount: string;
  expiresAtSlot: string;
  cooldownSlots: string;
};

/**
 * Where the "Spending permission at payment" limits came from.
 * - on-chain: the program wrote them into the receipt account.
 * - relay-observed: the ChainPay relay read the mandate after the payment.
 *   Not stored on Solana; may already count later payments.
 * - not-recorded: neither exists. Only today's limits can be shown.
 */
export type PolicyAtPaymentView =
  | { source: "on-chain"; limits: PolicyLimitsView }
  | { source: "relay-observed"; limits: PolicyLimitsView; observedAtSlot: string; includesLaterPayments: boolean }
  | { source: "not-recorded" };

export type PurchaseMismatch = "amount" | "mint" | "recipient";

export type PurchaseLineItemView = {
  label: string;
  /** Already formatted in token units, or labeled base units. */
  amount?: string;
  quantity?: string;
};

/**
 * What a merchant-signed request says was bought, after it was checked
 * against this receipt's invoice hash and the seller's signature.
 * - none: nothing verifiable. The Order match section is omitted.
 * - verified: signature and hash match. `via` says where the request came
 *   from: the owner's own relay session, or an audit link the owner shared.
 * - failed: a request was offered but did not verify. Nothing from it shows.
 */
export type PurchaseProofState =
  | { status: "none" }
  | {
      status: "verified";
      via: "owner" | "link";
      merchant: string;
      invoice: string;
      description?: string;
      lineItems?: PurchaseLineItemView[];
      mismatches: PurchaseMismatch[];
      /** base64url fragment value the owner can share. Owner only. */
      shareFragment?: string;
    }
  | { status: "failed"; via: "owner" | "link"; reason: string };

export type SellerStatementState =
  | { status: "absent" }
  | { status: "valid"; contentHash: string; servedAt: string; seller: string; publishedAt?: string }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string }
  // Crossmint is the seller for a Crossmint order, so its order status takes the
  // seller slot. It is Crossmint's report, never ChainPay verification.
  | { status: "crossmint"; phase: string; refunded: boolean; reportedAt?: string };

export type ReceiptValidationCode =
  | "wrong_owner"
  | "wrong_discriminator"
  | "truncated"
  | "pda_mismatch"
  | "unsettled"
  | "not_found";

export type ReceiptView = {
  address: string;
  mandate: string;
  invoiceHash: string;
  paymentId: string;
  mint: string;
  sourceTokenAccount: string;
  recipientTokenAccount: string;
  recipient?: string;
  agent: string;
  executedAtSlot: string;
  signatureReference: string;
  bump: string;
  onChainStatus: string;
  transactionSignature?: string;
  amount: ReceiptAmountView;
  tokenLabel: string;
  currentMandate: CurrentMandateView;
  seller: SellerStatementState;
  /** Absent on older cached views; read as not-recorded. */
  policy?: PolicyAtPaymentView;
  /** Slot when the receipt was read, for expiry checks and date estimates. */
  currentSlot?: string;
};

export type PublicReceiptPageState =
  | { kind: "malformed"; receiptPda: string }
  | { kind: "loading"; receiptPda: string }
  | { kind: "not_found"; receiptPda: string }
  | { kind: "rpc_error"; receiptPda: string; message: string }
  | { kind: "invalid"; receiptPda: string; code: ReceiptValidationCode; reason: string }
  | { kind: "verified"; receiptPda: string; receipt: ReceiptView };

export type StampTone = "yes" | "no" | "neutral" | "unknown";

export type ReceiptStamp = {
  key: "allowed" | "paid" | "seller";
  label: string;
  detail: string;
  tone: StampTone;
};

/** Base58 of the right length. Says nothing about what the address is. */
export function isPlausibleSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(value.trim());
}

export const isPlausibleReceiptPda = isPlausibleSolanaAddress;

export function classifyReceiptPda(value: string): "empty" | "malformed" | "plausible" {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  return isPlausibleReceiptPda(trimmed) ? "plausible" : "malformed";
}

export function initialPageState(receiptPda: string): PublicReceiptPageState {
  const trimmed = receiptPda.trim();
  return classifyReceiptPda(trimmed) === "plausible"
    ? { kind: "loading", receiptPda: trimmed }
    : { kind: "malformed", receiptPda: trimmed };
}

export function publicReceiptPath(receiptPda: string): string {
  return `/verify/${encodeURIComponent(receiptPda.trim())}`;
}

export function publicReceiptUrl(receiptPda: string, origin = ""): string {
  const base = origin.replace(/\/$/, "");
  return `${base}${publicReceiptPath(receiptPda)}`;
}

export function amountLabel(amount: ReceiptAmountView): string {
  return amount.displayKind === "base-units"
    ? `${amount.display} base units`
    : amount.display;
}

export function formatMandatePaymentCount(paymentCount: string, maxPaymentCount: string): string {
  return maxPaymentCount === "0" ? `${paymentCount} · Unlimited` : `${paymentCount} / ${maxPaymentCount}`;
}

function reportedAtLabel(reportedAt: string | undefined): string {
  if (!reportedAt) return "";
  const date = new Date(reportedAt);
  if (Number.isNaN(date.getTime())) return "";
  return ` at ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

function crossmintStamp(seller: Extract<SellerStatementState, { status: "crossmint" }>): ReceiptStamp {
  // A refunded order is still "completed" to Crossmint, so the refund wins.
  if (seller.refunded) {
    return {
      key: "seller",
      label: "Crossmint reports a refund",
      detail: "Paid on Solana is unchanged. ChainPay cannot confirm the refund reached your wallet.",
      tone: "unknown",
    };
  }
  if (seller.phase === "completed") {
    return {
      key: "seller",
      label: "Crossmint reports order complete",
      detail: `Reported by Crossmint${reportedAtLabel(seller.reportedAt)}. Not checked on Solana.`,
      tone: "neutral",
    };
  }
  if (seller.phase === "payment" || seller.phase === "delivery") {
    return {
      key: "seller",
      label: "Waiting for Crossmint",
      detail: "Payment is on Solana. Crossmint has not reported the order complete.",
      tone: "neutral",
    };
  }
  return {
    key: "seller",
    label: "No Crossmint statement",
    detail: "Crossmint has not reported on this order.",
    tone: "neutral",
  };
}

export function sellerStamp(seller: SellerStatementState): ReceiptStamp {
  if (seller.status === "crossmint") return crossmintStamp(seller);
  if (seller.status === "valid") {
    return {
      key: "seller",
      label: "Seller attests response served",
      detail: "A trusted seller signed a statement that it served a specific response. This is not buyer receipt or acceptance.",
      tone: "yes",
    };
  }
  if (seller.status === "invalid") {
    return {
      key: "seller",
      label: "Seller statement invalid",
      detail: seller.reason,
      tone: "no",
    };
  }
  if (seller.status === "unavailable") {
    return {
      key: "seller",
      label: "Seller statement unavailable",
      detail: seller.reason,
      tone: "unknown",
    };
  }
  return {
    key: "seller",
    label: "No seller statement",
    detail: "A seller can sign a statement that it served a specific response. None is published for this receipt.",
    tone: "neutral",
  };
}

export function receiptStamps(receipt: ReceiptView): ReceiptStamp[] {
  return [
    {
      key: "allowed",
      label: "Allowed",
      detail: allowedStampDetail(receipt.policy),
      tone: "yes",
    },
    {
      key: "paid",
      label: "Paid",
      detail: "Settlement verified from the receipt on Solana.",
      tone: "yes",
    },
    sellerStamp(receipt.seller),
  ];
}

export function stampIsGreen(stamp: ReceiptStamp): boolean {
  return stamp.tone === "yes";
}

export function pageAllowsSuccessChrome(state: PublicReceiptPageState): boolean {
  return state.kind === "verified";
}

export function sellerStateFromHttp(input: {
  httpStatus: number | null;
  networkError?: boolean;
  cryptoUnavailable?: boolean;
  body?: unknown;
  verification?: { valid: boolean; reason?: string };
}): SellerStatementState {
  if (input.networkError) {
    return { status: "unavailable", reason: "The seller statement service could not be reached." };
  }
  if (input.httpStatus === 404) {
    return { status: "absent" };
  }
  if (input.httpStatus !== 200) {
    return {
      status: "unavailable",
      reason: input.httpStatus == null
        ? "The seller statement could not be checked."
        : `Seller statement lookup returned HTTP ${input.httpStatus}.`,
    };
  }
  if (input.cryptoUnavailable) {
    return { status: "unavailable", reason: "This browser cannot verify the seller signature." };
  }
  if (!input.verification) {
    return { status: "invalid", reason: "HTTP 200 is not enough to treat a seller statement as valid." };
  }
  if (!input.verification.valid) {
    return { status: "invalid", reason: input.verification.reason ?? "Seller statement did not verify." };
  }
  const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
  const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {};
  const contentHash = typeof payload.contentHash === "string" ? payload.contentHash : "";
  const servedAt = typeof payload.servedAt === "string" ? payload.servedAt : "";
  const seller = typeof payload.seller === "string" ? payload.seller : "";
  if (!contentHash || !servedAt || !seller) {
    return { status: "invalid", reason: "Verified envelope is missing statement fields." };
  }
  return {
    status: "valid",
    contentHash,
    servedAt,
    seller,
    publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : undefined,
  };
}

export function failureCopy(state: Exclude<PublicReceiptPageState, { kind: "verified" | "loading" }>): { title: string; body: string } {
  if (state.kind === "malformed") {
    return {
      title: "This address is not a valid Solana account.",
      body: "Check the receipt PDA and try again. A public receipt URL looks like /verify/<receiptPda>.",
    };
  }
  if (state.kind === "not_found") {
    return {
      title: "No ChainPay receipt exists at this address.",
      body: "The account is missing on Solana Devnet. Confirm the PDA before treating this as a payment.",
    };
  }
  if (state.kind === "rpc_error") {
    return {
      title: "Receipt verification is unavailable.",
      body: state.message,
    };
  }
  return {
    title: "This account is not a verified ChainPay receipt.",
    body: state.reason,
  };
}

// ---------------------------------------------------------------------------
// Spending permission at payment
// ---------------------------------------------------------------------------

/** Rough Solana slot time, only for "≈ date" labels. Never for a check. */
export const APPROX_SECONDS_PER_SLOT = 0.4;

function isUnsigned(value: string | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Exact token units for a visible line: "4.50 USDC", "5 USDC", "4.500001 USDC".
 * Whole amounts drop the decimals; fractional amounts keep at least two places
 * and every significant digit. Unknown decimals stay labeled base units.
 * Pure bigint/string arithmetic; never Number.
 */
export function formatTokenUnits(baseUnits: string, decimals: number | null, token: string): string {
  if (!isUnsigned(baseUnits)) return `${baseUnits} base units`;
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0) {
    return `${BigInt(baseUnits).toString()} base units`;
  }
  const value = BigInt(baseUnits);
  if (decimals === 0) return `${value.toString()} ${token}`;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (!fraction) return `${whole.toString()} ${token}`;
  return `${whole.toString()}.${fraction.padEnd(2, "0")} ${token}`;
}

function tokenUnits(receipt: ReceiptView, baseUnits: string): string {
  return formatTokenUnits(baseUnits, receipt.amount.decimals, receipt.tokenLabel);
}

/**
 * "Oct 30, 2026" for a slot, estimated from the slot read with the receipt.
 * Null when there is no reference slot or the date would be out of range.
 */
export function estimateSlotDate(
  slot: string,
  currentSlot: string | undefined,
  nowMs: number,
  secondsPerSlot = APPROX_SECONDS_PER_SLOT,
): string | null {
  if (!isUnsigned(slot) || !isUnsigned(currentSlot)) return null;
  // Slot distances, not amounts: Number is fine here and the result is labeled approximate.
  const deltaSlots = Number(BigInt(slot) - BigInt(currentSlot));
  const when = new Date(nowMs + deltaSlots * secondsPerSlot * 1000);
  if (!Number.isFinite(deltaSlots) || Number.isNaN(when.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(when);
  } catch {
    return null;
  }
}

export const POLICY_SOURCE_CAPTION: Record<PolicyAtPaymentView["source"], string> = {
  "on-chain": "Recorded on Solana at payment",
  "relay-observed": "Seen by the ChainPay relay after payment, not stored on Solana. The limits may have changed since the payment.",
  "not-recorded": "Not recorded for this receipt. These are today’s limits, not the ones at payment.",
};

/** Section heading: only an on-chain snapshot is the permission "at payment". */
export const POLICY_SOURCE_HEADING: Record<PolicyAtPaymentView["source"], string> = {
  "on-chain": "Spending permission at payment",
  "relay-observed": "Spending permission, read after payment",
  "not-recorded": "Spending permission today",
};

export type PolicyAtPaymentDisplay = {
  source: PolicyAtPaymentView["source"];
  heading: string;
  caption: string;
  /** Plain lines in token units. Empty for not-recorded. */
  rows: string[];
};

/**
 * True only when the receipt's own on-chain snapshot shows the permission had
 * not expired at the payment slot. The program accepts a payment only while
 * `expires_at_slot > current_slot`, and the snapshot records both values.
 */
export function paidBeforeExpiryProven(receipt: ReceiptView): boolean {
  const policy = receipt.policy;
  if (!policy || policy.source !== "on-chain") return false;
  const expires = policy.limits.expiresAtSlot;
  if (!isUnsigned(expires) || !isUnsigned(receipt.executedAtSlot)) return false;
  return BigInt(expires) > BigInt(receipt.executedAtSlot);
}

export function policyAtPayment(receipt: ReceiptView, nowMs = Date.now()): PolicyAtPaymentDisplay {
  const policy = receipt.policy ?? { source: "not-recorded" as const };
  const base = { source: policy.source, heading: POLICY_SOURCE_HEADING[policy.source], caption: POLICY_SOURCE_CAPTION[policy.source] };
  if (policy.source === "not-recorded") {
    return { ...base, rows: [] };
  }
  const limits = policy.limits;
  const expiry = estimateSlotDate(limits.expiresAtSlot, receipt.currentSlot, nowMs);
  if (policy.source === "relay-observed") {
    // A relay read is not the permission at payment: it may follow an edit or
    // later payments. Show what was read, labeled as such, and claim nothing
    // about the payment itself.
    const rows = [`${tokenUnits(receipt, limits.maxPerPayment)} per payment, read after this payment`];
    if (!policy.includesLaterPayments) {
      rows.push(`${formatTokenUnits(limits.amountSpentAfter, receipt.amount.decimals, "")
        .trim()} of ${tokenUnits(receipt, limits.totalLimit)} used after this payment`);
      if (isUnsigned(limits.maxPaymentCount) && limits.maxPaymentCount !== "0") {
        rows.push(`Payment ${limits.paymentCountAfter} of ${limits.maxPaymentCount}`);
      }
    }
    rows.push(expiry ? `Expires ≈ ${expiry}, read after this payment` : `Expires at slot ${limits.expiresAtSlot}, read after this payment`);
    return { ...base, rows };
  }
  const rows = [
    `${tokenUnits(receipt, receipt.amount.baseUnits)} ≤ ${tokenUnits(receipt, limits.maxPerPayment)} per payment`,
    `${formatTokenUnits(limits.amountSpentAfter, receipt.amount.decimals, "")
      .trim()} of ${tokenUnits(receipt, limits.totalLimit)} used after this payment`,
  ];
  if (isUnsigned(limits.maxPaymentCount) && limits.maxPaymentCount !== "0") {
    rows.push(`Payment ${limits.paymentCountAfter} of ${limits.maxPaymentCount}`);
  }
  if (paidBeforeExpiryProven(receipt)) {
    rows.push(expiry ? `Paid before expiry (≈ ${expiry})` : "Paid before expiry");
  } else {
    rows.push(expiry ? `Expires ≈ ${expiry}` : `Expires at slot ${limits.expiresAtSlot}`);
  }
  return { ...base, rows };
}

export function allowedStampDetail(policy: PolicyAtPaymentView | undefined): string {
  if (!policy || policy.source === "not-recorded") {
    return "The program accepted this payment under this spending permission. Its limits at payment were not recorded for this receipt.";
  }
  if (policy.source === "relay-observed") {
    return "The program accepted this payment under this spending permission. Its limits at payment were not stored on Solana. The relay’s later read is shown below.";
  }
  return "The program accepted this payment under this spending permission. See Spending permission at payment for the limits it met.";
}

export type TodayCheck =
  | { status: "within"; line: string }
  | { status: "blocked"; reason: string; line: string }
  | { status: "unknown"; line: string };

/**
 * Would this amount pass the mandate as it is today? Compares exact base
 * units with the current mandate. Cooldown is left out: it depends on when
 * the next payment is sent, not on the permission.
 */
export function todayCheck(receipt: ReceiptView): TodayCheck {
  const current = receipt.currentMandate;
  const unknown: TodayCheck = { status: "unknown", line: "If paid today: not checked. Today’s limits could not be read." };
  if (current.status !== "present") return unknown;
  const fields = current.fields;
  const amount = receipt.amount.baseUnits;
  const blocked = (reason: string): TodayCheck => ({ status: "blocked", reason, line: `If paid today: blocked — ${reason}` });
  if (fields.revoked || fields.status === "revoked") return blocked("the spending permission was revoked");
  if (fields.paused || fields.status === "paused") return blocked("the spending permission is paused");
  const expiredBySlot = isUnsigned(receipt.currentSlot) && isUnsigned(fields.expiresAtSlot)
    && BigInt(receipt.currentSlot) >= BigInt(fields.expiresAtSlot);
  if (fields.status === "expired" || expiredBySlot) return blocked("the spending permission has expired");
  const base = fields.baseUnits;
  if (!base || !isUnsigned(amount) || !isUnsigned(base.maxPerPayment) || !isUnsigned(base.totalLimit) || !isUnsigned(base.amountSpent)) {
    return unknown;
  }
  if (BigInt(amount) > BigInt(base.maxPerPayment)) {
    return blocked(`${tokenUnits(receipt, amount)} is over today’s ${tokenUnits(receipt, base.maxPerPayment)} per-payment limit`);
  }
  if (isUnsigned(fields.maxPaymentCount) && fields.maxPaymentCount !== "0" && isUnsigned(fields.paymentCount)
    && BigInt(fields.paymentCount) >= BigInt(fields.maxPaymentCount)) {
    return blocked(`all ${fields.maxPaymentCount} payments have been used`);
  }
  const spent = BigInt(base.amountSpent);
  const total = BigInt(base.totalLimit);
  if (spent + BigInt(amount) > total) {
    const left = total > spent ? total - spent : 0n;
    return blocked(`only ${tokenUnits(receipt, left.toString())} of the ${tokenUnits(receipt, base.totalLimit)} allowance is left`);
  }
  return { status: "within", line: "If paid today: within limits" };
}

// ---------------------------------------------------------------------------
// Order match: order · invoice · payment
// ---------------------------------------------------------------------------

/**
 * Who is reading. "owner" is the signed-in owner's dashboard. "link" is
 * /verify opened from an audit link whose request verified. "public" is
 * anyone else, who never sees request content.
 */
export type OrderMatchAudience = "owner" | "link" | "public";

/**
 * Matched: an order, a seller-signed invoice and the payment agree (for a
 * budget request: the order and the payment). Payee differs: the payment went
 * to someone other than the order or invoice names. No invoice: an order but
 * no verified invoice for this payment. No order: no linked order.
 * Invoice differs: the signed invoice amount or token differs from the payment.
 * Acceptance unverified: matching proposal supplied in a public fragment.
 * Matched is a check made by ChainPay, not a guarantee from Solana.
 */
export type OrderMatchPill = "Matched" | "Payee differs" | "Invoice differs" | "Acceptance unverified" | "No invoice" | "No order";

export type OrderMatchRow = {
  key: "order" | "invoice" | "invoice-mismatch" | "payee" | "payment";
  tone: "yes" | "no";
  text: string;
};

/**
 * A signed purchase order or budget request with compatible receipt fields.
 * - owner: acceptance association read from the relay with the owner's session.
 * - link: supplied in an audit link; owner acceptance is not authenticated.
 * `payeeMatches` is null for a budget request, where the payee is open.
 */
export type OrderLinkState =
  | { status: "none" }
  | {
      status: "linked";
      via: "owner" | "link";
      role: "vendor" | "grantee";
      requester: string;
      requesterName?: string;
      poNumber?: string;
      description: string;
      expectedPayee?: string;
      payeeMatches: boolean | null;
      /** base64url fragment value the owner can share. Owner only. */
      shareFragment?: string;
    }
  | { status: "failed"; via: "owner" | "link"; reason: string };

export type OrderMatchDisplay = {
  pill: OrderMatchPill;
  rows: OrderMatchRow[];
  /** Request content. Present only for the owner or a verified audit link. */
  details?: {
    invoice?: string;
    description?: string;
    lineItems?: PurchaseLineItemView[];
    poNumber?: string;
    orderDescription?: string;
    expectedPayee?: string;
  };
  canShareDetails: boolean;
};

const MISMATCH_WORD: Record<PurchaseMismatch, string> = {
  amount: "amount",
  mint: "token",
  recipient: "payee",
};

function shortRequester(value: string): string {
  return value.length < 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** "Purchase order PO-1042 from Acme Data (name not verified)". */
export function orderRowText(order: Extract<OrderLinkState, { status: "linked" }>): string {
  const from = order.requesterName ? `${order.requesterName} (name not verified)` : shortRequester(order.requester);
  if (order.role === "grantee") return `Budget request from ${from}`;
  return `Purchase order${order.poNumber ? ` ${order.poNumber}` : ""} from ${from}`;
}

function invoiceRows(purchase: PurchaseProofState | undefined, showContent: boolean): OrderMatchRow[] {
  if (!purchase || purchase.status === "none") return [];
  if (purchase.status === "failed") {
    return [{ key: "invoice", tone: "no", text: `Invoice not verified: ${purchase.reason}. Nothing from it is shown.` }];
  }
  const rows: OrderMatchRow[] = [
    { key: "invoice", tone: "yes", text: showContent ? "Invoice signed by seller" : "Invoice signed by seller · details private" },
  ];
  if (purchase.mismatches.length) {
    const words = purchase.mismatches.map((item) => MISMATCH_WORD[item]).join(", ");
    rows.push({ key: "invoice-mismatch", tone: "no", text: `This payment’s ${words} differs from the invoice` });
  }
  return rows;
}

/**
 * The Order match section, or null when there is nothing verifiable to show.
 * Without a linked order the pill is "No order" unless the payment went to a
 * different payee than the invoice named. A public reader without an audit
 * link sees no order content and no order-based pill.
 */
export function orderMatch(
  purchase: PurchaseProofState | undefined,
  audience: OrderMatchAudience,
  order?: OrderLinkState,
): OrderMatchDisplay | null {
  const linked = order?.status === "linked" ? order : null;
  const orderVisible = Boolean(linked) && (audience === "owner" || (audience === "link" && linked!.via === "link"));
  const purchaseShows = Boolean(purchase && purchase.status !== "none" && !(purchase.status === "failed" && audience === "public"));
  const orderFailed = order?.status === "failed" && audience !== "public" ? order : null;
  if (!orderVisible && !purchaseShows && !orderFailed) return null;

  const showContent = audience === "owner"
    || (audience === "link" && ((purchase?.status !== "none" && purchase?.via === "link") || (linked?.via === "link")));
  const purchaseContent = audience === "owner" || (audience === "link" && purchase?.status === "verified" && purchase.via === "link");
  const rows: OrderMatchRow[] = [];
  let pill: OrderMatchPill;

  if (orderVisible && linked) {
    rows.push({ key: "order", tone: "yes", text: orderRowText(linked) });
    rows.push(...invoiceRows(purchase, purchaseContent));
    const invoicePayeeDiffers = purchase?.status === "verified" && purchase.mismatches.includes("recipient");
    if (linked.role === "vendor") {
      const payeeDiffers = linked.payeeMatches === false || invoicePayeeDiffers;
      rows.push(payeeDiffers
        ? { key: "payee", tone: "no", text: "Paid to a different payee than the order names" }
        : { key: "payee", tone: "yes", text: "Paid to the order’s payee" });
      rows.push({ key: "payment", tone: "yes", text: "Paid on Solana" });
      pill = payeeDiffers ? "Payee differs" : purchase?.status === "verified" ? "Matched" : "No invoice";
    } else {
      rows.push({ key: "payment", tone: "yes", text: "Paid on Solana" });
      pill = "Matched";
    }
  } else {
    if (orderFailed) rows.push({ key: "order", tone: "no", text: `Order not verified: ${orderFailed.reason}. Nothing from it is shown.` });
    rows.push(...invoiceRows(purchase, purchaseContent));
    rows.push({ key: "payment", tone: "yes", text: "Paid on Solana" });
    pill = purchase?.status === "verified" && purchase.mismatches.includes("recipient") ? "Payee differs" : "No order";
  }

  // A valid invoice signature/hash does not establish agreement on its terms.
  if (purchase?.status === "verified" && purchase.mismatches.some((field) => field === "amount" || field === "mint")) {
    pill = "Invoice differs";
  }
  // A requester signature authenticates a proposal, not the owner's acceptance.
  if (orderVisible && linked?.via === "link" && pill === "Matched") pill = "Acceptance unverified";

  const details: NonNullable<OrderMatchDisplay["details"]> = {};
  if (purchaseContent && purchase?.status === "verified") {
    details.invoice = purchase.invoice;
    if (purchase.description) details.description = purchase.description;
    if (purchase.lineItems?.length) details.lineItems = purchase.lineItems;
  }
  if (orderVisible && linked && showContent) {
    if (linked.poNumber) details.poNumber = linked.poNumber;
    details.orderDescription = linked.description;
    if (linked.expectedPayee) details.expectedPayee = linked.expectedPayee;
  }
  const purchaseShare = purchase?.status === "verified" && purchase.via === "owner" && Boolean(purchase.shareFragment);
  const orderShare = Boolean(linked && linked.via === "owner" && linked.shareFragment);
  return {
    pill,
    rows,
    ...(Object.keys(details).length ? { details } : {}),
    canShareDetails: audience === "owner" && (purchaseShare || orderShare),
  };
}

/**
 * `/verify/<pda>#purchase=<invoice>&order=<request>`: request content travels
 * only in the fragment, which never reaches a server. Either part is optional.
 */
export function purchaseAuditPath(receiptPda: string, purchaseFragment?: string, orderFragment?: string): string {
  const parts = [
    ...(purchaseFragment ? [`purchase=${purchaseFragment}`] : []),
    ...(orderFragment ? [`order=${orderFragment}`] : []),
  ];
  return parts.length ? `${publicReceiptPath(receiptPda)}#${parts.join("&")}` : publicReceiptPath(receiptPda);
}

function fragmentValue(hash: string, name: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of raw.split("&")) {
    const [key, value] = part.split("=");
    if (key === name && value) return value;
  }
  return null;
}

/** The `purchase=` value from a location hash, or null when there is none. */
export function purchaseFragmentFromHash(hash: string): string | null {
  return fragmentValue(hash, "purchase");
}

/** The `order=` value (a signed mandate request) from a location hash, or null. */
export function orderFragmentFromHash(hash: string): string | null {
  return fragmentValue(hash, "order");
}
