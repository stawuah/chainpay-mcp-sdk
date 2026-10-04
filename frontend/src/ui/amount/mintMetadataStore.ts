/*
  Mint metadata, read once per (network, mint) and shared by every tab
  (EXPERIENCE.md, 2026-10-04 shared state rules).

  Three states: loading, verified{decimals}, unavailable{error}. An
  unavailable mint carries no decimals at all, so a caller cannot fall back
  to 0 by accident. Concurrent reads of one key share a single request.
  A different network is a different key, so decimals never cross networks.

  Framework-free so it can be unit tested; React bindings are in
  useMintMetadata.tsx.
*/
export type MintMetadataState =
  | { status: "loading" }
  | { status: "verified"; decimals: number }
  | { status: "unavailable"; error: string };

export type SettledMintMetadata = Extract<MintMetadataState, { status: "verified" | "unavailable" }>;

export type DecimalsFetcher = (mint: string) => Promise<number>;

export function mintMetadataKey(network: string, mint: string) {
  return `${network}:${mint}`;
}

const LOADING: MintMetadataState = Object.freeze({ status: "loading" });

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Token details could not be read.";
}

export type MintMetadataStore = ReturnType<typeof createMintMetadataStore>;

export function createMintMetadataStore(options: { network: string; fetchDecimals: DecimalsFetcher }) {
  let network = options.network;
  const states = new Map<string, MintMetadataState>();
  const inFlight = new Map<string, Promise<SettledMintMetadata>>();
  const listeners = new Set<() => void>();
  /** Bumped by reset() so a read that finishes after a re-key is dropped. */
  let generation = 0;

  const notify = () => { for (const listener of listeners) listener(); };

  function read(mint: string): Promise<SettledMintMetadata> {
    const key = mintMetadataKey(network, mint);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const started = generation;
    states.set(key, LOADING);
    const request = (async (): Promise<SettledMintMetadata> => {
      try {
        const decimals = await options.fetchDecimals(mint);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
          return { status: "unavailable", error: "The token reported an invalid number of decimals." };
        }
        return { status: "verified", decimals };
      } catch (error) {
        return { status: "unavailable", error: errorText(error) };
      }
    })().then((settled) => {
      if (started === generation) {
        states.set(key, settled);
        inFlight.delete(key);
        notify();
      }
      return settled;
    });
    inFlight.set(key, request);
    notify();
    return request;
  }

  return {
    get network() { return network; },
    /** Current state, or undefined when this mint has never been requested on this network. */
    get(mint: string): MintMetadataState | undefined {
      return states.get(mintMetadataKey(network, mint));
    },
    /** Current state, starting a read when there is none. */
    ensure(mint: string): MintMetadataState {
      const existing = states.get(mintMetadataKey(network, mint));
      if (existing) return existing;
      void read(mint);
      return states.get(mintMetadataKey(network, mint)) ?? LOADING;
    },
    /** Resolves with the settled state; reuses a verified result or an in-flight read. */
    load(mint: string): Promise<SettledMintMetadata> {
      const key = mintMetadataKey(network, mint);
      const existing = states.get(key);
      if (existing && existing.status !== "loading") return Promise.resolve(existing);
      return read(mint);
    },
    /** Reads an unavailable mint again. A verified mint is left alone. */
    retry(mint: string): Promise<SettledMintMetadata> {
      const key = mintMetadataKey(network, mint);
      const existing = states.get(key);
      if (existing?.status === "verified") return Promise.resolve(existing);
      if (existing?.status === "unavailable") states.delete(key);
      return read(mint);
    },
    /** Verified decimals, or null. Never a guess. */
    decimals(mint: string): number | null {
      const state = states.get(mintMetadataKey(network, mint));
      return state?.status === "verified" ? state.decimals : null;
    },
    /** A different network (or owner) re-keys every read; nothing carries over. */
    setNetwork(next: string) {
      if (next === network) return;
      network = next;
      generation += 1;
      // Reads cut off by the switch are forgotten, not left loading forever.
      for (const key of inFlight.keys()) states.delete(key);
      inFlight.clear();
      notify();
    },
    reset() {
      generation += 1;
      states.clear();
      inFlight.clear();
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
