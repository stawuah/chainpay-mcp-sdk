export function parseTokenAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Enter a valid non-negative token amount.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`This mint supports ${decimals} decimal places.`);
  }
  const scale = 10n ** BigInt(decimals);
  const fractionalUnits = fraction.padEnd(decimals, "0");
  return BigInt(whole) * scale + BigInt(fractionalUnits || "0");
}

export function formatTokenAmount(value: bigint, decimals: number | null) {
  if (decimals === null) return `${value.toString()} base units`;
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export function reviewExactAmount(value: string, decimals: number) {
  return formatTokenAmount(parseTokenAmount(value, decimals), decimals);
}
