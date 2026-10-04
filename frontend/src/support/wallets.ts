// The wallets the support page features, in display order (ruling P5).
// Detection and connection go through the same code as sign-in (wallet/connect.ts).
import { bundledWalletIcons } from "../wallet/icons";
import type { ChainPayWalletOption } from "../wallet/connect";

export type FeaturedWallet = {
  key: "phantom" | "solflare" | "backpack" | "jupiter" | "metamask";
  name: string;
  logo: string;
  installUrl: string;
};

export const FEATURED_WALLETS: FeaturedWallet[] = [
  { key: "phantom", name: "Phantom", logo: bundledWalletIcons.phantom, installUrl: "https://phantom.com/download" },
  { key: "solflare", name: "Solflare", logo: bundledWalletIcons.solflare, installUrl: "https://www.solflare.com/" },
  { key: "backpack", name: "Backpack", logo: bundledWalletIcons.backpack, installUrl: "https://backpack.app/" },
  { key: "jupiter", name: "Jupiter", logo: bundledWalletIcons.jupiter, installUrl: "https://jup.ag/mobile" },
  { key: "metamask", name: "MetaMask", logo: bundledWalletIcons.metamask, installUrl: "https://metamask.io/download/" },
];

const normalize = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ").replace(/ wallet$/, "").replace(/^meta mask$/, "metamask");

/** Pairs each featured wallet with its detected option, and lists other detected wallets. */
export function arrangeWallets(options: ChainPayWalletOption[]) {
  const featured = FEATURED_WALLETS.map((wallet) => ({
    wallet,
    option: options.find((option) => normalize(option.name) === wallet.key),
  }));
  const used = new Set(featured.flatMap((entry) => (entry.option ? [entry.option.id] : [])));
  const others = options.filter((option) => !used.has(option.id));
  return { featured, others };
}
