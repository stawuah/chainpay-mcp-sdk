import type { Address, ChainPayClient } from "@chainpay/sdk";

const TOKEN_LABELS: Record<string, string> = {
  // ChainPay Devnet assets.
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC",
  "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM": "PYUSD",
};

export function tokenLabel(mint: Address): string {
  return TOKEN_LABELS[mint] ?? "tokens";
}

export function formatTokenAmount(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();

  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export async function displayTokenAmounts(
  client: ChainPayClient,
  mint: Address,
  amounts: Record<string, bigint>,
) {
  try {
    const decimals = await client.getMintDecimals(mint);
    return {
      mint,
      symbol: tokenLabel(mint),
      decimals,
      amounts: Object.fromEntries(
        Object.entries(amounts).map(([name, value]) => [name, formatTokenAmount(value, decimals)]),
      ),
      note: "Amounts are in whole token units; the raw object contains base units.",
    };
  } catch {
    // A missing or temporarily unavailable mint should not make a read-only
    // mandate or receipt lookup fail.
    return undefined;
  }
}
