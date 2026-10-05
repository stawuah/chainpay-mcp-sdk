import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CreditCard, Plus } from "lucide-react";
import { availableCents, type CardView } from "@chainpay/sdk";
import { PageHeader } from "../PageHeader";
import { SectionHeader } from "../../ui/workspace/SectionHeader";
import { CollectionState } from "../../ui/workspace/CollectionState";
import { cardStatus } from "./lifecycle";
import { CardsNotEnabledError, type CardPrivateRead } from "./source";
import { errorText, type CardsShared } from "./shared";
import { UnlockStrip } from "./Unlock";
import { CardStatus, Money, PrivateValue, readFailed } from "./ui";
import { AgentCard, frostFor } from "./AgentCard";
import { PRIVACY_COPY } from "./privacyCopy";

export const CARDS_LIST_COPY = { kicker: "AGENT CARDS", title: "Cards", subtitle: "Give an agent a card. Its limits stay hidden from the public chain." };

/** Cards are off on this relay (404/405/501). Nothing about cards can start here. */
export const CARDS_OFF_COPY = {
  title: "Cards aren't available here yet",
  body: "This workspace has cards switched off, so no card can be made or charged. Your agent can still pay through a spending permission.",
  link: "Set up a spending permission",
} as const;

// A plain link that also works without the router: same-tab clicks stay in the app.
function SpendingPermissionLink() {
  return (
    <a
      className="button button-secondary"
      href="/app/mandates"
      data-testid="cards-off-permission-link"
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        window.history.pushState(window.history.state, "", "/app/mandates");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {CARDS_OFF_COPY.link}
    </a>
  );
}

type LoadState = { kind: "loading" } | { kind: "ready"; cards: CardView[] } | { kind: "not_enabled" } | { kind: "error"; message: string };

export function CardList({ source, unlocked, onUnlocked, onNavigate, notice }: CardsShared) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reads, setReads] = useState<Record<string, CardPrivateRead>>({});
  // Cards whose private read failed: shown as an error with a retry, never as "Private".
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [readAttempt, setReadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    source.listCards().then(
      (cards) => { if (active) setState({ kind: "ready", cards }); },
      (error) => { if (active) setState(error instanceof CardsNotEnabledError ? { kind: "not_enabled" } : { kind: "error", message: errorText(error) }); },
    );
    return () => { active = false; };
  }, [source]);

  useEffect(() => {
    if (!unlocked || state.kind !== "ready") return;
    let active = true;
    // One card's failure never hides the others' values.
    void Promise.allSettled(state.cards.map((card) => source.readPrivate(card))).then((results) => {
      if (!active) return;
      const nextReads: Record<string, CardPrivateRead> = {};
      const nextFailed: Record<string, true> = {};
      results.forEach((result, i) => {
        const id = state.cards[i].cardId;
        if (result.status === "fulfilled" && !readFailed(result.value)) nextReads[id] = result.value;
        else nextFailed[id] = true;
      });
      setReads(nextReads);
      setFailed(nextFailed);
    });
    return () => { active = false; };
  }, [source, unlocked, state, readAttempt]);
  const failedCount = Object.keys(failed).length;

  const newCard = <Button type="button" variant="primary" label="New card" icon={<Plus size={18} />} onClick={() => onNavigate({ cardsNew: true })} />;

  const collection = state.kind === "loading" ? "loading" : state.kind === "error" ? "failed" : state.kind === "ready" && state.cards.length > 0 ? "loaded" : "empty";

  return (
    <>
      <PageHeader copy={CARDS_LIST_COPY} action={state.kind === "not_enabled" ? undefined : newCard} />
      {notice}
      {state.kind === "ready" && state.cards.length > 0 && !unlocked && <UnlockStrip source={source} onUnlocked={onUnlocked} />}
      {state.kind === "ready" && unlocked && failedCount > 0 && (
        <div className="builder-error cp-read-failed" role="alert" data-testid="cards-read-failed">
          <b>Private details didn't load</b>
          <span>{failedCount === 1 ? "One card's" : `${failedCount} cards'`} limits couldn't be read from the private rollup.</span>
          <Button type="button" variant="secondary" label="Try again" onClick={() => setReadAttempt((n) => n + 1)} />
        </div>
      )}
      <section className="cp-surface cp-cards-list" aria-labelledby="cards-list-title" data-testid={state.kind === "not_enabled" ? "cards-not-enabled" : state.kind === "ready" && state.cards.length === 0 ? "cards-empty" : undefined}>
        <SectionHeader id="cards-list-title" title="Your cards" description={collection === "loaded" ? "Limits and spending stay private until you show them." : undefined} />
        <CollectionState
          state={collection}
          noun="cards"
          icon={state.kind === "not_enabled" ? CreditCard : undefined}
          title={state.kind === "error" ? "Cards couldn't load" : state.kind === "not_enabled" ? CARDS_OFF_COPY.title : undefined}
          description={state.kind === "error" ? state.message
            : state.kind === "not_enabled" ? CARDS_OFF_COPY.body
              : `Give your agent a card with its own limits. ${PRIVACY_COPY} It pays only where you allow, and you can freeze it in one tap.`}
          action={state.kind === "ready" ? newCard : state.kind === "not_enabled" ? <SpendingPermissionLink /> : undefined}
        >
          {state.kind === "ready" && (
            // Narrow screens and 200% zoom: the table scrolls inside its surface, never the page.
            <div className="cp-card-table-scroll" role="region" aria-labelledby="cards-list-title" tabIndex={0}>
              <table className="cp-card-table" data-testid="cards-table">
                <thead>
                  <tr><th scope="col">Card</th><th scope="col">Left this period</th><th scope="col">Charged this period</th><th scope="col">Status</th><th scope="col"><span className="cp-visually-hidden">Open</span></th></tr>
                </thead>
                <tbody>
                  {state.cards.map((card) => {
                    const status = cardStatus(card);
                    const read = reads[card.cardId];
                    const policy = read?.policy.state === "visible" ? read.policy.account : null;
                    const period = read?.period.state === "visible" ? read.period.account : null;
                    const left = policy && period ? availableCents(BigInt(policy.budgetCents), period.capturedCents, period.reservedCents) : null;
                    return (
                      <tr key={card.cardId} data-card={card.cardId}>
                        <td data-label="Card">
                          <button type="button" className="cp-card-name" onClick={() => onNavigate({ cardId: card.cardId })}>
                            <AgentCard size="mini" label={card.label} lastFour={card.lastFour} frost={frostFor(card)} />
                            <span><b>{card.label}</b><small>•••• {card.lastFour}</small></span>
                          </button>
                        </td>
                        <td data-label="Left this period">{left !== null && policy ? <span><Money cents={left} /><small className="cp-sub"> of <Money cents={policy.budgetCents} /></small></span> : <PrivateValue failed={Boolean(failed[card.cardId])} />}</td>
                        <td data-label="Charged this period">{period ? <Money cents={period.capturedCents} /> : <PrivateValue failed={Boolean(failed[card.cardId])} />}</td>
                        <td data-label="Status"><CardStatus pill={status} /></td>
                        <td><Button type="button" variant="secondary" label={status.key === "needs_restore" ? "Restore" : "Open"} onClick={() => onNavigate({ cardId: card.cardId })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CollectionState>
      </section>
    </>
  );
}
