import type { CardView } from "@chainpay/sdk";
import { cardStatus, stateAppearance } from "../cards/lifecycle";
import type { StatusIcon, StatusTone } from "../../ui/workspace/Status";

/*
  Wallet-scoped Cards summary for Overview (EXPERIENCE.md, Cards row).

  Reads only the public card list through the Cards source interface and
  reduces it to counts per lifecycle state. Nothing private leaves here: no
  budget, balance, statement or credit figure is read or returned. Private
  amounts stay behind the Cards unlock.
*/
/** Tone and icon come from the same state map the Cards area uses, so a state looks the same on both. */
export type CardsLifecycleCount = { key: string; label: string; tone: StatusTone; icon: StatusIcon; count: number };
export type CardsSummary = { total: number; lifecycle: CardsLifecycleCount[] };

export function summarizeCards(cards: readonly CardView[]): CardsSummary {
  const counts = new Map<string, CardsLifecycleCount>();
  for (const card of cards) {
    const status = cardStatus(card);
    const existing = counts.get(status.key);
    if (existing) existing.count += 1;
    else counts.set(status.key, { key: status.key, label: status.label, ...stateAppearance(status.key), count: 1 });
  }
  return { total: cards.length, lifecycle: [...counts.values()] };
}

/** Overview's view of the wallet's cards: what the summary adapter returns. */
export type CardsSummaryState =
  | { state: "signed-out" | "loading" | "failed" | "not-enabled"; illustrative?: boolean }
  | { state: "empty" | "loaded"; summary: CardsSummary; /** The source is example data (the Cards tab shows the same label). */ illustrative: boolean };

/** Card states the owner has to act on or watch: they feed Overview's attention list. */
export const CARD_ATTENTION_KEYS = ["needs_restore", "freeze_failed", "limits_failed", "freeze_pending", "needs_activation"] as const;

/**
 * What the cards summary contributes to Overview's attention (council R2-P10).
 * - `checked`: the list was read (or cards are not switched on), and `items`
 *   holds every card state that needs the owner, most urgent first.
 * - `pending`: still reading; Overview must not claim all-clear yet.
 * - `unchecked`: the list could not be read (failed, or signed out). Unknown is
 *   never clear, so Overview must say cards were not checked.
 */
export type CardsAttention =
  | { status: "checked"; items: CardsLifecycleCount[]; illustrative: boolean }
  | { status: "pending"; items: [] }
  | { status: "unchecked"; reason: "failed" | "signed-out"; items: [] };

export function cardsAttention(cards: CardsSummaryState): CardsAttention {
  switch (cards.state) {
    case "loading": return { status: "pending", items: [] };
    case "failed": return { status: "unchecked", reason: "failed", items: [] };
    case "signed-out": return { status: "unchecked", reason: "signed-out", items: [] };
    case "not-enabled": return { status: "checked", items: [], illustrative: false };
    case "empty":
    case "loaded": {
      const items = CARD_ATTENTION_KEYS.flatMap((key) => cards.summary.lifecycle.filter((row) => row.key === key && row.count > 0));
      return { status: "checked", items, illustrative: cards.illustrative };
    }
    default: {
      // A state this adapter does not know is not a clear.
      return { status: "unchecked", reason: "failed", items: [] };
    }
  }
}
