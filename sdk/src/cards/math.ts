/*
 * Card money math. Every value is an integer number of US cents (contracts.md
 * preamble): bigint in code, decimal-integer strings on the wire, never a
 * float and never a JS number for anything persisted.
 */

const CENTS_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const BPS_DENOMINATOR = 10_000n;

export type CentsString = string;

/** Parse a wire amount (`"50250"`). Rejects signs, decimals, leading zeros and more than 16 digits. */
export function parseCents(value: unknown, name = "amountCents"): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${name} can't be negative`);
    return value;
  }
  if (typeof value !== "string" || !CENTS_PATTERN.test(value)) {
    throw new Error(`${name} must be a whole number of cents written as a string, like "2000"`);
  }
  return BigInt(value);
}

/** Signed cents for statement totals and refund fees, where negative means credit (`"-1005"`). */
export function parseSignedCents(value: unknown, name = "amountCents"): bigint {
  if (typeof value === "string" && value.startsWith("-") && value !== "-0") return -parseCents(value.slice(1), name);
  return parseCents(value, name);
}

export function centsToString(value: bigint): CentsString {
  if (value < 0n) throw new Error("cents can't be negative on the wire");
  return value.toString();
}

/** Platform fee on one amount: ceil(x · bps / 10 000), integer only (contracts.md §1.5). */
export function feeCents(amountCents: bigint, feeBps: number): bigint {
  assertBps(feeBps);
  if (amountCents < 0n) throw new Error("amount can't be negative");
  return (amountCents * BigInt(feeBps) + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR;
}

/** The most the owner can ever owe for one period: budget + fee(budget). $500 @ 50 bps → $502.50. */
export function maxObligationCents(budgetCents: bigint, feeBps: number): bigint {
  return budgetCents + feeCents(budgetCents, feeBps);
}

/** available = budget − (captured + reserved), floored at zero. */
export function availableCents(budgetCents: bigint, capturedCents: bigint, reservedCents: bigint): bigint {
  const used = capturedCents + reservedCents;
  return used >= budgetCents ? 0n : budgetCents - used;
}

/** Outstanding after a capture: += amount + fee(amount). */
export function outstandingAfterCapture(outstandingCents: bigint, capturedCents: bigint, feeBps: number): bigint {
  return outstandingCents + capturedCents + feeCents(capturedCents, feeBps);
}

/** Outstanding after a refund: −= min(refund + fee(refund), outstanding). */
export function outstandingAfterRefund(outstandingCents: bigint, refundCents: bigint, feeBps: number): bigint {
  const credit = refundCents + feeCents(refundCents, feeBps);
  return credit >= outstandingCents ? 0n : outstandingCents - credit;
}

export type StatementLineInput = { kind: "purchase" | "refund" | "adjustment_debit" | "adjustment_credit"; amountCents: bigint };

export type StatementTotals = {
  purchasesCents: bigint;
  refundsCents: bigint;
  /** Signed: refund fees are negative, using the same ceil formula. */
  feeCents: bigint;
  /** Signed: negative means the period ended in credit. */
  totalCents: bigint;
};

/** Statement totals (contracts.md §7.1): total = purchases − refunds + Σ per-line fees. */
export function statementTotals(lines: readonly StatementLineInput[], feeBps: number): StatementTotals {
  let purchasesCents = 0n;
  let refundsCents = 0n;
  let fees = 0n;
  for (const line of lines) {
    if (line.amountCents < 0n) throw new Error("statement line amounts are unsigned; use the line kind for direction");
    const debit = line.kind === "purchase" || line.kind === "adjustment_debit";
    if (debit) {
      purchasesCents += line.amountCents;
      fees += feeCents(line.amountCents, feeBps);
    } else {
      refundsCents += line.amountCents;
      fees -= feeCents(line.amountCents, feeBps);
    }
  }
  // Never clamp: a negative total is a credit the owner is owed, not zero.
  return { purchasesCents, refundsCents, feeCents: fees, totalCents: purchasesCents - refundsCents + fees };
}

/** Exact dollars for people: 50250n → "$502.50". No rounding is ever applied. */
export function formatUsdCents(value: bigint | CentsString): string {
  const cents = typeof value === "bigint" ? value : parseSignedCents(value);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${rest}`;
}

/** 50 → "0.5%", 125 → "1.25%", 0 → "0%". */
export function formatFeeBps(feeBps: number): string {
  assertBps(feeBps);
  const whole = Math.trunc(feeBps / 100);
  const frac = (feeBps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}%` : `${whole}%`;
}

/** USD stablecoin base units for a statement repayment: cents × 10^(decimals−2). USDC (6) → ×10 000. */
export function centsToTokenBaseUnits(cents: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 2) throw new Error("token must have at least 2 decimals");
  return cents * 10n ** BigInt(decimals - 2);
}

/** Owner-facing review numbers before signing `set_policy` (PLAN F). */
export function policyReviewSummary(budgetCents: bigint, maxPurchaseCents: bigint, feeBps: number) {
  const obligation = maxObligationCents(budgetCents, feeBps);
  return {
    budgetCents: centsToString(budgetCents),
    maxPurchaseCents: centsToString(maxPurchaseCents),
    feeBps,
    feeCentsAtFullBudget: centsToString(obligation - budgetCents),
    maxObligationCents: centsToString(obligation),
    display: {
      budget: formatUsdCents(budgetCents),
      maxPurchase: formatUsdCents(maxPurchaseCents),
      fee: formatFeeBps(feeBps),
      maxObligation: formatUsdCents(obligation),
    },
  };
}

function assertBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1_000) throw new Error("feeBps must be a whole number from 0 to 1000");
}
