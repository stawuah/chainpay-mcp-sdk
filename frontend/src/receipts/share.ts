import { publicReceiptUrl } from "./model";

export type ShareResult =
  | { status: "shared" }
  | { status: "copied" }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export function shareCopy(amountLabel: string, tokenLabel: string, receiptPda: string, origin: string): { title: string; text: string; url: string } {
  const url = publicReceiptUrl(receiptPda, origin);
  return {
    title: "ChainPay payment receipt",
    text: `ChainPay receipt: ${amountLabel} ${tokenLabel} on Solana Devnet.`,
    url,
  };
}

export async function sharePublicReceipt(input: {
  amountLabel: string;
  tokenLabel: string;
  receiptPda: string;
  origin?: string;
  share?: (data: ShareData) => Promise<void>;
  clipboardWrite?: (value: string) => Promise<void>;
}): Promise<ShareResult> {
  const origin = input.origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const payload = shareCopy(input.amountLabel, input.tokenLabel, input.receiptPda, origin);
  const share = input.share ?? (typeof navigator !== "undefined" && typeof navigator.share === "function"
    ? (data: ShareData) => navigator.share(data)
    : undefined);
  const clipboardWrite = input.clipboardWrite ?? (typeof navigator !== "undefined" && navigator.clipboard
    ? (value: string) => navigator.clipboard.writeText(value)
    : undefined);

  try {
    if (share) {
      await share({ title: payload.title, text: payload.text, url: payload.url });
      return { status: "shared" };
    }
    if (clipboardWrite) {
      await clipboardWrite(`${payload.text}\n${payload.url}`);
      return { status: "copied" };
    }
    return { status: "failed", message: "This browser could not share or copy the ChainPay receipt URL." };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return { status: "cancelled" };
    return { status: "failed", message: "The browser could not share this receipt. Copy the ChainPay URL instead." };
  }
}

export function shareStatusCopy(result: ShareResult): string {
  if (result.status === "shared") return "Receipt sent from your browser.";
  if (result.status === "copied") return "ChainPay receipt link copied.";
  if (result.status === "cancelled") return "";
  return result.message;
}
