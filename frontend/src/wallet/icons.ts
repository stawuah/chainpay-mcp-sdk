import phantom from "../assets/brands/phantom.svg";
import solflare from "../assets/brands/solflare.svg";
import jupiter from "../assets/brands/jupiter.svg";
import metamask from "../assets/brands/metamask.svg";
import { resolveWalletIcon } from "./brands";

const bundledWalletIcons = { phantom, solflare, jupiter, metamask };

export function resolveConnectedWalletIcon(name: string, icon?: string): string | undefined {
  return resolveWalletIcon(name, icon, bundledWalletIcons);
}
