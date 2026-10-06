import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { ArrowLeft, CircleCheck, CircleHelp, CircleX, Clock3, Snowflake, TriangleAlert } from "lucide-react";
import { availableCents, CardsApiError, type CardActivityRow, type CardView } from "@chainpayhq/sdk";
import { CARD_SECTIONS, type CardSection } from "../../routing/paths";
import { PageHeader } from "../PageHeader";
import { activationLines, cardStatus, isUnfinishedSetup, ISSUER_FREEZE_COPY } from "./lifecycle";
import { newOperationId, type CardPrivateRead, type CardStatements } from "./source";
import { errorText, type CardsShared } from "./shared";
import { UnlockStrip } from "./Unlock";
import { CardStatus, Money, PrivateValue, readFailed } from "./ui";
import { AgentCard, frostFor } from "./AgentCard";
import { CardActivity } from "./CardActivity";
import { CardStatement } from "./CardStatement";
import { CardSharing } from "./CardSharing";
import { CardPrivacyCheck } from "./CardPrivacyCheck";
import { RecoveryBanner } from "./CardRecovery";
import { CardNumberReveal } from "./CardNumberReveal";
import { CardAgentConnect } from "./CardAgentConnect";
import { CardFinishSetup } from "./CardFinishSetup";
import { CardCreate } from "./CardCreate";

const SECTION_LABELS: Record<CardSection, string> = { activity: "Activity", statement: "Statement", sharing: "Sharing", privacy: "Privacy check" };
const FREEZE_POLL_MS = 3_000;
const FREEZE_POLL_LIMIT = 40;


/** Card states where turning it on stopped partway: show each step as it is, with a way to resume. */
const PARTIAL_STATUS = new Set(["proof_pending", "opening", "limits_failed", "needs_activation", "setting_up"]);

export type CardDetailProps = CardsShared & {
  cardId: string;
  section: CardSection;
  wallet: string;
  mandates: { address: string; approvedAgent: string; allowedMint: string; status: string }[];
};

