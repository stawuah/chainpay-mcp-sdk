import { publicReceiptUrl } from "./model";

export type ShareResult =
  | { status: "shared" }
  | { status: "copied" }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export function shareCopy(amountLabel: string, tokenLabel: string, receiptPda: string, origin: string, path?: string): { title: string; text: string; url: string } {
  const url = path ? `${origin.replace(/\/$/, "")}${path}` : publicReceiptUrl(receiptPda, origin);
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
  /** Path to share instead of the plain public receipt, such as an audit link. */
  path?: string;
  share?: (data: ShareData) => Promise<void>;
  clipboardWrite?: (value: string) => Promise<void>;
}): Promise<ShareResult> {
  const origin = input.origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const payload = shareCopy(input.amountLabel, input.tokenLabel, input.receiptPda, origin, input.path);
  const share = input.share ?? (typeof navigator !== "undefined" && typeof navigator.share === "function"
    ? (data: ShareData) => navigator.share(data)
    : undefined);
  const clipboardWrite = input.clipboardWrite ?? (typeof navigator !== "undefined" && navigator.clipboard
    ? (value: string) => navigator.clipboard.writeText(value)
    : undefined);

  try {
    if (share) {
      try {
        await share({ title: payload.title, text: payload.text, url: payload.url });
        return { status: "shared" };
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return { status: "cancelled" };
        if (clipboardWrite) {
          await clipboardWrite(`${payload.text}\n${payload.url}`);
          return { status: "copied" };
        }
        throw cause;
      }
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

/** `details`: true or "invoice" when the link carries the invoice, "order" when it carries only the order. */
export function shareStatusCopy(result: ShareResult, details: boolean | "invoice" | "order" = false): string {
  const what = details === "order" ? "order details" : "invoice details";
  if (result.status === "shared") return details ? `Receipt with ${what} sent from your browser.` : "Receipt sent from your browser.";
  if (result.status === "copied") return details ? `Receipt link with ${what} copied.` : "ChainPay receipt link copied.";
  if (result.status === "cancelled") return "";
  return result.message;
}
