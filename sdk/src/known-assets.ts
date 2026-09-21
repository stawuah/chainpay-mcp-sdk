/**
 * The mints ChainPay can name, and the order it shows them in.
 *
 * Naming a mint here is presentation only. Whether an asset can be paid at all
 * is decided on chain by the registry account the protocol authority creates,
 * and a mint absent from this table still works — it is labelled by its address
 * instead. The two must be kept apart: adding a row here does not enable a
 * token, and enabling a token on chain does not require a row here.
 *
 * Devnet and mainnet mints for one asset share a label, so the dashboard reads
 * the same on either cluster without the caller knowing which it is on.
 */
export type KnownAsset = {
  label: string;
  /** Lower sorts first, so the assets an owner expects lead the list. */
  order: number;
  /** Every mint that is this asset, across clusters. */
  mints: readonly string[];
};

export const KNOWN_ASSETS: readonly KnownAsset[] = [
  {
    label: "USDC",
    order: 0,
    mints: [
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet
    ],
  },
  {
    label: "PYUSD",
    order: 1,
    mints: [
      "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM", // devnet, Token-2022
      "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // mainnet, Token-2022
    ],
  },
  {
    label: "EURC",
    order: 2,
    mints: [
      "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", // devnet
    ],
  },
  {
    label: "USDG",
    order: 3,
    mints: [
      "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7", // devnet, Token-2022
    ],
  },
];

const byMint = new Map<string, KnownAsset>(
  KNOWN_ASSETS.flatMap((asset) => asset.mints.map((mint) => [mint, asset] as const)),
);

export function knownAsset(mint: string): KnownAsset | undefined {
  return byMint.get(mint);
}

/** The order an unnamed mint sorts at: after everything this table names. */
export const UNKNOWN_ASSET_ORDER = KNOWN_ASSETS.length;

export function assetOrder(mint: string): number {
  return byMint.get(mint)?.order ?? UNKNOWN_ASSET_ORDER;
}

/**
 * The symbol to print beside an amount in this mint. Unknown mints fall back
 * to the neutral word rather than a guessed ticker, because a wrong symbol
 * beside an amount misidentifies the money.
 */
export function assetLabel(mint: string, fallback = "tokens"): string {
  return byMint.get(mint)?.label ?? fallback;
}
