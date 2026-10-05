// Same-signature status recovery. The page saves the signature of a signed tip
// before it sends it, so an uncertain send (lost response, closed tab, RPC
// hiccup) is checked again by that same signature instead of asking for a new
// tip. Re-checking never signs or sends anything.
import type { SupportAsset } from "./donation";

export type PendingTip = {
  signature: string;
  lastValidBlockHeight: number;
  asset: SupportAsset;
  amount: string; // base units, exact
  label: string; // what the card showed, e.g. "0.1 SOL"
  savedAt: number;
};

export type TipStatus =
  | { status: "confirmed" }
  | { status: "failed"; message: string }
  | { status: "expired" }
  | { status: "unknown" };

const KEY = "chainpay-support:pending-tip:v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): Store | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function savePendingTip(tip: PendingTip, storage: Store | null = store()) {
  try {
    storage?.setItem(KEY, JSON.stringify(tip));
  } catch {
    // Private mode or blocked storage: the in-page state still holds the signature.
  }
}

export function loadPendingTip(storage: Store | null = store()): PendingTip | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const tip = JSON.parse(raw) as Partial<PendingTip>;
    if (typeof tip.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(tip.signature)) return null;
    if (typeof tip.lastValidBlockHeight !== "number" || (tip.asset !== "SOL" && tip.asset !== "USDC")) return null;
    if (typeof tip.amount !== "string" || !/^\d+$/.test(tip.amount) || typeof tip.label !== "string") return null;
    return { signature: tip.signature, lastValidBlockHeight: tip.lastValidBlockHeight, asset: tip.asset, amount: tip.amount, label: tip.label, savedAt: Number(tip.savedAt) || 0 };
  } catch {
    return null;
  }
}

export function clearPendingTip(signature?: string, storage: Store | null = store()) {
  try {
    if (signature && loadPendingTip(storage)?.signature !== signature) return;
    storage?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

export type StatusRpc = {
  getSignatureStatuses(signatures: string[], config: { searchTransactionHistory: boolean }): Promise<{ value: ({ err: unknown; confirmationStatus?: string | null } | null)[] }>;
  getBlockHeight(commitment: "confirmed"): Promise<number>;
};

/** One look at the same signature. "unknown" means ask again later, never "send again". */
export async function recheckTip(rpc: StatusRpc, tip: Pick<PendingTip, "signature" | "lastValidBlockHeight">): Promise<TipStatus> {
  try {
    const { value } = await rpc.getSignatureStatuses([tip.signature], { searchTransactionHistory: true });
    const status = value[0];
    if (status?.err) return { status: "failed", message: "The transaction failed on-chain. Nothing was taken except the network fee." };
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { status: "confirmed" };
    if (!status) {
      // Only a blockhash that has expired with no trace of the transaction is a definite "it didn't land".
      const height = await rpc.getBlockHeight("confirmed");
      if (height > tip.lastValidBlockHeight) return { status: "expired" };
    }
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/** True once the tracker's public ledger lists this signature. */
export function isIndexed(signature: string, recent: { signature: string }[] | undefined) {
  return Boolean(recent?.some((row) => row.signature === signature));
}
