/*
  Display-only formatting for token amounts (DESIGN.md "Amount presentation").

  - Exact: bigint arithmetic only, so values above 2^53 keep every digit.
  - Grouped thousands: 1,250.00.
  - At least two fraction digits; any further significant digit is kept
    (4.500001 is never rounded to 4.50).
  - The caller supplies verified mint decimals. Nothing here infers decimals.

  This never feeds an input or a transaction: those keep parseTokenAmount /
  formatTokenAmount, whose output round-trips through the parser.
*/
const MIN_FRACTION_DIGITS = 2;
const MAX_DECIMALS = 255;

function toBigInt(baseUnits: bigint | string): bigint {
  if (typeof baseUnits === "bigint") return baseUnits;
  const text = baseUnits.trim();
  if (!/^-?\d+$/.test(text)) throw new TypeError(`Base units must be an integer, got "${baseUnits}".`);
  return BigInt(text);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatDisplayAmount(baseUnits: bigint | string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`Mint decimals must be an integer from 0 to ${MAX_DECIMALS}, got ${decimals}.`);
  }
  const value = toBigInt(baseUnits);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const remainder = magnitude % scale;
  const fullFraction = decimals === 0 ? "" : remainder.toString().padStart(decimals, "0");
  const significant = fullFraction.replace(/0+$/, "");
  const fraction = significant.padEnd(MIN_FRACTION_DIGITS, "0");
  return `${negative ? "-" : ""}${groupThousands(whole.toString())}.${fraction}`;
}
