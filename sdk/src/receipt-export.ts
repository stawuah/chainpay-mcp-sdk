import type {
  Address,
  PaymentReceipt,
  PaymentRequestPayload,
  ReceiptPolicy,
  ReceiptPolicyLimits,
} from "./types.js";
import { bytesToHex, formatExactTokenAmount } from "./receipt.js";

/**
 * The limits beside a receipt, preferring the snapshot the program wrote into
 * the receipt itself. A relay observation is used only when there is none.
 */
export function receiptPolicy(
  receipt: Pick<PaymentReceipt, "policySnapshot">,
  relayObserved?: ReceiptPolicy | null,
): ReceiptPolicy {
  const snapshot = receipt.policySnapshot;
  if (snapshot) {
    const { version: _version, ...limits } = snapshot;
    return { source: "on-chain", limits };
  }
  if (relayObserved?.source === "relay-observed") return relayObserved;
  return { source: "not-recorded" };
}

function u64Field(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= 18_446_744_073_709_551_615n ? parsed : null;
}

/**
 * Read the `policy` object the ChainPay relay returns from
 * `GET /v1/receipts/{receipt}`. Only a well-formed relay observation is
 * accepted; anything else is null, never a guessed limit. An "on-chain" value
 * from the relay is ignored because the receipt account is read directly.
 */
export function relayObservedPolicy(value: unknown): ReceiptPolicy | null {
  if (!value || typeof value !== "object") return null;
  const policy = value as Record<string, unknown>;
  if (policy.source !== "relay-observed") return null;
  const fields = {
    maxPerPayment: u64Field(policy.max_per_payment),
    totalLimit: u64Field(policy.total_limit),
    amountSpentAfter: u64Field(policy.amount_spent_after),
    paymentCountAfter: u64Field(policy.payment_count_after),
    maxPaymentCount: u64Field(policy.max_payment_count),
    expiresAtSlot: u64Field(policy.expires_at_slot),
    cooldownSlots: u64Field(policy.cooldown_slots),
  };
  const observedAtSlot = u64Field(policy.observed_at_slot);
  if (observedAtSlot === null || Object.values(fields).some((field) => field === null)) return null;
  return {
    source: "relay-observed",
    limits: fields as ReceiptPolicyLimits,
    observedAtSlot,
    includesLaterPayments: policy.includes_later_payments === true,
  };
}

export function receiptExplorerUrl(
  receipt: Pick<PaymentReceipt, "address" | "transactionSignature">,
  cluster: "devnet" | "mainnet-beta" = "devnet",
): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return receipt.transactionSignature
    ? `https://explorer.solana.com/tx/${receipt.transactionSignature}${suffix}`
    : `https://explorer.solana.com/address/${receipt.address}${suffix}`;
}

export type ReceiptCsvRow = {
  receipt: PaymentReceipt;
  /** Verified mint decimals. Null keeps amounts in labeled base units. */
  decimals: number | null;
  symbol?: string;
  /** Unix seconds from getBlockTime for the executed slot. Null when unknown. */
  blockTime?: number | null;
  /** Defaults to the receipt's own snapshot, else "not-recorded". */
  policy?: ReceiptPolicy;
  /** From the merchant-signed request, only after verifyReceiptPurchase. */
  purpose?: Partial<Pick<PaymentRequestPayload, "invoice" | "description" | "lineItems">>;
  verifyUrl?: string;
  explorerUrl?: string;
};

/**
 * Accounting tools read the first five columns; the rest let a reader trace
 * every row back to Solana.
 */
export const RECEIPT_CSV_HEADERS = [
  "Date",
  "Description",
  "Amount",
  "Payee",
  "Reference",
  "Token",
  "Agent",
  "Spending permission",
  "Per-payment limit",
  "Total limit",
  "Spent after",
  "Limits source",
  "Receipt",
  "Verify URL",
  "Explorer URL",
] as const;

/** Exact decimal, trailing zeros trimmed. Unknown decimals stay labeled base units. */
function exactAmount(value: bigint, decimals: number | null): string {
  const exact = formatExactTokenAmount(value, decimals);
  if (exact.displayKind === "base-units") return `${exact.baseUnits} base units`;
  return exact.display.includes(".") ? exact.display.replace(/0+$/, "").replace(/\.$/, "") : exact.display;
}

function isoDate(blockTime: number | null | undefined): string {
  if (blockTime === null || blockTime === undefined || !Number.isFinite(blockTime)) return "";
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

/**
 * One CSV cell. A value a spreadsheet would run as a formula (leading =, +,
 * -, @, tab, or carriage return) is prefixed with an apostrophe so it stays
 * text. Then RFC 4180 quoting: wrap in quotes when the value holds a comma,
 * quote, or line break, doubling inner quotes.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function description(purpose: ReceiptCsvRow["purpose"]): string {
  if (purpose?.description) return purpose.description;
  if (purpose?.lineItems?.length) return purpose.lineItems.map((item) => item.label).join("; ");
  return "";
}

function rowCells(row: ReceiptCsvRow): string[] {
  const { receipt, decimals } = row;
  const policy = row.policy ?? receiptPolicy(receipt);
  const limits = policy.source === "not-recorded" ? null : policy.limits;
  // A relay read taken after a later payment no longer says what was spent
  // after this one. Leave the cell empty rather than show a larger number.
  const spentAfterKnown = limits && !(policy.source === "relay-observed" && policy.includesLaterPayments);
  const payee: Address = receipt.recipientTokenAccount;
  return [
    isoDate(row.blockTime),
    description(row.purpose),
    exactAmount(receipt.amount, decimals),
    payee,
    row.purpose?.invoice ?? bytesToHex(receipt.invoiceHash),
    row.symbol ?? receipt.mint,
    receipt.agent,
    receipt.mandate,
    limits ? exactAmount(limits.maxPerPayment, decimals) : "",
    limits ? exactAmount(limits.totalLimit, decimals) : "",
    spentAfterKnown ? exactAmount(limits.amountSpentAfter, decimals) : "",
    policy.source,
    receipt.address,
    row.verifyUrl ?? "",
    row.explorerUrl ?? receiptExplorerUrl(receipt),
  ];
}

/**
 * One CSV of receipts with QuickBooks-friendly leading columns (Date,
 * Description, Amount, Payee, Reference), then the ChainPay columns. Amounts
 * are exact decimals from base units, never floating point. CRLF line
 * endings, header row always present.
 */
export function receiptsToCsv(rows: readonly ReceiptCsvRow[]): string {
  const lines = [RECEIPT_CSV_HEADERS.map(csvCell), ...rows.map((row) => rowCells(row).map(csvCell))];
  return lines.map((cells) => cells.join(",")).join("\r\n") + "\r\n";
}
