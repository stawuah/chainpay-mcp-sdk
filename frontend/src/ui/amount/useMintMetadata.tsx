import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { RPC_URL } from "../../config/public";
import { createMintMetadataStore, type DecimalsFetcher, type MintMetadataState, type MintMetadataStore } from "./mintMetadataStore";

/*
  React bindings for the shared mint metadata store.

  The Dashboard mounts one provider per (owner wallet, network). A wallet or
  network change builds a fresh store, so nothing read for another owner or
  network is reused. Components outside a provider (single-component test
  fixtures) share a module default store.
*/

let fetcherOverride: DecimalsFetcher | null = null;

/** Test harness only: feed the store from fixture data instead of RPC. Never set in production code. */
export function setMintMetadataFetcherOverride(fetcher: DecimalsFetcher | null) {
  fetcherOverride = fetcher;
}

// Read at call time: harness fixtures replace chainpayClient.getMintDecimals after import.
// config/client pulls the SDK into the dashboard chunk; a static import here would make
// app-shared and dashboard import each other and the app dies on load with a TDZ error.
const fetchDecimals: DecimalsFetcher = (mint) =>
  fetcherOverride
    ? fetcherOverride(mint)
    : import("../../config/client").then(({ chainpayClient }) => chainpayClient.getMintDecimals(mint));

export const MINT_METADATA_NETWORK = RPC_URL;

const defaultStore = createMintMetadataStore({ network: MINT_METADATA_NETWORK, fetchDecimals });
const MintMetadataContext = createContext<MintMetadataStore>(defaultStore);

/** One store per (owner wallet, network): a change of either starts from nothing. */
export function useCreateMintMetadataStore(wallet: string, network: string = MINT_METADATA_NETWORK): MintMetadataStore {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createMintMetadataStore({ network, fetchDecimals }), [wallet, network]);
}

export function MintMetadataProvider({ store, children }: { store: MintMetadataStore; children: ReactNode }) {
  return <MintMetadataContext.Provider value={store}>{children}</MintMetadataContext.Provider>;
}

export function useMintMetadataStore(): MintMetadataStore {
  return useContext(MintMetadataContext);
}

const LOADING: MintMetadataState = { status: "loading" };

export function useMintMetadata(mint: string | null | undefined, storeOverride?: MintMetadataStore): { state: MintMetadataState; decimals: number | null; retry: () => void } {
  const contextStore = useMintMetadataStore();
  const store = storeOverride ?? contextStore;
  const state = useSyncExternalStore(
    store.subscribe,
    () => (mint ? store.get(mint) : undefined),
    () => undefined,
  ) ?? (mint ? LOADING : { status: "unavailable", error: "No token mint." } as MintMetadataState);
  useEffect(() => { if (mint) store.ensure(mint); }, [store, mint, store.network]);
  return {
    state,
    decimals: state.status === "verified" ? state.decimals : null,
    retry: () => { if (mint) void store.retry(mint); },
  };
}

/** Every mint in the list, for section-level notices and totals. */
export function useMintMetadataMany(mints: readonly string[], storeOverride?: MintMetadataStore): { states: Record<string, MintMetadataState>; unavailable: string[]; loading: string[]; retryAll: () => void } {
  const contextStore = useMintMetadataStore();
  const store = storeOverride ?? contextStore;
  const key = [...new Set(mints)].sort().join(",");
  const unique = useMemo(() => (key ? key.split(",") : []), [key]);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => unique.map((mint) => `${mint}=${store.get(mint)?.status ?? "none"}`).join("|"),
    () => "",
  );
  useEffect(() => { for (const mint of unique) store.ensure(mint); }, [store, unique, store.network]);
  return useMemo(() => {
    const states: Record<string, MintMetadataState> = {};
    for (const mint of unique) states[mint] = store.get(mint) ?? LOADING;
    const unavailable = unique.filter((mint) => states[mint].status === "unavailable");
    return {
      states,
      unavailable,
      loading: unique.filter((mint) => states[mint].status === "loading"),
      retryAll: () => { for (const mint of unavailable) void store.retry(mint); },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, store, unique]);
}
