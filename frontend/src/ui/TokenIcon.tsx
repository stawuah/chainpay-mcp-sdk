import { Coins } from "lucide-react";
import usdc from "../assets/brands/usdc.svg";
import pyusd from "../assets/brands/pyusd.png";
import solana from "../assets/brands/solana.svg";
import { KNOWN_ASSETS, knownAsset } from "../owner/knownAssets";

// Identify known mints, not arbitrary user-supplied symbols. Artwork is keyed by
// the asset's label rather than each mint, so one file covers every cluster's
// mint for that asset.
const artworkByLabel: Record<string, string> = {
  USDC: usdc,
  PYUSD: pyusd,
};

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * A named asset with no issuer artwork is drawn as its currency glyph, so a
 * payment screen still says what unit is being spent. The glyph is deliberately
 * not a logo: inventing a mark for an issuer and putting it beside an amount
 * misidentifies the money. A mint this build cannot name gets the neutral coin.
 */
export function TokenIcon({ mint, size = 32 }: { mint: string; size?: number }) {
  const source = mint === SOL_MINT ? solana : artworkFor(mint);
  const glyph = source ? undefined : knownAsset(mint)?.glyph;
  return (
    <span className="owner-token-icon" style={{ width: size, height: size }} aria-hidden="true">
      {source
        ? <img src={source} alt="" />
        : glyph
          ? <span className="owner-token-glyph" style={{ fontSize: size * 0.5 }}>{glyph}</span>
          : <Coins size={size * 0.7} />}
    </span>
  );
}

function artworkFor(mint: string): string | undefined {
  const label = knownAsset(mint)?.label;
  return label ? artworkByLabel[label] : undefined;
}

/** Assets ChainPay can name but has no verified issuer artwork for. */
export function assetsAwaitingArtwork(): string[] {
  return KNOWN_ASSETS.filter((asset) => !artworkByLabel[asset.label]).map((asset) => asset.label);
}
