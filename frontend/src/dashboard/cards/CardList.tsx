import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CreditCard, Plus } from "lucide-react";
import { availableCents, type CardView } from "@chainpay/sdk";
import { PageHeader } from "../PageHeader";
import { cardStatus } from "./lifecycle";
import { CardsNotEnabledError, type CardPrivateRead } from "./source";
import { errorText, type CardsShared } from "./shared";
import { UnlockStrip } from "./Unlock";
import { Money, Pill, PrivateValue } from "./ui";
import { AgentCard, frostFor } from "./AgentCard";

export const CARDS_LIST_COPY = { kicker: "AGENT CARDS", title: "Cards", subtitle: "Give an agent a card. Only you see its limits." };

type LoadState = { kind: "loading" } | { kind: "ready"; cards: CardView[] } | { kind: "not_enabled" } | { kind: "error"; message: string };

export function CardList({ source, unlocked, onUnlocked, onNavigate, notice }: CardsShared) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reads, setReads] = useState<Record<string, CardPrivateRead>>({});

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
    void Promise.all(state.cards.map(async (card) => [card.cardId, await source.readPrivate(card)] as const)).then((entries) => {
      if (active) setReads(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [source, unlocked, state]);

  const newCard = <Button type="button" variant="primary" label="New card" icon={<Plus size={18} />} onClick={() => onNavigate({ cardsNew: true })} />;

  return (
    <>
      <PageHeader copy={CARDS_LIST_COPY} action={state.kind === "not_enabled" ? undefined : newCard} />
      {notice}
      {state.kind === "loading" && <p className="owner-muted" aria-busy="true">Loading cards…</p>}
      {state.kind === "error" && <div className="builder-error" role="alert"><b>Cards couldn't load</b><span>{state.message}</span></div>}
      {state.kind === "not_enabled" && (
        <div className="owner-small-empty cp-cards-empty" data-testid="cards-not-enabled">
          <CreditCard />
          <h3>Cards aren't switched on yet</h3>
          <p>Agent cards are coming to this workspace. Your spending permissions keep working as they do today.</p>
        </div>
      )}
      {state.kind === "ready" && state.cards.length === 0 && (
        <div className="dashboard-card cp-cards-empty-hero" data-testid="cards-empty">
          <div className="cp-ghost-card" aria-hidden="true">
            <span className="cp-ghost-card-plus" aria-hidden="true"><Plus size={22} strokeWidth={2} /></span>
            <span className="cp-ghost-card-lines" aria-hidden="true"><i /><i /></span>
          </div>
          <div className="cp-cards-empty-copy">
            <h3>No cards yet</h3>
            <p>Give your agent a card with limits only you can read. It pays at regular checkouts, and you can freeze it in one tap.</p>
            {newCard}
          </div>
        </div>
      )}
      {state.kind === "ready" && state.cards.length > 0 && (
        <>
          {!unlocked && <UnlockStrip source={source} onUnlocked={onUnlocked} />}
          <div className="dashboard-card cp-card-table-wrap">
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
                      <td data-label="Left this period">{left !== null && policy ? <span><Money cents={left} /><small className="cp-sub"> of <Money cents={policy.budgetCents} /></small></span> : <PrivateValue />}</td>
                      <td data-label="Charged this period">{period ? <Money cents={period.capturedCents} /> : <PrivateValue />}</td>
                      <td data-label="Status"><Pill pill={status} /></td>
                      <td className="cp-row-action"><Button type="button" variant="secondary" label={status.key === "needs_restore" ? "Restore" : "Open"} onClick={() => onNavigate({ cardId: card.cardId })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
