import { parsePathname } from "../routing/paths";
import { classifyReceiptPda } from "../receipts/model";

export type ReceiptInput =
  | { ok: true; receiptPda: string; /** Audit-link fragment (#purchase=…), kept local. */ hash: string }
  | { ok: false; error: string };

export const RECEIPT_INPUT_ERRORS = {
  empty: "Paste a receipt address or a receipt link.",
  notReceiptLink: "That link isn't a receipt link. Receipt links end in /verify/ and the receipt address.",
  badAddressInLink: "The address in that link isn't a valid receipt address.",
  badAddress: "That isn't a valid receipt address or receipt link.",
} as const;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// "chainpay.example/verify/…" without a scheme.
const HOST_PATH = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\//i;

/**
 * A raw receipt PDA or a full `/verify/<pda>` link, from any origin. Only the
 * text is parsed; the pasted origin is never fetched or followed.
 */
export function parseReceiptInput(input: string): ReceiptInput {
  const value = input.trim();
  if (!value) return { ok: false, error: RECEIPT_INPUT_ERRORS.empty };
  if (classifyReceiptPda(value) === "plausible") return { ok: true, receiptPda: value, hash: "" };

  let pathname: string;
  let hash = "";
  if (SCHEME.test(value) || HOST_PATH.test(value) || value.startsWith("/")) {
    try {
      const url = SCHEME.test(value)
        ? new URL(value)
        : new URL(value.startsWith("/") ? value : `https://${value}`, "https://receipt.invalid");
      if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: RECEIPT_INPUT_ERRORS.notReceiptLink };
      pathname = url.pathname;
      hash = url.hash;
    } catch {
      return { ok: false, error: RECEIPT_INPUT_ERRORS.badAddress };
    }
  } else {
    return { ok: false, error: RECEIPT_INPUT_ERRORS.badAddress };
  }

  const route = parsePathname(pathname);
  if (route.kind !== "verify" || !route.receiptPda) return { ok: false, error: RECEIPT_INPUT_ERRORS.notReceiptLink };
  const receiptPda = route.receiptPda.trim();
  if (classifyReceiptPda(receiptPda) !== "plausible") return { ok: false, error: RECEIPT_INPUT_ERRORS.badAddressInLink };
  return { ok: true, receiptPda, hash };
}
