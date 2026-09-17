export type WalletBrand = "phantom" | "jupiter" | "solflare" | "metamask";

/**
 * Wallet names come from the browser extension, so any extension can call itself
 * anything. Substring matching would hand the genuine Phantom mark to a wallet named
 * "Phantom (Secure)"; the mark then follows it into the chip, popover, sign-in card and
 * Settings, which is exactly the confusion a brand mark is supposed to prevent. Match the
 * whole name instead, allowing only a trailing "Wallet" that several wallets append.
 */
const EXACT_NAMES: Record<string, WalletBrand> = {
  phantom: "phantom",
  jupiter: "jupiter",
  solflare: "solflare",
  metamask: "metamask",
  "meta mask": "metamask",
};

export function matchingWalletBrand(name: string): WalletBrand | undefined {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ wallet$/, "");
  return EXACT_NAMES[key];
}

/**
 * The Wallet Standard defines `icon` as a data URI. Accepting anything else lets an
 * extension point the dashboard at a URL it controls, which is then fetched on every
 * render. Fall back to the bundled mark rather than honouring a remote reference.
 */
const MAX_ICON_BYTES = 64 * 1024;

function usableProvidedIcon(icon: string | undefined): string | undefined {
  const provided = icon?.trim();
  if (!provided) return undefined;
  if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(provided)) return undefined;
  if (provided.length > MAX_ICON_BYTES) return undefined;
  return provided;
}

export function resolveWalletIcon(
  name: string,
  icon: string | undefined,
  bundled: Partial<Record<WalletBrand, string>>,
): string | undefined {
  const provided = usableProvidedIcon(icon);
  if (provided) return provided;
  const brand = matchingWalletBrand(name);
  return brand ? bundled[brand] : undefined;
}
