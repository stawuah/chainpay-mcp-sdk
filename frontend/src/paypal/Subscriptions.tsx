import { useEffect, useRef, useState } from "react";
import { Bot, Repeat, ShieldCheck } from "lucide-react";
import { UsageRing } from "../dashboard/overview/UsageRing";
import { usageRing } from "../dashboard/overview/spending";
import { checkoutUrl, shownMoney, type client, type Principal, type Receipt, type Service } from "./client";

type Terms = { terms: string; plan_id: string; enabled: boolean; policy: string; price: string; units: number };
type Delegation = { id: string; agent: string; services: string[]; task_limit: number; period_limit: number; expires_at: number; revoked: boolean; lifetime_reserved_units?: number; remaining_period_capacity?: number; available_units?: number };
type View = { subscription: { id: string; status: string; approval_url?: string; payment_review?: string; create: { state: string }; cancel?: { state: string } }; periods: { start_at: number; end_at: number; available: number; payment_id?: string; blocked: boolean }[]; delegations: Delegation[] };

export default function Subscriptions({ api, principal, services, selected, onAllocated }: { api: ReturnType<typeof client>; principal: Principal; services: Service[]; selected?: Receipt; onAllocated: (r: Receipt) => void }) {
  const [terms, setTerms] = useState<Terms>();
  const [views, setViews] = useState<View[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const delegationRequests = useRef(new Map<string, string>());
  const scope = `chainpay.paypal.subscription:${principal.workspace}:${principal.id}`;
  const request = useRef(sessionStorage.getItem(`${scope}:create`) ?? crypto.randomUUID());
  useEffect(() => { sessionStorage.setItem(`${scope}:create`, request.current); }, [scope]);
  const live = useRef(true);
  const [agent, setAgent] = useState("");
  const [service, setService] = useState("document-extract-v1");
  const [limit, setLimit] = useState(1);
  const [cycle, setCycle] = useState(5);
  const [expiry, setExpiry] = useState("");

  async function load() {
    const [t, v] = await Promise.all([api<Terms>("/subscriptions/terms"), api<{ subscriptions: View[] }>("/subscriptions")]);
    if (live.current) { setTerms(t); setViews(v.subscriptions ?? []); }
  }
  useEffect(() => { live.current = true; void load().catch(e => { if (live.current) setError(e.message); }); return () => { live.current = false; }; }, [api]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); await load(); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Unavailable; keep the original operation"); }
    finally { if (live.current) setBusy(false); }
  }

  const buyer = principal.role === "buyer";
  const activePeriod = views.flatMap(v => v.periods).find(p => !p.blocked);
  const availableUnits = activePeriod ? BigInt(Math.max(0, Math.min(10, activePeriod.available))) : 0n;
  const usedUnits = activePeriod ? 10n - availableUnits : 0n;
  const ringState = usageRing({
    spent: usedUnits,
    limit: activePeriod ? 10n : 0n,
    decimalsKnown: Boolean(activePeriod),
  });

  return <section className="paypal-card" aria-label="Subscription allowance">
    <div className="paypal-card-header" style={{ marginBottom: 8 }}>
      <div>
        <span className="paypal-eyebrow"><Repeat size={14} aria-hidden="true" />Prepaid quota</span>
        <h2>Monthly service allowance</h2>
      </div>
      <div className="paypal-actions" style={{ margin: 0 }}>
        <button disabled={busy} onClick={() => void act(async () => {})}>Refresh allowance</button>
        {buyer && <button className="paypal-btn-primary" disabled={busy || !terms?.enabled || views.some(v => v.subscription.status !== "CANCELLED")} onClick={() => void act(async () => {
          if (!terms) return;
          const cancelled = views.length > 0 && views.every(v => v.subscription.status === "CANCELLED") ? views.map(v => v.subscription.id).sort().join(",") : "";
          if (cancelled && sessionStorage.getItem(`${scope}:replaced-cancelled`) !== cancelled) {
            request.current = crypto.randomUUID();
            sessionStorage.setItem(`${scope}:create`, request.current);
            sessionStorage.setItem(`${scope}:replaced-cancelled`, cancelled);
          }
          const v = await api<View>("/subscriptions", "POST", { request_id: request.current, terms: terms.terms, plan_id: terms.plan_id });
          if (live.current) setViews(old => [v, ...old.filter(x => x.subscription.id !== v.subscription.id)]);
        })}>Approve {terms ? shownMoney(terms.price) : "the"} monthly subscription terms</button>}
      </div>
    </div>

    <div className="paypal-allowance-hero">
      <UsageRing state={ringState} label={activePeriod ? `${usedUnits.toString()} of 10 service units used` : "No active verified service period"} />
      <div>
        <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{terms ? `${shownMoney(terms.price)} USD / month · ${terms.units} service units.` : "Subscription terms loading."} Prepaid service access, no rollover or overage.</p>
        {terms?.policy && <p style={{ margin: "0 0 4px" }}>{terms.policy}</p>}
        <p className="paypal-note" style={{ margin: 0 }}>These are ChainPay service-policy periods, not PayPal historical coverage. Cancellation stops renewal. Existing reservations may finish after expiry or revocation. Billing review blocks work.</p>
      </div>
    </div>

    {error && <p role="alert" className="paypal-error">{error}</p>}
    {!terms?.enabled && <p className="paypal-notice">New subscription purchases and allocations are paused. Existing records and cancellation remain available.</p>}

    {views.map(v => <article key={v.subscription.id} className="paypal-subscription-card">
      <div className="paypal-card-header" style={{ marginBottom: 8 }}>
        <div>
          <h3>Subscription {v.subscription.id.slice(0, 8)}</h3>
          <p style={{ margin: "4px 0 0", fontFamily: "var(--pp-mono)", fontSize: 12 }}>{v.subscription.status} · create {v.subscription.create.state}</p>
        </div>
        <div className="paypal-actions" style={{ margin: 0 }}>
          {buyer && v.subscription.approval_url && v.subscription.status !== "ACTIVE" && v.subscription.status !== "CANCELLED" && <a className="paypal-submit" href={checkoutUrl(v.subscription.approval_url)}>Continue PayPal sandbox approval</a>}
          <button disabled={busy} onClick={() => void act(async () => { await api(`/subscriptions/${v.subscription.id}/reconcile`, "POST"); })}>Reconcile original subscription</button>
          {buyer && <button disabled={busy || Boolean(v.subscription.cancel)} onClick={() => void act(async () => { await api(`/subscriptions/${v.subscription.id}/cancel`, "POST", { terms: `cancel:${v.subscription.id}:stop-renewal-keep-paid-access`, reason: "Buyer requested stopping future renewal" }); })}>Confirm cancel renewal; keep verified paid access</button>}
        </div>
      </div>

      {v.subscription.payment_review && <p role="alert" className="paypal-notice">{v.subscription.payment_review}</p>}
      {v.subscription.cancel && <p className="paypal-note">Cancellation: {v.subscription.cancel.state}. Reconcile an unknown result; do not submit another cancellation.</p>}
      {!v.periods.length && <p className="paypal-note">No verified paid service period. PayPal ACTIVE alone does not fund work.</p>}
      {v.periods.map(p => <p key={p.start_at} style={{ fontVariantNumeric: "tabular-nums" }}>{p.available} available units · {new Date(p.start_at * 1000).toLocaleDateString()}–{new Date(p.end_at * 1000).toLocaleDateString()} · payment reference <code>{p.payment_id ?? "Not verified"}</code>{p.blocked ? " · billing review" : ""}</p>)}
      <p className="paypal-note">Cash refunds require merchant billing review using the payment reference above. Restored service units are not cash refunds.</p>

      {selected && !selected.subscription_funding && !selected.funded && !selected.captured && !selected.order_state && buyer && <div className="paypal-actions">
        <button className="paypal-btn-primary" disabled={busy || !terms?.enabled} onClick={() => void act(async () => {
          const task = await api<Receipt>(`/tasks/${selected.id}/allowance`, "POST", { subscription_id: v.subscription.id, digest: selected.quote_digest });
          if (live.current) onAllocated(task);
        })}>Approve allocation of {selected.allowance_units ?? selected.units.length} units to quote {selected.id.slice(0, 8)}</button>
      </div>}

      <h4><Bot size={15} style={{ verticalAlign: "text-bottom", marginRight: 6 }} aria-hidden="true" />Bounded agent delegations</h4>
      {v.delegations.length > 0 && <div className="paypal-delegation-grid">
        {v.delegations.map(d => {
          const used = d.lifetime_reserved_units ?? 0;
          const pct = d.period_limit > 0 ? Math.min(100, Math.round((used / d.period_limit) * 100)) : 0;
          return <div key={d.id} className={`paypal-delegation-card${d.revoked ? " is-revoked" : ""}`}>
            <p style={{ margin: 0, fontWeight: 600 }}>Agent {d.agent} · {d.services.join(", ")} · {d.task_limit} units/task · {d.period_limit} lifetime reserved units/period · expires {new Date(d.expires_at * 1000).toLocaleString()} · {d.revoked ? "revoked" : "approved"}</p>
            <div className="paypal-delegation-meter" aria-hidden="true">
              <div className="paypal-delegation-meter-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="paypal-note" style={{ margin: 0 }}>{d.lifetime_reserved_units ?? 0} units reserved over this period’s lifetime · {d.remaining_period_capacity ?? 0} units of delegation capacity left · {d.available_units ?? 0} units available now. Failure restoration does not reset this ceiling.</p>
            <code>{d.id}</code>
            <div className="paypal-actions" style={{ margin: 0 }}>
              {buyer && <button disabled={busy || d.revoked} onClick={() => void act(async () => { await api(`/subscriptions/${v.subscription.id}/delegations/${d.id}`, "DELETE"); })}>Revoke new allocations</button>}
              {principal.role === "agent" && selected && !selected.subscription_funding && !selected.funded && !selected.captured && <button className="paypal-btn-primary" disabled={busy || d.revoked || !terms?.enabled} onClick={() => void act(async () => {
                const task = await api<Receipt>(`/tasks/${selected.id}/allowance`, "POST", { subscription_id: v.subscription.id, delegation_id: d.id, digest: selected.quote_digest });
                if (live.current) onAllocated(task);
              })}>Allocate this quote with approved delegation</button>}
            </div>
          </div>;
        })}
      </div>}

      {buyer && <form className="paypal-form-grid" onSubmit={e => {
        e.preventDefault();
        void act(async () => {
          const intent = { agent, services: [service], task_limit: limit, period_limit: cycle, expires_at: Math.floor(new Date(expiry).getTime() / 1000), approve: true };
          const key = JSON.stringify([v.subscription.id, intent]);
          let request_id = delegationRequests.current.get(key) ?? sessionStorage.getItem(`${scope}:delegation:${key}`);
          if (!request_id) { request_id = crypto.randomUUID(); }
          delegationRequests.current.set(key, request_id);
          sessionStorage.setItem(`${scope}:delegation:${key}`, request_id);
          await api(`/subscriptions/${v.subscription.id}/delegations`, "POST", { request_id, ...intent });
        });
      }}>
        <label>Agent identity<input value={agent} required onChange={e => setAgent(e.target.value)} placeholder="e.g. research-bot" /></label>
        <label>Approved service<select value={service} onChange={e => setService(e.target.value)}>{services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Units per task<input type="number" min={1} max={10} required value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
        <label>Units per service period<input type="number" min={1} max={10} required value={cycle} onChange={e => setCycle(Number(e.target.value))} /></label>
        <label>Expiry<input type="datetime-local" required value={expiry} onChange={e => setExpiry(e.target.value)} /></label>
        <p className="paypal-note"><ShieldCheck size={14} style={{ verticalAlign: "text-bottom", marginRight: 4 }} aria-hidden="true" />Failed outputs may restore subscription quota; they never reset this agent’s period reservation ceiling. Agents cannot subscribe, cancel, refund or increase limits.</p>
        <button className="paypal-btn-primary" disabled={busy || !terms?.enabled}>Approve exactly these agent limits</button>
      </form>}
    </article>)}
  </section>;
}
