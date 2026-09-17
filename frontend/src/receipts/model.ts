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
};

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

export function isPlausibleReceiptPda(value: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(value.trim());
}

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
      detail: "The program accepted this payment under the mandate.",
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
