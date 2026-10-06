import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Mandate } from "@chainpayhq/sdk";
import { ArrowRight, Bot, Clock3, CreditCard, Inbox, ShieldCheck } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { TokenIcon } from "../ui/TokenIcon";
import { chainpayClient, connectionSeenLabel, mandateDisplayName, type AgentConnection, type AgentInboxItem, type StablecoinOption } from "../owner/runtime";
import type { RecentActivityRow } from "../owner/recentActivity";
import { shortAddress } from "../ui/marks";
import { publicReceiptPath } from "../receipts/model";
import { useSlotEstimate } from "../owner/useSlotEstimate";
import { estimatedSlotsForDays } from "../owner/slotEstimate";
import { Amount, AmountsUnavailable } from "../ui/amount/Amount";
import { useMintMetadataMany } from "../ui/amount/useMintMetadata";
import { formatDisplayAmount } from "../ui/amount/formatDisplayAmount";
import { SectionHeader } from "../ui/workspace/SectionHeader";
import { CollectionState } from "../ui/workspace/CollectionState";
import { knownCount, type CollectionStateKind } from "../ui/workspace/collectionModel";
import { Status, statusFor } from "../ui/workspace/Status";
import { activityStatus, connectionStatusProps, requestStageStatus } from "./workspaceStatus";
import { totalsByMint, usageRing } from "./overview/spending";
import { UsageRing } from "./overview/UsageRing";
import { cardsAttention, type CardsLifecycleCount, type CardsSummaryState } from "./overview/cardsSummary";

/*
  Overview (EXPERIENCE.md, 2026-10-04):
  1. Spending by token: spent, remaining allowance and limit beside the one ring.
  2. Operational counts: permissions, agents, requests, cards.
  3. Attention items when real (promoted to the top): requests, permissions
     expiring within a day, and cards that need restore or whose freeze is
     pending or unconfirmed. Otherwise one slim line, and "clear" only when
     every input (expiry and the cards list) was actually checked.
  4. Recent activity beside agents and cards.
*/
export type OwnerOverviewProps = {
  mandates: Mandate[];
  connections: AgentConnection[];
  connectionState: CollectionStateKind;
  attention: AgentInboxItem[];
  activity: RecentActivityRow[];
  assets: StablecoinOption[];
  cards: CardsSummaryState & { retry: () => void };
  onRetryConnections: () => void;
  onRequests: () => void;
  onAgents: () => void;
  onCards: () => void;
  onPermissions: () => void;
  onPermission: (address: string) => void;
  onPayments: () => void;
};

