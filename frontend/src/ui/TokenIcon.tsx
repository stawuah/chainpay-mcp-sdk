import { Coins } from "lucide-react";
import usdc from "../assets/brands/usdc.svg";
import pyusd from "../assets/brands/pyusd.png";
import solana from "../assets/brands/solana.svg";
import { KNOWN_ASSETS, knownAsset } from "../owner/knownAssets";

// Identify known mints, not arbitrary user-supplied symbols. Artwork is keyed by
// the asset's label rather than each mint, so one file covers every cluster's
// mint for that asset. An asset with no verified artwork keeps the neutral mark:
// a stand-in drawn here would misrepresent an issuer's brand, and a wrong mark
// on a payment screen is worse than an honest generic one.
const artworkByLabel: Record<string, string> = {
  USDC: usdc,
  PYUSD: pyusd,
};

const SOL_MINT = "So11111111111111111111111111111111111111112";

export function TokenIcon({ mint, size = 32 }: { mint: string; size?: number }) {
  const source = mint === SOL_MINT ? solana : artworkFor(mint);
  return <span className="owner-token-icon" style={{width:size,height:size}} aria-hidden="true">{source ? <img src={source} alt="" /> : <Coins size={size * .7} />}</span>;
}

function artworkFor(mint: string): string | undefined {
  const label = knownAsset(mint)?.label;
  return label ? artworkByLabel[label] : undefined;
}

/** Assets ChainPay can name but has no verified artwork for. */
export function assetsAwaitingArtwork(): string[] {
  return KNOWN_ASSETS.filter((asset) => !artworkByLabel[asset.label]).map((asset) => asset.label);
}
