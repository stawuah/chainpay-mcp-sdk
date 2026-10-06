import {
  receiptPolicy,
  receiptsToCsv,
  relayObservedPolicy,
  type PaymentReceipt,
  type ReceiptCsvRow,
} from "@chainpayhq/sdk";
import { publicReceiptUrl } from "./model";

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** chainpay-receipts-YYYY-MM-DD.csv, in the reader's local date. */
export function receiptsCsvFilename(now: Date = new Date()): string {
  return `chainpay-receipts-${localDate(now)}.csv`;
}

/** chainpay-statement-<first 8 of the mandate>-YYYY-MM-DD.csv for one permission. */
export function statementCsvFilename(mandateAddress: string, now: Date = new Date()): string {
  return `chainpay-statement-${mandateAddress.slice(0, 8)}-${localDate(now)}.csv`;
}

const BLOCK_TIME_TIMEOUT_MS = 4_000;
const ORDER_TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/**
 * One CSV for the receipts the owner sees. Limits come from each receipt's
 * on-chain snapshot, else the relay's observation when the owner's session
 * can read it, else "not-recorded". Dates come from block time and stay
 * empty when it cannot be read; they are never estimated.
 */
export async function buildReceiptsCsv(input: {
  receipts: readonly PaymentReceipt[];
  decimalsByMint: ReadonlyMap<string, number | null>;
  tokenLabel: (mint: string) => string;
  origin: string;
  blockTime: (slot: bigint) => Promise<number | null>;
  relayPolicy?: (receiptAddress: string) => Promise<unknown>;
  /** PO number and Order match pill for a receipt, as the owner sees it. Empty when unknown. */
  order?: (receipt: PaymentReceipt) => Promise<{ poNumber?: string; orderMatch?: string } | null>;
}): Promise<string> {
  const slots = [...new Set(input.receipts.map((receipt) => receipt.executedAtSlot))];
  const times = new Map<bigint, number | null>();
  await Promise.all(slots.map(async (slot) => {
    times.set(slot, await withTimeout(input.blockTime(slot), null, BLOCK_TIME_TIMEOUT_MS));
  }));
  const rows: ReceiptCsvRow[] = await Promise.all(input.receipts.map(async (receipt) => {
    const snapshot = receipt.policySnapshot ?? null;
    const relay = !snapshot && input.relayPolicy
      ? relayObservedPolicy(await input.relayPolicy(receipt.address).catch(() => null))
      : null;
    const order = input.order
      ? await withTimeout(input.order(receipt), null, ORDER_TIMEOUT_MS)
      : null;
    return {
      receipt,
      decimals: input.decimalsByMint.get(receipt.mint) ?? null,
      symbol: input.tokenLabel(receipt.mint),
      blockTime: times.get(receipt.executedAtSlot) ?? null,
      policy: receiptPolicy({ policySnapshot: snapshot }, relay),
      verifyUrl: publicReceiptUrl(receipt.address, input.origin),
      ...(order?.poNumber ? { poNumber: order.poNumber } : {}),
      ...(order?.orderMatch ? { orderMatch: order.orderMatch } : {}),
    };
  }));
  return receiptsToCsv(rows);
}

/** Save text as a file through a temporary link. Nothing leaves the browser. */
export function downloadTextFile(text: string, filename: string, type = "text/csv;charset=utf-8", doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  doc.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