export function CardDetail(props: CardDetailProps) {
  const { source, unlocked, onUnlocked, onNavigate, cardId, section, notice } = props;
  const [card, setCard] = useState<CardView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [read, setRead] = useState<CardPrivateRead | undefined>();
  const [readError, setReadError] = useState("");
  const [activity, setActivity] = useState<CardActivityRow[] | null>(null);
  const [statements, setStatements] = useState<CardStatements | null>(null);
  const [busy, setBusy] = useState<"" | "freeze" | "unfreeze" | "activate">("");
  const [actionError, setActionError] = useState("");
  const [polling, setPolling] = useState(false);
  // Reused while the owner retries the same freeze/unfreeze; cleared once it succeeds.
  const freezeOp = useRef<string | null>(null);
  const unfreezeOp = useRef<string | null>(null);
  const activateOp = useRef<string | null>(null);
  // Set while the owner re-enters limits that weren't saved before setup stopped (the attempt to continue).
  const [limitsFor, setLimitsFor] = useState<string | null>(null);

  // Every response is dropped unless it still belongs to the card on screen.
  const currentCard = useRef(cardId);
  currentCard.current = cardId;

  const reload = useCallback(async () => {
    try {
      const next = await source.getCard(cardId);
      if (currentCard.current !== cardId) return null;
      setCard(next);
      setLoadError("");
      return next;
    } catch (error) {
      if (currentCard.current === cardId) setLoadError(errorText(error));
      return null;
    }
  }, [source, cardId]);

  const reloadActivity = useCallback(() => source.activity(cardId).then(
    (rows) => { if (currentCard.current === cardId) setActivity(rows); },
    () => { if (currentCard.current === cardId) setActivity([]); },
  ), [source, cardId]);
  const reloadStatements = useCallback(() => source.statements(cardId).then(
    (rows) => { if (currentCard.current === cardId) setStatements(rows); },
    () => { if (currentCard.current === cardId) setStatements({ closed: [], open: null }); },
  ), [source, cardId]);

  useEffect(() => {
    setCard(null);
    setRead(undefined);
    setReadError("");
    setActivity(null);
    setStatements(null);
    setLoadError("");
    setActionError("");
    setPolling(false);
    setLimitsFor(null);
    void reload();
    void reloadActivity();
    void reloadStatements();
  }, [reload, reloadActivity, reloadStatements]);

  // Switching tabs shows fresh rows: purchases and statements change while the owner looks elsewhere.
  const firstSection = useRef(true);
  useEffect(() => {
    if (firstSection.current) { firstSection.current = false; return; }
    if (section === "activity") void reloadActivity();
    if (section === "statement") void reloadStatements();
  }, [section, reloadActivity, reloadStatements]);

  const refreshPrivate = useCallback(async (target: CardView) => {
    if (!source.isUnlocked()) return;
    try {
      const next = await source.readPrivate(target);
      if (currentCard.current !== target.cardId) return;
      setRead(next);
      setReadError(readFailed(next) ? "The private rollup didn't answer for this card." : "");
    } catch (error) {
      // A failed read is an error with a retry, never "Private".
      if (currentCard.current === target.cardId) setReadError(errorText(error));
    }
  }, [source]);

  useEffect(() => {
    if (card && unlocked) void refreshPrivate(card);
  }, [card, unlocked, refreshPrivate]);

  // Freeze stays "waiting for confirmation" until the card network acknowledges (ruling K9).
  useEffect(() => {
    if (!polling) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      const next = await reload();
      if (!next || next.freeze.issuer !== "pending_issuer_confirmation" || tries >= FREEZE_POLL_LIMIT) {
        setPolling(false);
      }
    }, FREEZE_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, reload]);

  async function freeze() {
    if (!card) return;
    setBusy("freeze");
    setActionError("");
    try {
      freezeOp.current ??= newOperationId("freeze");
      await source.freeze(card.cardId, "Frozen by the owner from the dashboard", freezeOp.current);
      freezeOp.current = null;
      setCard({ ...card, freeze: { onChain: true, issuer: "pending_issuer_confirmation" } });
      setPolling(true);
      void reloadActivity();
      void refreshPrivate(card);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy("");
    }
  }

  async function unfreeze() {
    if (!card || read?.policy.state !== "visible") return;
    setBusy("unfreeze");
    setActionError("");
    try {
      unfreezeOp.current ??= newOperationId("unfreeze");
      setCard(await source.unfreeze(card, read.policy.account.policyVersion, unfreezeOp.current));
      unfreezeOp.current = null;
      void reloadActivity();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy("");
    }
  }

  // Resume the persisted activation; show whatever state Axum actually reached, success or not.
  async function finishActivation() {
    if (!card) return;
    setBusy("activate");
    setActionError("");
    try {
      activateOp.current ??= newOperationId("activate");
      const next = await source.finishActivation(card, activateOp.current);
      if (currentCard.current !== card.cardId) return;
      setCard(next);
      if (cardStatus(next).key === "active") activateOp.current = null;
    } catch (error) {
      if (error instanceof CardsApiError && error.card && currentCard.current === card.cardId) setCard(error.card);
      // Axum's words name program instructions; the owner gets the step instead.
      setActionError(error instanceof CardsApiError && error.code === "policy_not_visible" ? "Your limits aren't saved yet, so the card can't be turned on. Use Finish setup." : errorText(error));
    } finally {
      setBusy("");
    }
  }

  if (loadError && !card) {
    return (
      <>
        <PageHeader copy={{ kicker: "AGENT CARDS", title: "Card", subtitle: "" }} action={<Button type="button" variant="secondary" label="Back to cards" icon={<ArrowLeft size={16} />} onClick={() => onNavigate({})} />} />
        <div className="builder-error" role="alert"><b>This card couldn't load</b><span>{loadError}</span></div>
      </>
    );
  }
  if (!card) return <p className="owner-muted" aria-busy="true">Loading card…</p>;

  if (limitsFor) {
    return (
      <CardCreate
        source={source}
        unlocked={unlocked}
        onUnlocked={onUnlocked}
        onNavigate={onNavigate}
        notice={notice}
        resume={{
          card,
          attemptId: limitsFor,
          onCancel: () => setLimitsFor(null),
          onFinished: () => { setLimitsFor(null); void reload(); },
        }}
      />
    );
  }

  const status = cardStatus(card);
  const unfinished = isUnfinishedSetup(card);
  const recovery = source.recovery(card);
  const policy = read?.policy.state === "visible" ? read.policy.account : null;
  const period = read?.period.state === "visible" ? read.period.account : null;
  const exceptionsOpen = policy?.exceptionsOpen ?? 0;
  const left = policy && period ? availableCents(BigInt(policy.budgetCents), period.capturedCents, period.reservedCents) : null;
  const unfreezeBlocked = recovery.state !== "normal"
    ? "Finish the restore first."
    : exceptionsOpen > 0
      ? `Review ${exceptionsOpen === 1 ? "the flagged charge" : `${exceptionsOpen} flagged charges`} first.`
      : !policy ? "Show private details to unfreeze." : "";

  return (
    <>
      <PageHeader
        copy={{ kicker: "AGENT CARDS", title: card.label, subtitle: `Card ending ${card.lastFour}` }}
        action={<Button type="button" variant="secondary" label="All cards" icon={<ArrowLeft size={16} />} onClick={() => onNavigate({})} />}
      />
      {notice}
      {recovery.state !== "normal" && (
        <RecoveryBanner source={source} card={card} recovery={recovery} onChanged={async () => { const next = await reload(); if (next) void refreshPrivate(next); }} />
      )}
      <section className="dashboard-card cp-card-hero" data-status={status.key}>
        <div className="cp-card-hero-object">
          <AgentCard className="cp-card-hero-card is-lift" label={card.label} lastFour={card.lastFour} frost={frostFor(card)} leftCents={left} />
          <CardNumberReveal source={source} card={card} closeKey={section} />
        </div>
        <div className="cp-card-hero-body">
          <div className="cp-card-hero-top">
            <div className="cp-card-hero-text">
              <CardStatus pill={status} />
              {card.freeze.onChain && (
                <ul className="cp-freeze-lines" data-testid="freeze-lines">
                  <li data-system="chainpay"><CircleCheck size={16} aria-hidden="true" /> Frozen on ChainPay. New purchases are declined.</li>
                  <li data-system="issuer" data-issuer={card.freeze.issuer}>
                    {card.freeze.issuer === "confirmed" ? <CircleCheck size={16} aria-hidden="true" /> : card.freeze.issuer === "failed" ? <TriangleAlert size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
                    {ISSUER_FREEZE_COPY[card.freeze.issuer]}
                    {card.freeze.issuer === "pending_issuer_confirmation" && <span className="cp-visually-hidden"> (pending issuer confirmation)</span>}
                  </li>
                </ul>
              )}
              {unfinished && (
                <CardFinishSetup
                  source={source}
                  card={card}
                  unlocked={unlocked}
                  onUnlocked={onUnlocked}
                  onLimitsNeeded={setLimitsFor}
                  onFinished={() => void reload()}
                />
              )}
              {!unfinished && !card.freeze.onChain && PARTIAL_STATUS.has(status.key) && (
                <>
                  {status.detail && <p className="cp-activation-detail">{status.detail}</p>}
                  <ul className="cp-freeze-lines cp-activation-lines" data-testid="activation-lines" aria-label="Turning the card on">
                    {activationLines(card).map((line) => (
                      <li key={line.key} data-step={line.key} data-state={line.state}>
                        {line.state === "done" ? <CircleCheck size={16} aria-hidden="true" /> : line.state === "failed" ? <CircleX size={16} aria-hidden="true" /> : line.state === "unknown" ? <CircleHelp size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
                        {line.text}
                        <span className="cp-visually-hidden"> ({line.state})</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div className="cp-card-hero-actions">
              {!unfinished && !card.freeze.onChain && PARTIAL_STATUS.has(status.key) && card.activation?.detail !== "new_activation_disabled" && (
                <Button type="button" variant="primary" label={busy === "activate" ? "Checking…" : status.key === "limits_failed" || status.key === "needs_activation" ? "Turn on again" : "Check again"} isDisabled={Boolean(busy)} onClick={() => void finishActivation()} />
              )}
              {card.freeze.onChain ? (
                <>
                  <Button type="button" variant="secondary" label={busy === "unfreeze" ? "Waiting for wallet…" : "Unfreeze"} isDisabled={Boolean(busy) || Boolean(unfreezeBlocked)} onClick={() => void unfreeze()} />
                  {unfreezeBlocked && <small className="owner-muted">{unfreezeBlocked}</small>}
                </>
              ) : (
                <Button type="button" variant="secondary" className="cp-freeze-button" label={busy === "freeze" ? "Freezing…" : "Freeze card"} icon={<Snowflake size={16} />} isDisabled={Boolean(busy)} onClick={() => void freeze()} />
              )}
              <CardAgentConnect source={source} card={card} />
            </div>
          </div>
          <div className="cp-card-left" data-private={policy && period ? "no" : "yes"}>
            <span className="cp-card-left-label">Left this period</span>
            <strong className="cp-card-left-value">{left !== null ? <Money cents={left} /> : <PrivateValue failed={Boolean(readError)} />}</strong>
            <SpendMeter failed={Boolean(readError)} budget={policy ? BigInt(policy.budgetCents) : null} charged={period?.capturedCents ?? null} held={period?.reservedCents ?? null} left={left} />
          </div>
          <dl className="cp-card-numbers">
            <div><dt>Owed on statement</dt><dd>{policy ? <Money cents={policy.statementOutstandingCents} /> : <PrivateValue failed={Boolean(readError)} />}</dd></div>
            <div><dt>Budget per period</dt><dd>{policy ? <Money cents={policy.budgetCents} /> : <PrivateValue failed={Boolean(readError)} />}</dd></div>
            <div><dt>Max per purchase</dt><dd>{policy ? <Money cents={policy.maxPurchaseCents} /> : <PrivateValue failed={Boolean(readError)} />}</dd></div>
          </dl>
        </div>
        {actionError && <div className="builder-error cp-card-hero-error" role="alert"><b>Needs attention</b><span>{actionError}</span></div>}
      </section>
      {!unlocked && <UnlockStrip source={source} onUnlocked={onUnlocked} compact />}
      {unlocked && readError && (
        <div className="builder-error cp-read-failed" role="alert" data-testid="card-read-failed">
          <b>Private details didn't load</b>
          <span>{readError}</span>
          <Button type="button" variant="secondary" label="Try again" onClick={() => void refreshPrivate(card)} />
        </div>
      )}

      <TabList className="cp-card-tabs" value={section} onChange={(value) => onNavigate({ cardId, cardSection: value as CardSection })} role="tablist" aria-label="Card sections">
        {CARD_SECTIONS.map((item) => <Tab key={item} value={item} label={SECTION_LABELS[item]} panelId={`card-section-${item}`} />)}
      </TabList>
      <div id={`card-section-${section}`} role="tabpanel" className="cp-card-section">
        {section === "activity" && <CardActivity source={source} card={card} rows={activity} onChanged={() => { void reloadActivity(); void refreshPrivate(card); }} />}
        {section === "statement" && <CardStatement source={source} card={card} statements={statements} mandates={props.mandates} wallet={props.wallet} onChanged={() => { void reloadStatements(); void refreshPrivate(card); }} />}
        {section === "sharing" && <CardSharing source={source} card={card} read={read} unlocked={unlocked} onUnlocked={onUnlocked} onChanged={() => void refreshPrivate(card)} />}
        {section === "privacy" && <CardPrivacyCheck source={source} card={card} unlocked={unlocked} onUnlocked={onUnlocked} />}
      </div>
    </>
  );
}

/** Charged · held · left, as exact shares of the budget. A hatched bar until the limits are readable (ruling P3, K3: never $0). */
function SpendMeter({ budget, charged, held, left, failed = false }: { budget: bigint | null; charged: string | bigint | null; held: string | bigint | null; left: string | bigint | null; failed?: boolean }) {
  const legend = (charged !== null || held !== null) && (
    <ul className="cp-meter-legend">
      <li data-part="charged"><i aria-hidden="true" />Charged {charged !== null ? <Money cents={charged} /> : <PrivateValue failed={failed} />}</li>
      <li data-part="held"><i aria-hidden="true" />Held {held !== null ? <Money cents={held} /> : <PrivateValue failed={failed} />}</li>
      <li data-part="left"><i aria-hidden="true" />Left {left !== null ? <Money cents={left} /> : <PrivateValue failed={failed} />}</li>
    </ul>
  );
  if (budget === null || charged === null || held === null) {
    return <><div className="cp-meter is-private" aria-hidden="true" />{legend}</>;
  }
  const total = budget > 0n ? budget : 1n;
  // Integer basis points, so a late or forced charge past the budget never yields float noise.
  const bps = (part: bigint) => (part < 0n ? 0n : part > total ? total : part) * 10_000n / total;
  const chargedBps = bps(BigInt(charged));
  const heldBps = bps(BigInt(held)) < 10_000n - chargedBps ? bps(BigInt(held)) : 10_000n - chargedBps;
  const chargedPct = Number(chargedBps) / 100;
  const heldPct = Number(heldBps) / 100;
  return (
    <>
      <div className="cp-meter" role="img" aria-label={`Charged ${chargedPct}% and held ${heldPct}% of the budget`}>
        <span className="cp-meter-charged" style={{ width: `${chargedPct}%` }} />
        <span className="cp-meter-held" style={{ width: `${heldPct}%` }} />
      </div>
      {legend}
    </>
  );
}
