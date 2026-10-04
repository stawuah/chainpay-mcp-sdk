/*
 * Signed statement repayments whose outcome isn't known yet, per statement
 * digest (not per spending permission: the receipt address depends on the
 * permission, so paying again through another one would be a second payment).
 *
 * Written the moment the wallet returns a signed repayment, before it is
 * handed to the relay. Cleared only once Solana shows a receipt, or the signed
 * transaction's blockhash has expired with no receipt, so it can never land.
 * Browser storage is a convenience: the on-chain receipt check runs either way.
 */

export type RepaymentAttempt = { mandatePda: string; receiptPda: string; lastValidBlockHeight?: number; at: string };

const key = (digest: string) => `cp-card-repay:${digest}`;

export function readRepaymentAttempts(digest: string): RepaymentAttempt[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key(digest)) ?? "[]") as unknown;
    return Array.isArray(raw)
      ? raw.filter((item): item is RepaymentAttempt => typeof item?.mandatePda === "string" && typeof item?.receiptPda === "string")
      : [];
  } catch {
    return [];
  }
}

function write(digest: string, attempts: RepaymentAttempt[]): void {
  try {
    if (attempts.length) window.localStorage.setItem(key(digest), JSON.stringify(attempts));
    else window.localStorage.removeItem(key(digest));
  } catch { /* unavailable */ }
}

export function recordRepaymentAttempt(digest: string, attempt: Omit<RepaymentAttempt, "at">): void {
  const rest = readRepaymentAttempts(digest).filter((item) => item.receiptPda !== attempt.receiptPda);
  write(digest, [...rest, { ...attempt, at: new Date().toISOString() }]);
}

export function clearRepaymentAttempt(digest: string, receiptPda: string): void {
  write(digest, readRepaymentAttempts(digest).filter((item) => item.receiptPda !== receiptPda));
}

/**
 * Has this statement been paid, or is a signed attempt unresolved, under ANY permission?
 * Block height is read before the receipts: an attempt past its last valid height with no
 * receipt can never land, so it is cleared; anything else recorded stays unknown.
 */
export async function lookupRepayment(input: {
  digest: string;
  mandateAddresses: string[];
  getBlockHeight: () => Promise<number>;
  /** Receipt address for (permission, statement), or null when Solana has none. */
  findReceipt: (mandate: string) => Promise<string | null>;
}): Promise<{ state: "none" } | { state: "paid" | "unknown"; receiptPda: string; mandatePda: string }> {
  const recorded = readRepaymentAttempts(input.digest);
  const height = recorded.length ? await input.getBlockHeight() : 0;
  const candidates = [...new Set([...recorded.map((item) => item.mandatePda), ...input.mandateAddresses])];
  for (const mandate of candidates) {
    const receipt = await input.findReceipt(mandate);
    if (receipt) {
      for (const item of recorded) clearRepaymentAttempt(input.digest, item.receiptPda);
      return { state: "paid", receiptPda: receipt, mandatePda: mandate };
    }
  }
  for (const item of recorded) {
    if (item.lastValidBlockHeight !== undefined && height > item.lastValidBlockHeight) clearRepaymentAttempt(input.digest, item.receiptPda);
    else return { state: "unknown", receiptPda: item.receiptPda, mandatePda: item.mandatePda };
  }
  return { state: "none" };
}
