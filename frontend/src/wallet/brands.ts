export type WalletBrand = "phantom" | "jupiter" | "solflare" | "metamask";

export function matchingWalletBrand(name: string): WalletBrand | undefined {
  const key = name.trim().toLowerCase();
  if (key.includes("phantom")) return "phantom";
  if (key.includes("jupiter")) return "jupiter";
  if (key.includes("solflare")) return "solflare";
  if (key.includes("metamask") || key.includes("meta mask")) return "metamask";
}

export function resolveWalletIcon(
  name: string,
  icon: string | undefined,
  bundled: Partial<Record<WalletBrand, string>>,
): string | undefined {
  const provided = icon?.trim();
  if (provided) return provided;
  const brand = matchingWalletBrand(name);
  return brand ? bundled[brand] : undefined;
}
