import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Info, Link2, ShieldCheck } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import type { Mandate } from "@chainpayhq/sdk";
import Allowances, { kindLabel, modeLabel } from "../../paypal/Allowances";
import Marketplace from "../../paypal/Marketplace";
import Disputes from "../../paypal/Disputes";
import { ApprovalInbox } from "../../paypal/Approvals";
import { checkoutUrl, dollars, shownMoney, type Allowance, type Merchant, type Receipt } from "../../paypal/client";
import { DEVNET_PYUSD_TOKEN_2022_MINT } from "../../config/public";
import { PAYPAL_VIEWS, type PaypalView } from "../../routing/paths";
import { mandateDisplayName, shortAddress, type StablecoinOption } from "../../owner/runtime";
import { Amount } from "../../ui/amount/Amount";
import { paypalSourceOverride, PaypalNotConfiguredError, type PaypalConnection, type PaypalSource } from "./source";
import { createLivePaypalSource } from "./liveSource";
import "../../paypal/paypal.css";
import "../../paypal/paypal-two.css";
import "./paypal-tab.css";

export const PAYPAL_VIEW_LABELS: Record<PaypalView, string> = {
  connect: "Connect",
  allowances: "Allowances",
  marketplace: "Marketplace",
  activity: "Activity",
  disputes: "Disputes",
};

export type PaypalAreaProps = {
  wallet: string;
  view: PaypalView;
  /** The owner's wallet session (relay) is ready, so it can be traded for a PayPal one. */
  sessionReady: boolean;
  signingIn?: boolean;
  signInError?: string;
  onSignIn: () => void;
  mandates: Mandate[];
  stablecoinOptions: StablecoinOption[];
  onView: (view: PaypalView) => void;
  /** Opens Spending permissions; `true` opens the new-permission builder. */
  onOpenPermissions: (builder?: boolean) => void;
};

type Shared = { allowances: Allowance[]; merchants: Merchant[]; approvals: Receipt[] };

