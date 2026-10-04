/*
  Overview spending math. Totals are kept separate by mint (never summed
  across tokens) and labelled "across loaded permissions": they describe the
  permissions this page has read, not a wallet balance or a card budget.

  The usage ring describes the selected token's ACTIVE permissions only:
  spent ÷ limit. Paused, expired and revoked permissions are excluded, and
  the page says so beside the ring.
*/
export type SpendingPermission = {
  allowedMint: string;
  status: string;
  amountSpent: bigint;
  totalLimit: bigint;
};

export type MintTotals = {
  mint: string;
  /** Active permissions only: what the ring and its figures describe. */
  active: { spent: bigint; limit: bigint; remaining: bigint; count: number };
  /** Every loaded permission for this mint, any status. */
  permissionCount: number;
};

export function totalsByMint(permissions: readonly SpendingPermission[]): MintTotals[] {
  const order: string[] = [];
  const byMint = new Map<string, MintTotals>();
  for (const permission of permissions) {
    let total = byMint.get(permission.allowedMint);
    if (!total) {
      total = { mint: permission.allowedMint, active: { spent: 0n, limit: 0n, remaining: 0n, count: 0 }, permissionCount: 0 };
      byMint.set(permission.allowedMint, total);
      order.push(permission.allowedMint);
    }
    total.permissionCount += 1;
    if (permission.status !== "active") continue;
    total.active.count += 1;
    total.active.spent += permission.amountSpent;
    total.active.limit += permission.totalLimit;
    total.active.remaining += permission.totalLimit > permission.amountSpent ? permission.totalLimit - permission.amountSpent : 0n;
  }
  return order.map((mint) => byMint.get(mint)!);
}

export type UsageRingState =
  | { kind: "normal" | "exhausted"; percent: number; fraction: number; warning: boolean }
  | { kind: "unavailable"; reason: "zero-limit" | "metadata" };

/** Warning tone from 90% used (DESIGN.md "Usage ring"). */
export const RING_WARNING_PERCENT = 90;

/**
 * Ring geometry from exact base units. Percent is scaled in bigint first
 * (basis points), so limits above 2^53 keep their precision; only the final
 * arc uses a float, and the exact figures always sit beside it.
 */
export function usageRing({ spent, limit, decimalsKnown }: { spent: bigint; limit: bigint; decimalsKnown: boolean }): UsageRingState {
  if (!decimalsKnown) return { kind: "unavailable", reason: "metadata" };
  if (limit <= 0n) return { kind: "unavailable", reason: "zero-limit" };
  const clamped = spent < 0n ? 0n : spent > limit ? limit : spent;
  const basisPoints = Number((clamped * 10_000n) / limit);
  const percent = basisPoints / 100;
  const exhausted = clamped >= limit;
  return {
    kind: exhausted ? "exhausted" : "normal",
    percent,
    fraction: basisPoints / 10_000,
    warning: exhausted || percent >= RING_WARNING_PERCENT,
  };
}
