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
  | { status: "unavailable"; reason: string };

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

export function sellerStamp(seller: SellerStatementState): ReceiptStamp {
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
  "relay-observed": "Seen by the ChainPay relay after payment, not stored on Solana",
  "not-recorded": "Not recorded for this receipt. Showing today’s limits.",
};

export type PolicyAtPaymentDisplay = {
  source: PolicyAtPaymentView["source"];
  caption: string;
  /** Plain lines in token units. Empty for not-recorded. */
  rows: string[];
};

export function policyAtPayment(receipt: ReceiptView, nowMs = Date.now()): PolicyAtPaymentDisplay {
  const policy = receipt.policy ?? { source: "not-recorded" as const };
  if (policy.source === "not-recorded") {
    return { source: policy.source, caption: POLICY_SOURCE_CAPTION[policy.source], rows: [] };
  }
  const limits = policy.limits;
  const rows = [
    `${tokenUnits(receipt, receipt.amount.baseUnits)} ≤ ${tokenUnits(receipt, limits.maxPerPayment)} per payment`,
  ];
  // A relay read taken after a later payment counts that payment too. Leave
  // the running totals out rather than show numbers this payment never had.
  const laterPaymentsCounted = policy.source === "relay-observed" && policy.includesLaterPayments;
  if (!laterPaymentsCounted) {
    rows.push(`${formatTokenUnits(limits.amountSpentAfter, receipt.amount.decimals, "")
      .trim()} of ${tokenUnits(receipt, limits.totalLimit)} used after this payment`);
    if (isUnsigned(limits.maxPaymentCount) && limits.maxPaymentCount !== "0") {
      rows.push(`Payment ${limits.paymentCountAfter} of ${limits.maxPaymentCount}`);
    }
  }
  const expiry = estimateSlotDate(limits.expiresAtSlot, receipt.currentSlot, nowMs);
  rows.push(expiry ? `Paid before expiry (≈ ${expiry})` : "Paid before expiry");
  return { source: policy.source, caption: POLICY_SOURCE_CAPTION[policy.source], rows };
}

export function allowedStampDetail(policy: PolicyAtPaymentView | undefined): string {
  if (!policy || policy.source === "not-recorded") {
    return "The program accepted this payment under this spending permission. Its limits at payment were not recorded for this receipt.";
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

export type OrderMatchPill = "Matched" | "Payee differs" | "No order";

export type OrderMatchRow = {
  key: "order" | "invoice" | "invoice-mismatch" | "payment";
  tone: "yes" | "no";
  text: string;
};

export type OrderMatchDisplay = {
  pill: OrderMatchPill;
  rows: OrderMatchRow[];
  /** Request content. Present only for the owner or a verified audit link. */
  details?: {
    invoice: string;
    description?: string;
    lineItems?: PurchaseLineItemView[];
  };
  canShareDetails: boolean;
};

const MISMATCH_WORD: Record<PurchaseMismatch, string> = {
  amount: "amount",
  mint: "token",
  recipient: "payee",
};

/**
 * The Order match section, or null when there is nothing verifiable to show.
 * There is no purchase order yet, so the pill is "No order" unless the
 * payment went to a different payee than the invoice named. A later order
 * row slots in ahead of the invoice row and can turn the pill to "Matched".
 */
export function orderMatch(purchase: PurchaseProofState | undefined, audience: OrderMatchAudience): OrderMatchDisplay | null {
  if (!purchase || purchase.status === "none") return null;
  if (purchase.status === "failed") {
    // A public reader without a verified request gets no claim at all.
    if (audience === "public") return null;
    return {
      pill: "No order",
      rows: [
        { key: "invoice", tone: "no", text: `Invoice not verified: ${purchase.reason}. Nothing from it is shown.` },
        { key: "payment", tone: "yes", text: "Paid on Solana" },
      ],
      canShareDetails: false,
    };
  }
  const showContent = audience === "owner" || (audience === "link" && purchase.via === "link");
  const rows: OrderMatchRow[] = [
    { key: "invoice", tone: "yes", text: showContent ? "Invoice signed by seller" : "Invoice signed by seller · details private" },
  ];
  if (purchase.mismatches.length) {
    const words = purchase.mismatches.map((item) => MISMATCH_WORD[item]).join(", ");
    rows.push({ key: "invoice-mismatch", tone: "no", text: `This payment’s ${words} differs from the invoice` });
  }
  rows.push({ key: "payment", tone: "yes", text: "Paid on Solana" });
  return {
    pill: purchase.mismatches.includes("recipient") ? "Payee differs" : "No order",
    rows,
    ...(showContent
      ? {
          details: {
            invoice: purchase.invoice,
            ...(purchase.description ? { description: purchase.description } : {}),
            ...(purchase.lineItems?.length ? { lineItems: purchase.lineItems } : {}),
          },
        }
      : {}),
    canShareDetails: audience === "owner" && purchase.via === "owner" && Boolean(purchase.shareFragment),
  };
}

/** `/verify/<pda>#purchase=<fragment>`: request content travels only in the fragment. */
export function purchaseAuditPath(receiptPda: string, fragment: string): string {
  return `${publicReceiptPath(receiptPda)}#purchase=${fragment}`;
}

/** The `purchase=` value from a location hash, or null when there is none. */
export function purchaseFragmentFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of raw.split("&")) {
    const [key, value] = part.split("=");
    if (key === "purchase" && value) return value;
  }
  return null;
}
