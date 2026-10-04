/*
 * Dollar text the owner types ↔ cent strings the SDK works in. Exact: no
 * floats, at most two decimals, never rounded.
 */

const DOLLARS = /^(0|[1-9][0-9]{0,13})(?:\.([0-9]{1,2}))?$/;

/** "500" → "50000", "30.5" → "3050", "1,250.00" → "125000". null when it isn't an exact dollar amount. */
export function dollarsToCents(text: string): string | null {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,(?=\d{3}(\D|$))/g, "");
  const match = cleaned.match(DOLLARS);
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return cents.toString();
}

/** "50000" → "500", "3050" → "30.50". */
export function centsToDollarInput(cents: string): string {
  const value = BigInt(cents);
  const whole = (value / 100n).toString();
  const rest = value % 100n;
  return rest === 0n ? whole : `${whole}.${rest.toString().padStart(2, "0")}`;
}
