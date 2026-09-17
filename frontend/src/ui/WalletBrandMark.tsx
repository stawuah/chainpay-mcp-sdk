import { Wallet } from "lucide-react";
import { resolveConnectedWalletIcon } from "../wallet/icons";

export function WalletBrandMark({
  name,
  icon,
  size = 20,
  fallback = false,
}: {
  name: string;
  icon?: string;
  size?: number;
  fallback?: boolean;
}) {
  const src = resolveConnectedWalletIcon(name, icon);
  if (src) {
    return <img className="wallet-brand-mark" src={src} alt="" width={size} height={size} />;
  }
  if (!fallback) return null;
  return <Wallet size={size} aria-hidden="true" />;
}
