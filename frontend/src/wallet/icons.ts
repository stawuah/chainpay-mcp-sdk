import phantom from "../assets/brands/phantom.svg";
import solflare from "../assets/brands/solflare.svg";
import jupiter from "../assets/brands/jupiter.svg";
import metamask from "../assets/brands/metamask.svg";
// Official mark from Backpack's own repo (coral-xyz/backpack, assets/backpack.png), wrapped as SVG.
import backpack from "../assets/brands/backpack.svg";
import { resolveWalletIcon } from "./brands";

export const bundledWalletIcons = { phantom, solflare, jupiter, metamask, backpack };

export function resolveConnectedWalletIcon(name: string, icon?: string): string | undefined {
  return resolveWalletIcon(name, icon, bundledWalletIcons);
}
