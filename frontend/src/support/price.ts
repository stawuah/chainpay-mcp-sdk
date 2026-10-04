// "≈ $" hint only. The exact token amount is always what gets signed; if the
// price can't be fetched the hint is simply hidden.
import { useEffect, useState } from "react";
import type { SupportAsset } from "./donation";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PRICE_URL = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`;
const TTL_MS = 60_000;

let cached: { usd: number; at: number } | null = null;

export async function fetchSolUsd(fetcher: typeof fetch = fetch, now = Date.now()): Promise<number | null> {
  if (cached && now - cached.at < TTL_MS) return cached.usd;
  try {
    const response = await fetcher(PRICE_URL);
    if (!response.ok) return null;
    const usd = (await response.json())?.[SOL_MINT]?.usdPrice;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
    cached = { usd, at: now };
    return usd;
  } catch {
    return null;
  }
}

export function resetPriceCache() {
  cached = null;
}

/** Returns "≈ $12.40", or null when there's no amount or no price. USDC is treated as $1. */
export function usdHint(asset: SupportAsset, units: bigint | null, solUsd: number | null): string | null {
  if (!units) return null;
  const tokens = asset === "SOL" ? Number(units) / 1e9 : Number(units) / 1e6;
  const usd = asset === "USDC" ? tokens : solUsd ? tokens * solUsd : null;
  if (usd === null) return null;
  if (usd < 0.01) return "< $0.01";
  return `≈ $${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function useSolUsd() {
  const [price, setPrice] = useState<number | null>(cached?.usd ?? null);
  useEffect(() => {
    let alive = true;
    const load = () => void fetchSolUsd().then((usd) => alive && setPrice(usd));
    load();
    const timer = window.setInterval(load, TTL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return price;
}
