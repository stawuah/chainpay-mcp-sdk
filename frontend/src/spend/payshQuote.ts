export type PayshCatalogProviderLike = {
  fqn: string;
  title: string;
  min_price_usd: number;
  max_price_usd: number;
};

export type PayshCatalogQuote = {
  fqn: string;
  title: string;
  label: string;
  estimateAmount: string;
  source: "pay.sh";
  estimateOnly: true;
};

/** Turn a catalog row into a mandate prefill quote. USD estimate only — wallet still signs token limits. */
export function catalogQuoteForProvider(provider: PayshCatalogProviderLike): PayshCatalogQuote {
  const estimate = provider.max_price_usd > 0
    ? provider.max_price_usd
    : provider.min_price_usd > 0
      ? provider.min_price_usd
      : 0;
  const estimateAmount = formatUsdEstimate(estimate);
  return {
    fqn: provider.fqn,
    title: provider.title,
    label: `pay.sh estimate · ${provider.title}`,
    estimateAmount,
    source: "pay.sh",
    estimateOnly: true,
  };
}

function formatUsdEstimate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const text = value.toString();
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}
