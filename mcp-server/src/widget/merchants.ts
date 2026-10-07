import { demoMerchant } from "../tools/demo-payment-request.js";

/** The fictional Devnet merchant behind /demo/store. */
export const DEMO_MERCHANT_NAME = "Halden Data Co.";

export type DemoProduct = {
  id: string;
  name: string;
  /** Whole USDC, as shown on the store. */
  price: string;
  blurb: string;
};

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { id: "market-report", name: "Market data report", price: "10", blurb: "One report, delivered as a download after payment." },
  { id: "annual-license", name: "Annual data license", price: "25", blurb: "Twelve months of feed access for one team." },
];

/**
 * A display name for a merchant key, known only for the configured demo
 * merchant. Any other merchant is shown by its shortened key: a name the
 * merchant did not sign is not something this server can vouch for.
 */
export function merchantDisplayName(merchant: string): string {
  try {
    if (demoMerchant().keypair.publicKey.toBase58() === merchant) return DEMO_MERCHANT_NAME;
  } catch {
    // An invalid demo key names no one.
  }
  return `Merchant ${merchant.slice(0, 4)}…${merchant.slice(-4)}`;
}
