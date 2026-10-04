import { useEffect, useRef, useState } from "react";
import type { Transaction } from "@solana/web3.js";
import { cardsSourceOverride, CardsNotEnabledError, type CardsSource } from "../cards/source";
import { summarizeCards, type CardsSummaryState } from "./cardsSummary";

export type { CardsSummaryState } from "./cardsSummary";

/*
  Overview's view of Cards, scoped to the connected owner wallet. It uses the
  same Cards source interface as the Cards area (fixtures in the harness, the
  Axum client live) and only ever calls listCards(): counts and lifecycle
  states, nothing behind the private unlock.
*/
type Deps = {
  wallet: string;
  signedIn: boolean;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  walletMessageSigner?: (message: Uint8Array) => Promise<Uint8Array>;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
};

export function useCardsSummary({ wallet, signedIn, walletSigner, walletMessageSigner, onCallMcp }: Deps): CardsSummaryState & { retry: () => void } {
  const deps = useRef({ wallet, signTransaction: walletSigner, signMessage: walletMessageSigner, onCallMcp });
  deps.current = { wallet, signTransaction: walletSigner, signMessage: walletMessageSigner, onCallMcp };
  const [result, setResult] = useState<{ wallet: string; value: CardsSummaryState } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    // liveSource lives in the lazy cards chunk; a static import here would make the
    // dashboard and cards chunks import each other.
    const loadSource = async (): Promise<CardsSource> =>
      cardsSourceOverride() ?? (await import("../cards/liveSource")).createLiveCardsSource(() => deps.current);
    setResult({ wallet, value: { state: "loading" } });
    let mode: CardsSource["mode"] | undefined;
    loadSource().then((source) => { mode = source.mode; return source.listCards(); }).then(
      (cards) => {
        if (!active) return;
        // A malformed answer is a failed read, never "no cards".
        if (!Array.isArray(cards)) { setResult({ wallet, value: { state: "failed" } }); return; }
        const summary = summarizeCards(cards);
        const illustrative = mode === "fixture";
        setResult({ wallet, value: summary.total ? { state: "loaded", summary, illustrative } : { state: "empty", summary, illustrative } });
      },
      (error: unknown) => {
        if (!active) return;
        setResult({ wallet, value: { state: error instanceof CardsNotEnabledError ? "not-enabled" : "failed" } });
      },
    );
    return () => { active = false; };
  }, [wallet, signedIn, attempt]);

  const retry = () => setAttempt((value) => value + 1);
  if (!signedIn) return { state: "signed-out", retry };
  // A result read for another wallet is never shown.
  if (!result || result.wallet !== wallet) return { state: "loading", retry };
  return { ...result.value, retry };
}