/** PayPal sandbox tab. Reuses the standalone workspace's components and API client. */
export function PaypalArea(props: PaypalAreaProps) {
  const source: PaypalSource = useMemo(
    () => paypalSourceOverride() ?? createLivePaypalSource(props.wallet),
    // One source (and one in-memory PayPal session) per wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.wallet],
  );
  const fixture = source.mode === "fixture";
  const canConnect = fixture || props.sessionReady;
  const [connection, setConnection] = useState<PaypalConnection | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [version, setVersion] = useState(0);
  const [shared, setShared] = useState<Shared | null>(null);
  const [busy, setBusy] = useState(false);
  // Set by "Forget this session": no automatic reconnect until the owner asks.
  const [paused, setPaused] = useState(false);
  const live = useRef(true);
  const viewsRef = useRef<HTMLDivElement>(null);
  // On a phone the switcher scrolls sideways: keep the current view in sight.
  useEffect(() => {
    const current = viewsRef.current?.querySelector<HTMLElement>("[aria-checked='true'], [aria-selected='true']");
    current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.view, connection]);
  // Back from PayPal's approval page with ?allowance=: land on Allowances so its return handler runs.
  const returning = useRef(new URLSearchParams(location.search).has("allowance"));

  useEffect(() => { live.current = true; return () => { live.current = false; source.disconnect(); }; }, [source]);

  const connect = useCallback(async () => {
    setConnecting(true); setError(""); setPaused(false);
    try {
      const next = await source.connect();
      if (live.current) setConnection(next);
    } catch (cause) {
      if (live.current) setError(cause instanceof PaypalNotConfiguredError ? cause.message : cause instanceof Error ? cause.message : String(cause));
    } finally { if (live.current) setConnecting(false); }
  }, [source]);

  useEffect(() => {
    if (canConnect && !connection && !connecting && !error && !paused) void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConnect, connection, source, paused]);

  useEffect(() => {
    if (returning.current && props.view !== "allowances") { returning.current = false; props.onView("allowances"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const api = connection?.api;
  const load = useCallback(async () => {
    if (!api) return;
    const [a, c, p] = await Promise.all([
      api<{ allowances: Allowance[] }>("/allowances"),
      api<{ merchants: Merchant[] }>("/catalog"),
      api<{ approvals: Receipt[] }>("/purchases/approvals"),
    ]);
    if (live.current) setShared({ allowances: a.allowances ?? [], merchants: c.merchants ?? [], approvals: p.approvals ?? [] });
  }, [api]);
  useEffect(() => { void load().catch((cause) => { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }); }, [load, version]);
  const changed = () => setVersion((v) => v + 1);

  async function decide(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await fn(); changed(); }
    catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current) setBusy(false); }
  }

  const banner = fixture ? (
    <div className="cp-paypal-illustrative" data-testid="paypal-illustrative" role="note">
      <Info size={18} aria-hidden="true" />
      <p><b>Example data.</b> This is a made-up sandbox so you can see how it works. No PayPal account, no real money.</p>
    </div>
  ) : null;

  if (!canConnect) {
    return <div className="paypal-shell cp-paypal-tab" data-paypal-mode={source.mode}>
      <section className="paypal-card cp-paypal-gate">
        <h2>Sign in to open PayPal</h2>
        <p className="paypal-note">Your wallet sign-in opens a PayPal sandbox session for this tab. A login message isn't a payment approval.</p>
        {props.signInError && <p role="alert" className="paypal-error">{props.signInError}</p>}
        <div className="paypal-actions"><Button label={props.signingIn ? "Waiting for your wallet…" : "Sign in"} isDisabled={props.signingIn} onClick={props.onSignIn} /></div>
      </section>
    </div>;
  }

  if (!connection) {
    return <div className="paypal-shell cp-paypal-tab" data-paypal-mode={source.mode}>
      {banner}
      <section className="paypal-card cp-paypal-gate" aria-busy={connecting}>
        <h2>{error ? "PayPal didn't open" : paused ? "PayPal session closed" : "Opening PayPal…"}</h2>
        {error ? <p role="alert" className="paypal-error">{error}</p> : <p className="paypal-note">{paused ? "This tab forgot its PayPal session. Your allowances are still there." : "Swapping your wallet sign-in for a PayPal sandbox session. It stays in this tab's memory."}</p>}
        {paused && !error && <div className="paypal-actions"><Button label="Open PayPal" onClick={() => void connect()} /></div>}
        {error && <div className="paypal-actions"><Button label="Try again" variant="secondary" isDisabled={connecting} onClick={() => void connect()} /></div>}
      </section>
    </div>;
  }

  const { principal } = connection;
  const merchants = shared?.merchants ?? [];
  const allowances = shared?.allowances ?? [];

  return <div className="paypal-shell cp-paypal-tab" data-paypal-mode={source.mode} data-paypal-view={props.view}>
    {banner}
    {error && <p role="alert" className="paypal-error">{error}</p>}

    {principal.role === "buyer" && shared && <ApprovalInbox approvals={shared.approvals} merchants={merchants} allowances={allowances} busy={busy} declineLabel="Decline"
      onApprove={(task) => decide(() => connection.api(`/purchases/${task.id}/approve`, "POST", { digest: task.quote_digest }))}
      onDecline={(task) => decide(() => connection.api(`/purchases/${task.id}/deny`, "POST", { reason: "Denied by buyer" }))} />}

    <div className="cp-paypal-views" ref={viewsRef}>
      <SegmentedControl className="cp-segmented cp-paypal-segmented" label="PayPal views" value={props.view} onChange={(value) => props.onView(value as PaypalView)}>
        {PAYPAL_VIEWS.map((view) => <SegmentedControlItem key={view} value={view} label={PAYPAL_VIEW_LABELS[view]} />)}
      </SegmentedControl>
    </div>

    {props.view === "connect" && <ConnectView connection={connection} allowances={allowances} loaded={Boolean(shared)} fixture={fixture}
      onConnect={() => props.onView("allowances")} onForget={() => { source.disconnect(); setPaused(true); setConnection(null); setShared(null); setError(""); }} />}

    {props.view === "allowances" && <>
      <LimitsSideBySide allowances={allowances} merchants={merchants} mandates={props.mandates} stablecoinOptions={props.stablecoinOptions} onOpenPermissions={props.onOpenPermissions} />
      <Allowances key={`allowances:${version}`} api={connection.api} principal={principal} showInbox={false} onReceipt={changed} />
    </>}

    {props.view === "marketplace" && <Marketplace key={`market:${version}`} api={connection.api} principal={principal} onPurchased={() => { changed(); props.onView("activity"); }} />}

    {props.view === "activity" && <Activity key={`activity:${version}`} api={connection.api} merchants={merchants} allowances={allowances} />}

    {props.view === "disputes" && <Disputes key={`disputes:${version}`} api={connection.api} canAct={principal.role === "merchant"} onOpenTask={() => props.onView("activity")} />}
  </div>;
}

function ConnectView({ connection, allowances, loaded, fixture, onConnect, onForget }: { connection: PaypalConnection; allowances: Allowance[]; loaded: boolean; fixture: boolean; onConnect: () => void; onForget: () => void }) {
  const ready = allowances.filter((a) => a.vault?.status === "ready" && a.status !== "Revoked");
  const waiting = allowances.find((a) => a.vault?.status === "pending_approval" && a.vault.approval_url);
  const linked = ready.length > 0;
  let approvalHref: string | null = null;
  try { approvalHref = waiting?.vault?.approval_url ? checkoutUrl(waiting.vault.approval_url) : null; } catch { approvalHref = null; }
  return <section className="paypal-card cp-paypal-connect" aria-label="PayPal connection">
    <div className="cp-paypal-connect-head">
      <span className={`cp-paypal-link-dot${linked ? " is-on" : ""}`} aria-hidden="true"><Link2 size={18} /></span>
      <div>
        <h2>{!loaded ? "Checking PayPal…" : linked ? "PayPal is connected" : waiting ? "Almost there" : "PayPal isn't connected yet"}</h2>
        <p className="paypal-note">
          {!loaded ? "One sec."
            : linked ? `Your agent can pay through PayPal on ${ready.length} ${ready.length === 1 ? "allowance" : "allowances"}, and only inside their limits.`
            : waiting ? "PayPal still needs your OK before the agent can pay."
            : "Connecting happens with your first allowance: you set the limits, then approve PayPal once."}
        </p>
      </div>
      <span className={`paypal-pill is-${linked ? "active" : waiting ? "paused" : "none"}`}>{linked ? "Linked" : waiting ? "Waiting on PayPal" : "Not linked"}</span>
    </div>
    <dl className="cp-paypal-facts">
      <div><dt>Wallet</dt><dd><code title={connection.wallet}>{shortAddress(connection.wallet)}</code></dd></div>
      <div><dt>Signed in as</dt><dd>{connection.principal.role === "buyer" ? "You (buyer)" : connection.principal.role}</dd></div>
      <div><dt>Money</dt><dd>PayPal sandbox{fixture ? " · example data" : ""}</dd></div>
      <div><dt>Session</dt><dd>{connection.expiresAt ? `This tab, until ${new Date(connection.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "This tab only"}</dd></div>
    </dl>
    <div className="paypal-actions">
      {approvalHref ? <a className="paypal-submit" href={approvalHref}>Continue PayPal approval</a>
        : <Button label={linked ? "Add another allowance" : "Connect PayPal"} icon={<ArrowRight size={16} />} onClick={onConnect} />}
      <Button label="Forget this session" variant="secondary" onClick={onForget} />
    </div>
    <ol className="cp-paypal-steps">
      <li><b>Set the limits.</b> How much, where, and when it asks you first.</li>
      <li><b>Approve PayPal once.</b> PayPal saves the payment method for that allowance.</li>
      <li><b>Your agent shops.</b> Every purchase gets checked against the rules. Anything over your line comes here for a tap.</li>
    </ol>
    <p className="paypal-note cp-paypal-guard"><ShieldCheck size={14} aria-hidden="true" />The agent never sees your PayPal login, and the PayPal session lives in this tab's memory only.</p>
  </section>;
}

function LimitsSideBySide({ allowances, merchants, mandates, stablecoinOptions, onOpenPermissions }: { allowances: Allowance[]; merchants: Merchant[]; mandates: Mandate[]; stablecoinOptions: StablecoinOption[]; onOpenPermissions: (builder?: boolean) => void }) {
  const active = allowances.filter((a) => a.status === "Active");
  const left = active.reduce((sum, a) => sum + BigInt(a.remaining_cents), 0n);
  const merchantName = (id: string) => merchants.find((m) => m.id === id)?.name ?? id;
  const openMandates = mandates.filter((m) => m.status === "active" || m.status === "paused");
  const pyusd = stablecoinOptions.find((o) => o.mint === DEVNET_PYUSD_TOKEN_2022_MINT);
  return <section className="cp-paypal-limits" aria-label="PayPal allowances and Solana permissions">
    <p className="cp-paypal-limits-lede"><Info size={15} aria-hidden="true" />Solana mandates and PayPal allowances are separate limits.</p>
    <div className="cp-paypal-limits-grid">
      <div className="paypal-card cp-paypal-limit-col">
        <span className="paypal-eyebrow">PayPal · sandbox USD</span>
        <h3>{shownMoney(dollars(left))} <small>left on {active.length} active {active.length === 1 ? "allowance" : "allowances"}</small></h3>
        <ul className="cp-paypal-limit-list">
          {allowances.length === 0 && <li className="paypal-note">None yet.</li>}
          {allowances.map((a) => <li key={a.id}>
            <span><b>{a.name}</b><small>{modeLabel(a)} · {a.merchants.map(merchantName).join(", ")}{a.categories?.length ? ` · ${a.categories.map(kindLabel).join(", ")}` : ""}</small></span>
            <span className="cp-paypal-limit-amount">{shownMoney(dollars(a.remaining_cents))}<small>of {shownMoney(dollars(a.total_cap_cents))}</small></span>
          </li>)}
        </ul>
      </div>
      <div className="paypal-card cp-paypal-limit-col" data-testid="paypal-solana-mandates">
        <span className="paypal-eyebrow">Solana · read only</span>
        <h3>{openMandates.length} spending {openMandates.length === 1 ? "permission" : "permissions"} <small>on devnet</small></h3>
        <ul className="cp-paypal-limit-list">
          {mandates.length === 0 && <li className="paypal-note">None yet.</li>}
          {mandates.slice(0, 4).map((m) => {
            const symbol = stablecoinOptions.find((o) => o.mint === m.allowedMint)?.label;
            const remaining = m.totalLimit > m.amountSpent ? m.totalLimit - m.amountSpent : 0n;
            return <li key={m.address}>
              <span><b>{mandateDisplayName(m, mandates, stablecoinOptions)}</b><small>{m.status} · agent {shortAddress(m.approvedAgent)}</small></span>
              <span className="cp-paypal-limit-amount"><Amount baseUnits={remaining} mint={m.allowedMint} symbol={symbol} showRetry={false} /><small>left</small></span>
            </li>;
          })}
          {mandates.length > 4 && <li className="paypal-note">And {mandates.length - 4} more.</li>}
        </ul>
        <div className="paypal-actions" style={{ marginBottom: 0 }}>
          <Button label="Open spending permissions" variant="secondary" onClick={() => onOpenPermissions(false)} />
        </div>
        <div className="cp-paypal-pyusd" data-testid="paypal-fund-pyusd">
          <b>Fund with PYUSD</b>
          <p>Rather pay from your own wallet? Give your agent a PYUSD spending permission on Solana devnet. Its own rail, its own limit.</p>
          <p className="cp-paypal-pyusd-mint">{pyusd?.label ?? "PYUSD"} mint <code title={DEVNET_PYUSD_TOKEN_2022_MINT}>{shortAddress(DEVNET_PYUSD_TOKEN_2022_MINT)}</code></p>
          <button type="button" className="paypal-link-button" onClick={() => onOpenPermissions(true)}>Set up a PYUSD permission <ArrowRight size={14} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  </section>;
}

function purchaseStatus(t: Receipt): { word: string; tone: "active" | "paused" | "none" | "revoked" } {
  if (t.purchase?.approval === "requested") return { word: "Waiting for you", tone: "paused" };
  if (t.purchase?.approval === "denied") return { word: "Declined", tone: "none" };
  if (t.refund_confirmed) return { word: t.net === "0.00" ? "Refunded" : "Partly refunded", tone: "none" };
  if (t.dispute) return { word: "Disputed", tone: "revoked" };
  if (t.captured) return { word: "Paid", tone: "active" };
  return { word: "Not paid", tone: "none" };
}

function Activity({ api, merchants, allowances }: { api: PaypalConnection["api"]; merchants: Merchant[]; allowances: Allowance[] }) {
  const [tasks, setTasks] = useState<Receipt[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api<{ tasks: Receipt[] }>("/tasks").then((r) => { if (alive) setTasks(r.tasks ?? []); }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [api]);
  const purchases = (tasks ?? []).filter((t) => t.purchase).sort((a, b) => b.created_at - a.created_at);
  const merchantName = (id: string) => merchants.find((m) => m.id === id)?.name ?? id;
  const allowanceName = (id?: string) => allowances.find((a) => a.id === id)?.name ?? id ?? "No allowance";
  return <section className="paypal-card cp-paypal-activity" aria-label="PayPal purchases">
    <div className="paypal-card-header"><div><span className="paypal-eyebrow">Sandbox receipts</span><h2>Activity</h2></div></div>
    {error && <p role="alert" className="paypal-error">{error}</p>}
    {!tasks && !error && <p className="paypal-note" aria-busy="true">Loading purchases…</p>}
    {tasks && purchases.length === 0 && <p className="paypal-note">Nothing bought yet. When your agent buys something, the receipt lands here.</p>}
    <ul className="cp-paypal-activity-list">
      {purchases.map((t) => {
        const status = purchaseStatus(t);
        const lines = (t.purchase?.lines ?? []).map((l) => `${l.qty} × ${l.name}`).join(", ");
        return <li key={t.id} className="cp-paypal-activity-row" data-status={status.word}>
          <div className="cp-paypal-activity-main">
            <strong>{merchantName(t.purchase!.merchant)}</strong>
            <span>{lines}</span>
            <small>{new Date(t.created_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {allowanceName(t.purchase?.allowance_id)}{t.purchase?.approval === "approved" ? " · you approved it" : ""}</small>
            {t.refund_confirmed && t.purchase?.allowance_id && <small className="cp-paypal-restored">Refunded {shownMoney(t.refund)}. That went back on the allowance.</small>}
            {t.dispute && <small className="cp-paypal-disputed">Dispute {t.dispute.id} · {t.dispute.status.toLowerCase().replaceAll("_", " ")}</small>}
          </div>
          <div className="cp-paypal-activity-side">
            <span className={`paypal-pill is-${status.tone}`}>{status.word}</span>
            <b className={t.refund_confirmed ? "is-struck" : undefined}>{shownMoney(t.gross)}</b>
            {t.refund_confirmed && <small>Net {shownMoney(t.net)}</small>}
          </div>
        </li>;
      })}
    </ul>
  </section>;
}

export default PaypalArea;
