import { Coins } from "lucide-react";
import usdc from "../assets/brands/usdc.svg";
import pyusd from "../assets/brands/pyusd.png";
import solana from "../assets/brands/solana.svg";

// Identify known mints, not arbitrary user-supplied symbols. Unknown assets keep
// a neutral mark until verified artwork is available.
const tokenArtwork: Record<string, string> = {
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": usdc,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": usdc,
  "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM": pyusd,
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": pyusd,
  "So11111111111111111111111111111111111111112": solana,
};
export function TokenIcon({ mint, size = 32 }: { mint: string; size?: number }) {
  const source = tokenArtwork[mint];
  return <span className="owner-token-icon" style={{width:size,height:size}} aria-hidden="true">{source ? <img src={source} alt="" /> : <Coins size={size * .7} />}</span>;
}
