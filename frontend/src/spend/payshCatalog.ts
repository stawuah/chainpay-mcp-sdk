import { authorizedFetch } from "../session";
import { BACKEND_URL } from "../config/client";
import { catalogQuoteForProvider, type PayshCatalogQuote } from "./payshQuote";

export type PayshCatalogProvider = {
  fqn: string;
  title: string;
  description?: string;
  category?: string;
  service_url?: string;
  min_price_usd: number;
  max_price_usd: number;
  endpoint_count?: number;
  has_free_tier?: boolean;
};

export { catalogQuoteForProvider, type PayshCatalogQuote } from "./payshQuote";

type PayshCatalogResponse = {
  source: string;
  estimate_only: boolean;
  fetched_at_ms: number;
  providers: {
    providers?: PayshCatalogProvider[];
  };
};

/** Catalog prices are public estimates. They do not authorize a payment. */
export async function fetchPayshCatalog(): Promise<PayshCatalogProvider[]> {
  const response = await authorizedFetch(`${BACKEND_URL.replace(/\/$/, "")}/v1/catalog/paysh`);
  if (!response.ok) throw new Error("Could not load the pay.sh catalog through ChainPay.");
  const payload = await response.json() as PayshCatalogResponse;
  return payload.providers?.providers ?? [];
}
