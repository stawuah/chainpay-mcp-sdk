import { useEffect, useRef, useState, type Ref } from "react";
import { ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { BrandLogo } from "../brand/Brand";
import { PayPalRequestUncertainError, centsFromDollars, checkoutUrl, dollars, jsonInt, shownMoney, type Allowance, type AllowanceMode, type client, type Merchant, type Principal, type Receipt } from "./client";
import { ApprovalInbox } from "./Approvals";

const modeWord: Record<AllowanceMode, string> = { agent_pays: "Agent pays", ask_first: "Ask me first", ask_above: "Ask me above a limit" };
/** One line for an allowance's mode. ask_above names its threshold. */
export function modeLabel(a: Pick<Allowance, "mode" | "ask_above_cents">): string {
  return a.mode === "ask_above" ? `Ask me above ${shownMoney(dollars(a.ask_above_cents ?? null))}` : modeWord[a.mode];
}
/** Plain words for catalog merchant kinds. Unknown kinds show as sent. */
export const kindWords: Record<string, string> = { grocery: "Groceries", events: "Tickets", booking: "Tours", print: "Print" };
export const kindLabel = (kind: string) => kindWords[kind] ?? kind;

export default function Allowances({ api, principal, onReceipt, showInbox = true, builderRef, onPendingChange }: { api: ReturnType<typeof client>; principal: Principal; onReceipt: (r: Receipt) => void; onPendingChange?: (pending: boolean) => void; /** The dashboard tab shows approvals above its sub-views, so it turns this one off. */ showInbox?: boolean; builderRef?: Ref<HTMLFormElement> }) {
  const buyer = principal.role === "buyer";
  const [allowances, setAllowances] = useState<Allowance[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [approvals, setApprovals] = useState<Receipt[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const requestId = useRef(crypto.randomUUID());
  const createIntent = useRef<Record<string, unknown> | null>(null);
  const [createUncertain, setCreateUncertain] = useState(false);
  useEffect(() => { onPendingChange?.(busy || createUncertain); }, [busy, createUncertain, onPendingChange]);
  useEffect(() => {
    if (!busy && !createUncertain) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, createUncertain]);
  const formRef = useRef<HTMLFormElement | null>(null);

  // Builder fields. Dollars stay text until they become a cents string.
  const [name, setName] = useState("Weekly groceries");
  const [total, setTotal] = useState("20.00");
  const [perPurchase, setPerPurchase] = useState("8.00");
  const [mode, setMode] = useState<AllowanceMode>("agent_pays");
  const [askAbove, setAskAbove] = useState("5.00");
  const [categories, setCategories] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [agent, setAgent] = useState("");
  const [expiry, setExpiry] = useState(() => localDateTime(Date.now() + 30 * 86400000));
  const [cooldown, setCooldown] = useState("60");
  const [maxPerDay, setMaxPerDay] = useState("3");
  const [source, setSource] = useState<"paypal" | "card">("paypal");
  const [card, setCard] = useState({ number: "", expiry: "", name: "" });

  async function load() {
    const [a, c, p] = await Promise.all([
      api<{ allowances: Allowance[] }>("/allowances"),
      api<{ merchants: Merchant[] }>("/catalog"),
      buyer ? api<{ approvals: Receipt[] }>("/purchases/approvals") : Promise.resolve({ approvals: [] }),
    ]);
    if (!live.current) return;
    setAllowances(a.allowances ?? []);
    setMerchants(c.merchants ?? []);
    setApprovals(p.approvals ?? []);
    setPicked(old => old.length ? old : (c.merchants ?? []).slice(0, 1).map(m => m.id));
  }
  useEffect(() => {
    live.current = true;
    void act(async () => {
      // Back from PayPal: finish the payment method, then drop the query so a reload does not repeat it.
      const returned = new URLSearchParams(location.search).get("allowance");
      if (returned && buyer) {
        await api(`/allowances/${encodeURIComponent(returned)}/vault`, "POST", {});
        history.replaceState(null, "", location.pathname);
      }
    });
    return () => { live.current = false; };
  }, [api]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); await load(); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Unavailable; keep the original operation"); }
    finally { if (live.current) setBusy(false); }
  }
  // Any edit is a new intent, so it gets a new request id.
  function touch() { requestId.current = crypto.randomUUID(); }

  const totalCents = centsFromDollars(total);
  const perCents = centsFromDollars(perPurchase);
  const askCents = mode === "ask_above" ? centsFromDollars(askAbove) : null;
  const askOk = mode !== "ask_above" || Boolean(askCents && perCents && BigInt(askCents) < BigInt(perCents));
  const kinds = [...new Set(merchants.map(m => m.kind))];
  const merchantName = (id: string) => merchants.find(m => m.id === id)?.name ?? id;
  const expiresAt = expiry ? Math.floor(new Date(expiry).getTime() / 1000) : NaN;
  const formOk = askOk && name.trim() && totalCents && perCents && BigInt(perCents) <= BigInt(totalCents) && picked.length > 0 && Number.isFinite(expiresAt) && expiresAt > Date.now() / 1000 && /^\d+$/.test(cooldown) && /^\d+$/.test(maxPerDay) && BigInt(maxPerDay) > 0n && (source === "paypal" || (card.number.replace(/\s/g, "").length >= 12 && /^\d{4}-\d{2}$/.test(card.expiry) && card.name.trim()));

  return <section className="paypal-card paypal-allowances" aria-label="Agent allowances">
    <div className="paypal-card-header">
      <div>
        <span className="paypal-eyebrow"><Wallet size={14} aria-hidden="true" />Agent spending</span>
        <h2>Allowances</h2>
      </div>
      <div className="paypal-actions" style={{ margin: 0 }}>
        {buyer && <Button label="New allowance" variant="secondary" onClick={() => { formRef.current?.scrollIntoView({ block: "start" }); formRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); }} />}
        <Button label="Refresh" variant="secondary" isDisabled={busy} onClick={() => void act(async () => {})} />
      </div>
    </div>
    {error && <p role="alert" className="paypal-error">{error}</p>}

    {buyer && showInbox && <ApprovalInbox approvals={approvals} merchants={merchants} allowances={allowances} busy={busy}
      onApprove={task => act(async () => {
        const receipt = await api<Receipt>(`/purchases/${task.id}/approve`, "POST", { digest: task.quote_digest });
        if (live.current) onReceipt(receipt);
      })}
      onDecline={task => act(async () => { await api(`/purchases/${task.id}/deny`, "POST", { reason: "Denied by buyer" }); })} />}

    {allowances.length === 0 && <p className="paypal-note">{buyer ? "No allowances yet. The preview updates as you set your limits." : "No Active allowance names this agent yet."}</p>}
    <div className="paypal-allowance-list">
      {allowances.map(a => {
        const spent = BigInt(a.spent_cents), total = BigInt(a.total_cap_cents);
        const pct = total > 0n ? Number(spent * 100n / total) : 0;
        return <article key={a.id} className={`paypal-allowance-row is-${a.status.toLowerCase()}`}>
          <div className="paypal-allowance-row-head">
            <div>
              <h3>{a.name}</h3>
              <p className="paypal-note" style={{ margin: 0 }}>{modeLabel(a)} · {a.merchants.map(merchantName).join(", ")}{a.categories?.length ? ` · ${a.categories.map(kindLabel).join(", ")}` : ""} · {a.agent ? `agent ${a.agent}` : "any agent"}</p>
            </div>
            <span className={`paypal-pill is-${a.status.toLowerCase()}`}>{a.status}</span>
          </div>
          <div className="paypal-spend-meter" role="img" aria-label={`${shownMoney(dollars(a.spent_cents))} of ${shownMoney(dollars(a.total_cap_cents))} spent`}>
            <span style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <dl className="paypal-allowance-facts">
            <div><dt>Spent</dt><dd>{shownMoney(dollars(a.spent_cents))}</dd></div>
            <div><dt>Remaining</dt><dd>{shownMoney(dollars(a.remaining_cents))}</dd></div>
            <div><dt>Per purchase</dt><dd>{shownMoney(dollars(a.per_purchase_cap_cents))}</dd></div>
            <div><dt>Today</dt><dd>{a.purchases_today} of {a.max_per_day}</dd></div>
            <div><dt>Cooldown</dt><dd>{a.cooldown_seconds}s</dd></div>
            <div><dt>Expires</dt><dd>{new Date(a.expires_at * 1000).toLocaleDateString()}</dd></div>
          </dl>
          {buyer && a.vault && <p className="paypal-note" style={{ margin: "8px 0 0" }}>
            {a.vault.status === "ready" ? `Payment method ready (${a.vault.source === "card" ? "sandbox card" : "PayPal sandbox"}).` : a.vault.status === "pending_approval" ? "PayPal approval still needed before the agent can pay." : "No payment method on file. Purchases will be refused."}
          </p>}
          {buyer && <div className="paypal-actions" style={{ marginBottom: 0 }}>
            {a.vault?.approval_url && a.vault.status === "pending_approval" && <a className="paypal-submit" href={checkoutUrl(a.vault.approval_url)}>Continue PayPal approval</a>}
            {a.status === "Active" && <Button label="Pause" variant="secondary" isDisabled={busy} onClick={() => void act(async () => { await api(`/allowances/${a.id}/status`, "POST", { status: "Paused" }); })} />}
            {a.status === "Paused" && <Button label="Resume" variant="secondary" isDisabled={busy} onClick={() => void act(async () => { await api(`/allowances/${a.id}/status`, "POST", { status: "Active" }); })} />}
            {a.status !== "Revoked" && <Button label="Revoke" variant="secondary" isDisabled={busy} onClick={() => void act(async () => { await api(`/allowances/${a.id}/status`, "POST", { status: "Revoked" }); })} />}
          </div>}
        </article>;
      })}
    </div>

    {buyer && <div className="paypal-allowance-builder">
      <form ref={node => { formRef.current = node; if (typeof builderRef === "function") builderRef(node); else if (builderRef) builderRef.current = node; }} className="paypal-form-grid" aria-label="New allowance" onSubmit={e => {
        e.preventDefault();
        if (busy || (!createIntent.current && (!formOk || !totalCents || !perCents))) return;
        void act(async () => {
          const body = createIntent.current ?? {
            request_id: requestId.current, name: name.trim(), total_cap_cents: jsonInt(totalCents!), per_purchase_cap_cents: jsonInt(perCents!),
            expires_at: expiresAt, cooldown_seconds: Number(cooldown), max_per_day: Number(maxPerDay), merchants: picked, mode,
            ask_above_cents: mode === "ask_above" && askCents ? jsonInt(askCents) : undefined,
            categories: categories.length ? categories : undefined,
            agent: agent.trim() || undefined, vault_source: source, card: source === "card" ? { number: card.number.replace(/\s/g, ""), expiry: card.expiry, name: card.name.trim() } : undefined,
          };
          createIntent.current = body;
          try {
            await api("/allowances", "POST", body);
          } catch (cause) {
            if (cause instanceof PayPalRequestUncertainError) setCreateUncertain(true);
            else if (!createUncertain) { createIntent.current = null; setCreateUncertain(false); }
            throw cause;
          }
          createIntent.current = null;
          setCreateUncertain(false);
          requestId.current = crypto.randomUUID();
          setCard({ number: "", expiry: "", name: "" });
        });
      }}>
        <label>Name<input disabled={busy || createUncertain} value={name} required maxLength={80} onChange={e => { setName(e.target.value); touch(); }} /></label>
        <label>Total cap (USD)<input disabled={busy || createUncertain} inputMode="decimal" value={total} required onChange={e => { setTotal(e.target.value); touch(); }} aria-invalid={!totalCents} /></label>
        <label>Per purchase cap (USD)<input disabled={busy || createUncertain} inputMode="decimal" value={perPurchase} required onChange={e => { setPerPurchase(e.target.value); touch(); }} aria-invalid={!perCents || (totalCents ? BigInt(perCents) > BigInt(totalCents) : false)} /></label>
        <fieldset className="paypal-choice">
          <legend>Mode</legend>
          {(["agent_pays", "ask_above", "ask_first"] as const).map(m => <label key={m} className={mode === m ? "is-active" : ""}>
            <input disabled={busy || createUncertain} type="radio" name="allowance-mode" value={m} checked={mode === m} onChange={() => { setMode(m); touch(); }} />{modeWord[m]}
          </label>)}
        </fieldset>
        {mode === "ask_above" && <label>Ask me above (USD)<input disabled={busy || createUncertain} inputMode="decimal" value={askAbove} required onChange={e => { setAskAbove(e.target.value); touch(); }} aria-invalid={!askOk} aria-describedby="ask-above-hint" /><small id="ask-above-hint" className="paypal-note">Under this the agent just pays. Over it, you get a tap to approve. Keep it below the per-purchase cap.</small></label>}
        <fieldset className="paypal-choice">
          <legend>Merchants</legend>
          {merchants.map(m => <label key={m.id} className={picked.includes(m.id) ? "is-active" : ""}>
            <input disabled={busy || createUncertain} type="checkbox" checked={picked.includes(m.id)} onChange={e => { setPicked(e.target.checked ? [...picked, m.id] : picked.filter(id => id !== m.id)); touch(); }} />{m.name}
          </label>)}
          {!merchants.length && <p className="paypal-note">Catalog loading.</p>}
        </fieldset>
        {kinds.length > 0 && <fieldset className="paypal-choice paypal-category-chips">
          <legend>Categories (optional)</legend>
          {kinds.map(k => <label key={k} className={categories.includes(k) ? "is-active" : ""}>
            <input disabled={busy || createUncertain} type="checkbox" checked={categories.includes(k)} onChange={e => { setCategories(e.target.checked ? [...categories, k] : categories.filter(c => c !== k)); touch(); }} />{kindLabel(k)}
          </label>)}
        </fieldset>}
        <label>Agent (optional)<input disabled={busy || createUncertain} value={agent} maxLength={40} placeholder="Any agent" onChange={e => { setAgent(e.target.value); touch(); }} /></label>
        <label>Expires<input disabled={busy || createUncertain} type="datetime-local" required value={expiry} onChange={e => { setExpiry(e.target.value); touch(); }} /></label>
        <label>Cooldown (seconds)<input disabled={busy || createUncertain} inputMode="numeric" value={cooldown} required onChange={e => { setCooldown(e.target.value); touch(); }} /></label>
        <label>Max purchases per day<input disabled={busy || createUncertain} inputMode="numeric" value={maxPerDay} required onChange={e => { setMaxPerDay(e.target.value); touch(); }} /></label>
        <fieldset className="paypal-choice">
          <legend>Payment method</legend>
          <label className={source === "paypal" ? "is-active" : ""}><input disabled={busy || createUncertain} type="radio" name="allowance-source" checked={source === "paypal"} onChange={() => { setSource("paypal"); touch(); }} />PayPal sandbox</label>
          <label className={source === "card" ? "is-active" : ""}><input disabled={busy || createUncertain} type="radio" name="allowance-source" checked={source === "card"} onChange={() => { setSource("card"); touch(); }} />Sandbox card</label>
        </fieldset>
        {source === "card" && <>
          <label>Card number<input disabled={busy || createUncertain} inputMode="numeric" autoComplete="off" value={card.number} onChange={e => { setCard({ ...card, number: e.target.value }); touch(); }} /></label>
          <label>Card expiry (YYYY-MM)<input disabled={busy || createUncertain} autoComplete="off" placeholder="2030-01" value={card.expiry} onChange={e => { setCard({ ...card, expiry: e.target.value }); touch(); }} /></label>
          <label>Name on card<input disabled={busy || createUncertain} autoComplete="off" value={card.name} onChange={e => { setCard({ ...card, name: e.target.value }); touch(); }} /></label>
          <p className="paypal-note">Card details go to PayPal once and are not kept by ChainPay.</p>
        </>}
        <p className="paypal-note"><ShieldCheck size={14} style={{ verticalAlign: "text-bottom", marginRight: 4 }} aria-hidden="true" />The agent sees these rules and nothing about how you pay. It cannot raise a cap, resume a paused allowance or approve its own purchase.</p>
        {createUncertain && <p className="paypal-notice" role="status">The allowance creation outcome is unknown. These limits are locked; retry the original request before creating another allowance.</p>}
        <button className="paypal-btn-primary" disabled={busy || (!createIntent.current && !formOk)}>{createUncertain ? "Retry original allowance" : "Create allowance"}</button>
      </form>

      <PermissionCard name={name} totalCents={totalCents} perCents={perCents} mode={mode} askCents={askCents} categories={categories.map(kindLabel)} merchants={picked.map(merchantName)} agent={agent} expiresAt={expiresAt} cooldown={cooldown} maxPerDay={maxPerDay} />
    </div>}


  </section>;
}

// The blue slab. Every field change re-renders it, so the buyer reads exactly what they are about to sign off.
function PermissionCard({ name, totalCents, perCents, mode, askCents, categories, merchants, agent, expiresAt, cooldown, maxPerDay }: { name: string; totalCents: string | null; perCents: string | null; mode: AllowanceMode; askCents: string | null; categories: string[]; merchants: string[]; agent: string; expiresAt: number; cooldown: string; maxPerDay: string }) {
  const per = shownMoney(dollars(perCents));
  const total = shownMoney(dollars(totalCents));
  const who = agent.trim() ? `Agent ${agent.trim()}` : "Any agent";
  const where = merchants.length ? listWords(merchants) : "no merchant yet";
  const ask = shownMoney(dollars(askCents));
  const until = Number.isFinite(expiresAt) ? new Date(expiresAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "an expiry you set";
  const limits = `up to ${total} in total, at most ${maxPerDay || "?"} ${maxPerDay === "1" ? "time" : "times"} a day, until ${until}`;
  const sentence = mode === "agent_pays"
    ? `${who} may pay up to ${per} per purchase at ${where}, ${limits}.`
    : mode === "ask_above"
    ? `${who} may pay up to ${ask} per purchase at ${where} on its own, and asks you for anything above that, up to ${per}. ${limits[0].toUpperCase()}${limits.slice(1)}.`
    : `${who} may ask to buy up to ${per} per purchase at ${where}, up to ${total} in total, at most ${maxPerDay || "?"} ${maxPerDay === "1" ? "time" : "times"} a day, until ${until}. You approve each one.`;
  return <aside className="paypal-permission-card" aria-live="polite" aria-label="Allowance preview">
    <div className="paypal-permission-card-head"><BrandLogo /><span className="paypal-permission-card-kind">Allowance</span></div>
    <div className="paypal-permission-card-amount"><small>{name.trim() || "Untitled allowance"} · per purchase</small><strong>{per}<span>USD</span></strong></div>
    <p className="paypal-permission-card-sentence">{sentence}</p>
    <dl className="paypal-permission-card-rows">
      <div><dt>Total</dt><dd>{total}</dd></div>
      <div><dt>Mode</dt><dd>{mode === "ask_above" ? `Ask above ${ask}` : modeWord[mode]}</dd></div>
      <div><dt>Merchants</dt><dd>{merchants.join(", ") || "None"}</dd></div>
      {categories.length > 0 && <div><dt>Categories</dt><dd>{categories.join(", ")}</dd></div>}
      <div><dt>Agent</dt><dd>{agent.trim() || "Any"}</dd></div>
      <div><dt>Per day</dt><dd>{maxPerDay || "?"}</dd></div>
      <div><dt>Cooldown</dt><dd>{cooldown || "0"}s</dd></div>
    </dl>
    <div className="paypal-permission-card-sig">Rules <code>allowance-rules-v1</code> · PayPal sandbox · no real money</div>
  </aside>;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function localDateTime(ms: number): string {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