export function OwnerOverview({ mandates, connections, connectionState, attention, activity, assets, cards, onRetryConnections, onRequests, onAgents, onCards, onPermissions, onPermission, onPayments }: OwnerOverviewProps) {
  const [slot, setSlot] = useState<{ status: "loading" | "ready" | "error"; value: bigint | null }>({ status: "loading", value: null });
  const { estimate, status: estimateStatus } = useSlotEstimate();
  useEffect(() => {
    let active = true;
    void chainpayClient.getCurrentSlot()
      .then((value) => { if (active) setSlot({ status: "ready", value }); })
      .catch(() => { if (active) setSlot({ status: "error", value: null }); });
    return () => { active = false; };
  }, []);

  const totals = useMemo(() => totalsByMint(mandates), [mandates]);
  const metadata = useMintMetadataMany(totals.map((total) => total.mint));
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const selected = totals.find((total) => total.mint === selectedMint) ?? totals.find((total) => total.active.count > 0) ?? totals[0];
  const symbol = (mint: string) => assets.find((asset) => asset.mint === mint)?.label ?? shortAddress(mint);

  const activePermissions = mandates.filter((mandate) => mandate.status === "active");
  const soon = estimate ? estimatedSlotsForDays(1, estimate) : null;
  const expiryChecked = activePermissions.length === 0 || (slot.status === "ready" && soon !== null);
  const expiryPending = activePermissions.length > 0 && (slot.status === "loading" || (slot.status === "ready" && estimateStatus === "loading"));
  const expiring = expiryChecked && slot.value !== null && soon !== null
    ? activePermissions.filter((mandate) => mandate.expiresAtSlot > slot.value! && mandate.expiresAtSlot - slot.value! <= soon)
    : [];
  const cardCheck = cardsAttention(cards);
  const cardItems = cardCheck.items;
  const attentionCount = attention.length + expiring.length + cardItems.reduce((sum, row) => sum + row.count, 0);
  // What could not be checked, so neither the list nor the clear line can claim to be complete.
  const unchecked: Unchecked[] = [
    ...(!expiryChecked && !expiryPending ? [{ key: "expiry", label: "Expiry not checked", what: "permission expiry couldn’t be checked right now" }] : []),
    ...(cardCheck.status === "unchecked" ? [{ key: "cards", label: "Cards not checked", what: cardCheck.reason === "signed-out" ? "cards load after you sign in" : "your cards couldn’t be read" }] : []),
  ];
  const checksPending = expiryPending || cardCheck.status === "pending";

  // The count badge takes the most serious tone in the list: red once anything is blocked or failed.
  const attentionHasError = attention.some((item) => item.stage === "blocked") || cardItems.some((row) => row.tone === "critical");
  const attentionSection = attentionCount > 0 && (
    <section className="cp-surface cp-overview-attention" aria-labelledby="overview-attention-title">
      <SectionHeader id="overview-attention-title" title="Needs your attention" action={<Status {...statusFor(attentionHasError ? "failed" : "review", `${attentionCount} ${attentionCount === 1 ? "item" : "items"}`)} />} />
      <ul className="cp-row-list">
        {attention.slice(0, 5).map((item) => (
          <li key={item.id}>
            <button type="button" className="cp-row" onClick={onRequests}>
              <span className={`cp-row-icon ${item.stage === "blocked" ? "is-critical" : item.stage === "waiting_for_approval" ? "is-info" : "is-warning"}`} aria-hidden="true"><Inbox size={18} /></span>
              <span className="cp-row-main"><strong>{item.title || "Payment request"}</strong><small>{item.stage === "waiting_for_approval" ? "Ready for your review" : item.stage === "blocked" ? "Needs attention before it can continue" : "More details needed"}</small></span>
              <Status {...requestStageStatus(item.stage)} />
              <span className="cp-row-link">Review <ArrowRight size={16} aria-hidden="true" /></span>
            </button>
          </li>
        ))}
        {expiring.map((mandate) => (
          <li key={mandate.address}>
            <button type="button" className="cp-row" onClick={() => onPermission(mandate.address)}>
              <span className="cp-row-icon is-warning" aria-hidden="true"><Clock3 size={18} /></span>
              <span className="cp-row-main"><strong>{mandateDisplayName(mandate, mandates, assets)}</strong><small>Expires within about a day · estimated from slot timing</small></span>
              <Status {...statusFor("review", "Expires soon")} />
              <span className="cp-row-link">Review <ArrowRight size={16} aria-hidden="true" /></span>
            </button>
          </li>
        ))}
        {cardItems.map((row) => (
          <li key={`card:${row.key}`}>
            <button type="button" className="cp-row" onClick={onCards}>
              <span className={`cp-row-icon ${row.tone === "info" ? "is-info" : row.tone === "critical" ? "is-critical" : "is-warning"}`} aria-hidden="true"><CreditCard size={18} /></span>
              <span className="cp-row-main"><strong>{cardAttentionTitle(row)}</strong><small>{cardCheck.status === "checked" && cardCheck.illustrative ? "Illustrative · " : ""}{CARD_ATTENTION_DETAIL[row.key] ?? "Open Cards to check it."}</small></span>
              <Status tone={row.tone} icon={row.icon} label={row.label} />
              <span className="cp-row-link">Review <ArrowRight size={16} aria-hidden="true" /></span>
            </button>
          </li>
        ))}
      </ul>
      {attention.length > 5 && <Button label={`View all ${attention.length} requests`} variant="ghost" onClick={onRequests} />}
      {unchecked.length > 0 && <CheckNote unchecked={unchecked} text={`${sentenceCase(joinParts(unchecked.map((item) => item.what)))}, so something that needs you may be missing from this list.`} />}
    </section>
  );

  const clearLine = attentionCount === 0 && (
    checksPending ? (
      <div className="cp-overview-clear" data-state="loading" aria-busy="true"><Skeleton width={220} height={16} /><span className="sr-only">Checking what needs your attention…</span></div>
    ) : unchecked.length === 0 ? (
      <div className="cp-overview-clear" data-state="clear" role="status">
        <Status {...statusFor("verified", "Nothing needs your attention")} />
        <span>No requests are waiting{activePermissions.length ? " and no active permission expires within a day" : ""}.</span>
      </div>
    ) : (
      <CheckNote className="cp-overview-clear" data-state="partial" unchecked={unchecked} text={`No requests are waiting in this browser. ${sentenceCase(joinParts(unchecked.map((item) => item.what)))}, so this isn’t a full all-clear.`} />
    )
  );

  const ring = selected ? usageRing({ spent: selected.active.spent, limit: selected.active.limit, decimalsKnown: metadata.states[selected.mint]?.status === "verified" }) : null;
  const selectedState = selected ? metadata.states[selected.mint] : undefined;
  const ringLabel = !selected || !ring ? "" : ring.kind === "unavailable"
    ? ring.reason === "zero-limit" ? `${symbol(selected.mint)}: no active limit to measure against` : `${symbol(selected.mint)}: usage unavailable until token details load`
    : `${symbol(selected.mint)}: ${ring.percent}% of the active limit spent (${selectedState?.status === "verified" ? `${formatDisplayAmount(selected.active.spent, selectedState.decimals)} of ${formatDisplayAmount(selected.active.limit, selectedState.decimals)}` : ""})`;

  const agentCount = knownCount(connectionState, connections.length);
  const liveAgents = connections.filter((connection) => Boolean(connection.lastSeenAt)).length;
  const cardTotal = cards.state === "loaded" || cards.state === "empty" ? cards.summary.total : null;

  return (
    <div className="owner-overview cp-overview">
      {attentionSection}

      {/* Spending and the counts share a row on wide screens, so a single token's card has no empty right half. */}
      <div className={`cp-overview-summary${selected && ring ? " has-spending" : ""}`}>
      {selected && ring && (
        <section className="cp-surface cp-overview-spending" aria-labelledby="overview-spending-title">
          <SectionHeader id="overview-spending-title" title="Spending by token" description="Across loaded permissions. Each token is totalled on its own." action={<SectionLink label="Manage permissions" onClick={onPermissions} />} />
          {totals.length > 1 && (
            <SegmentedControl className="cp-segmented" label="Token" value={selected.mint} onChange={setSelectedMint}>
              {totals.map((total) => <SegmentedControlItem key={total.mint} value={total.mint} label={symbol(total.mint)} />)}
            </SegmentedControl>
          )}
          <div className="cp-overview-spending-body">
            <UsageRing state={ring} label={ringLabel} />
            {selectedState?.status === "unavailable" ? (
              // Three figures of one mint without decimals: one message, one retry
              // and one raw-units disclosure, as the permissions ledger does.
              <div className="cp-figures is-unavailable">
                <dl className="cp-figures-labels">
                  {["Spent", "Remaining allowance", "Limit"].map((name) => <div className="cp-figure" key={name}><dt>{name}</dt><dd aria-label="Not available">—</dd></div>)}
                </dl>
                <AmountsUnavailable values={[["spent", selected.active.spent], ["remaining", selected.active.remaining], ["limit", selected.active.limit]]} onRetry={metadata.retryAll} />
              </div>
            ) : (
              <dl className="cp-figures">
                <div className="cp-figure is-lead">
                  <dt><TokenIcon mint={selected.mint} size={18} /> Spent</dt>
                  <dd><Amount baseUnits={selected.active.spent} mint={selected.mint} symbol={symbol(selected.mint)} size="lead" /></dd>
                </div>
                <div className="cp-figure">
                  <dt>Remaining allowance</dt>
                  <dd><Amount baseUnits={selected.active.remaining} mint={selected.mint} symbol={symbol(selected.mint)} showRetry={false} /></dd>
                </div>
                <div className="cp-figure">
                  <dt>Limit</dt>
                  <dd><Amount baseUnits={selected.active.limit} mint={selected.mint} symbol={symbol(selected.mint)} showRetry={false} /></dd>
                </div>
              </dl>
            )}
          </div>
          <p className="cp-caption">
            {selected.active.count} of {selected.permissionCount} {symbol(selected.mint)} {selected.permissionCount === 1 ? "permission is" : "permissions are"} active and counted here; paused, expired and revoked ones are left out. Remaining allowance is what agents may still spend, not a wallet balance or a card budget.
          </p>
        </section>
      )}

      <section className="cp-overview-counts" aria-label="Workspace counts">
        <CountTile icon={<ShieldCheck size={18} />} label="Active permissions" value={activePermissions.length} detail={`${mandates.length} loaded`} onClick={onPermissions} />
        <CountTile
          icon={<Bot size={18} />} label="Connected agents" value={agentCount} onClick={onAgents}
          loading={connectionState === "loading"}
          detail={connectionState === "signed-out" ? "Sign in to see" : connectionState === "failed" || connectionState === "partial" ? "Couldn’t load" : `${liveAgents} active`}
        />
        <CountTile icon={<Inbox size={18} />} label="Open requests" value={attention.length} detail="Waiting on you, in this browser" onClick={onRequests} />
        <CountTile
          icon={<CreditCard size={18} />} label="Cards" value={cardTotal} onClick={onCards}
          loading={cards.state === "loading"}
          detail={cards.state === "signed-out" ? "Sign in to see" : cards.state === "not-enabled" ? "Not switched on" : cards.state === "failed" ? "Couldn’t load" : cards.state === "loaded" ? `${cards.illustrative ? "Illustrative · " : ""}${cards.summary.lifecycle.map((row) => `${row.count} ${row.label.toLowerCase()}`).join(" · ")}` : cards.state === "empty" ? "None yet" : ""}
        />
      </section>
      </div>

      {clearLine}

      <div className="cp-overview-columns">
        <section className="cp-surface" aria-labelledby="overview-activity-title">
          <SectionHeader id="overview-activity-title" title="Recent activity" description="Requests and payments from this browser." action={<SectionLink label="View payments" onClick={onPayments} />} />
          <CollectionState state={activity.length ? "loaded" : "empty"} noun="activity" title="No activity yet" description="Requests and payments will appear here as your agents work." compact>
            <ul className="cp-row-list">
              {activity.slice(0, 6).map((row) => (
                <li key={`${row.source}:${row.id}`} className="cp-row is-static">
                  <span className="cp-row-main"><strong>{row.label}</strong></span>
                  <Status {...activityStatus(row)} />
                  {row.receiptAddress
                    ? <a className="cp-row-link" href={publicReceiptPath(row.receiptAddress)}>Receipt <ArrowRight size={16} aria-hidden="true" /></a>
                    : <button type="button" className="cp-row-link" onClick={onRequests}>View request <ArrowRight size={16} aria-hidden="true" /></button>}
                </li>
              ))}
            </ul>
          </CollectionState>
        </section>

        <div className="cp-overview-stack">
          <section className="cp-surface" aria-labelledby="overview-agents-title">
            <SectionHeader id="overview-agents-title" title="Agents" action={<SectionLink label="View agents" onClick={onAgents} />} />
            <CollectionState
              state={connectionState} noun="agents" compact rows={2}
              description={connectionState === "signed-out" ? "Agent connections load after you sign in. Signing in is not a spending approval." : connectionState === "failed" ? "Agent connections couldn’t be refreshed." : "Connect an agent to use your spending permissions."}
              title={connectionState === "empty" ? "No agents connected" : undefined}
              action={connectionState === "empty" ? <Button label="Connect agent" variant="secondary" onClick={onAgents} /> : undefined}
              onRetry={onRetryConnections}
            >
              <ul className="cp-row-list">
                {connections.slice(0, 4).map((connection) => (
                  <li key={connection.id}>
                    <button type="button" className="cp-row" onClick={onAgents}>
                      <span className="cp-row-icon" aria-hidden="true"><Bot size={18} /></span>
                      <span className="cp-row-main"><strong>{connection.agentName}</strong><small>{connectionSeenLabel(connection.lastSeenAt)}</small></span>
                      <Status {...connectionStatusProps(connection)} />
                    </button>
                  </li>
                ))}
              </ul>
            </CollectionState>
          </section>

          <section className="cp-surface" aria-labelledby="overview-cards-title">
            <SectionHeader id="overview-cards-title" title={cards.illustrative ? <>Cards <span className="cp-illustrative-tag" data-testid="overview-cards-illustrative">Illustrative</span></> : "Cards"} description={cards.illustrative ? "Example cards. Nothing here is real money or a real card." : undefined} action={<SectionLink label="View cards" onClick={onCards} />} />
            {cards.state === "loaded" ? (
              <ul className="cp-row-list">
                {cards.summary.lifecycle.map((row) => (
                  <li key={row.key} className="cp-row is-static is-compact">
                    <span className="cp-row-main"><Status tone={row.tone} icon={row.icon} label={row.label} /></span>
                    <span className="cp-row-count">{row.count} {row.count === 1 ? "card" : "cards"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <CollectionState
                state={cards.state === "not-enabled" ? "empty" : cards.state} noun="cards" compact rows={2}
                title={cards.state === "not-enabled" ? "Cards aren’t switched on" : cards.state === "empty" ? "No cards yet" : undefined}
                description={cards.state === "signed-out" ? "Cards load after you sign in." : cards.state === "not-enabled" ? "This workspace doesn’t have agent cards yet." : cards.state === "failed" ? "The card list couldn’t be read." : "Give an agent a card with its own private limits."}
                action={cards.state === "empty" ? <Button label="Create a card" variant="secondary" onClick={onCards} /> : undefined}
                onRetry={cards.retry}
              />
            )}
            {/* Only under counts: a sign-in prompt, an empty list or an error counts nothing. */}
            {cards.state === "loaded" && <p className="cp-caption">Counts only. Card limits and spending stay private until you unlock them in Cards.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

type Unchecked = { key: string; label: string; what: string };

/** Unchecked inputs: the pills sit in their own column and the sentence wraps beside them, never under them. */
function CheckNote({ unchecked, text, className, ...rest }: { unchecked: Unchecked[]; text: string; className?: string; "data-state"?: string }) {
  return (
    <div className={className ? `${className} cp-check-note` : "cp-check-note"} role="status" {...rest}>
      <span className="cp-check-note-pills">{unchecked.map((item) => <Status key={item.key} {...statusFor("unknown", item.label)} />)}</span>
      <span className="cp-check-note-text">{text}</span>
    </div>
  );
}

const joinParts = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const CARD_ATTENTION_DETAIL: Record<string, string> = {
  needs_restore: "Frozen for recovery. Restore it in Cards before an agent can use it.",
  freeze_failed: "The card network didn’t confirm the freeze. ChainPay keeps declining every purchase.",
  freeze_pending: "Waiting for the card network to confirm the freeze.",
};

function cardAttentionTitle(row: CardsLifecycleCount) {
  const one = row.count === 1;
  const cards = one ? "1 card" : `${row.count} cards`;
  if (row.key === "needs_restore") return `${cards} ${one ? "needs" : "need"} restore`;
  if (row.key === "freeze_failed") return `Freeze not confirmed on ${cards}`;
  if (row.key === "freeze_pending") return `Freeze pending on ${cards}`;
  return `${row.label} on ${cards}`;
}

/** Navigation out of a section: the same blue link-with-arrow as the row actions. */
function SectionLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="cp-row-link cp-section-link" onClick={onClick}>{label} <ArrowRight size={16} aria-hidden="true" /></button>;
}

function CountTile({ icon, label, value, detail, loading = false, onClick }: { icon: ReactNode; label: string; value: number | null; detail: string; loading?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="cp-count" onClick={onClick} data-known={value !== null && !loading}>
      <span className="cp-count-label"><span aria-hidden="true">{icon}</span>{label}</span>
      {loading
        ? <span className="cp-count-value" aria-busy="true"><Skeleton width={40} height={28} /><span className="sr-only">Loading</span></span>
        : <strong className="cp-count-value">{value === null ? <span aria-label="Not available">—</span> : value}</strong>}
      <span className="cp-count-detail">{detail}</span>
    </button>
  );
}
