import { useEffect, useRef, useState } from "react";
import { Inbox, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { BrandLogo } from "../brand/Brand";
import { centsFromDollars, checkoutUrl, dollars, jsonInt, shownMoney, type Allowance, type client, type Merchant, type Principal, type Receipt } from "./client";

const modeWord = { agent_pays: "Agent pays", ask_first: "Ask me first" } as const;

export default function Allowances({ api, principal, onReceipt }: { api: ReturnType<typeof client>; principal: Principal; onReceipt: (r: Receipt) => void }) {
  const buyer = principal.role === "buyer";
  const [allowances, setAllowances] = useState<Allowance[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [approvals, setApprovals] = useState<Receipt[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const requestId = useRef(crypto.randomUUID());

  // Builder fields. Dollars stay text until they become a cents string.
  const [name, setName] = useState("Weekly groceries");
  const [total, setTotal] = useState("20.00");
  const [perPurchase, setPerPurchase] = useState("8.00");
  const [mode, setMode] = useState<Allowance["mode"]>("agent_pays");
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
  const merchantName = (id: string) => merchants.find(m => m.id === id)?.name ?? id;
  const expiresAt = expiry ? Math.floor(new Date(expiry).getTime() / 1000) : NaN;
  const formOk = name.trim() && totalCents && perCents && BigInt(perCents) <= BigInt(totalCents) && picked.length > 0 && Number.isFinite(expiresAt) && expiresAt > Date.now() / 1000 && /^\d+$/.test(cooldown) && /^\d+$/.test(maxPerDay) && BigInt(maxPerDay) > 0n && (source === "paypal" || (card.number.replace(/\s/g, "").length >= 12 && /^\d{4}-\d{2}$/.test(card.expiry) && card.name.trim()));

  return <section className="paypal-card paypal-allowances" aria-label="Agent allowances">
    <div className="paypal-card-header">
      <div>
        <span className="paypal-eyebrow"><Wallet size={14} aria-hidden="true" />Agent spending</span>
        <h2>Allowances</h2>
      </div>
      <div className="paypal-actions" style={{ margin: 0 }}>
        <Button label="Refresh" variant="secondary" isDisabled={busy} onClick={() => void act(async () => {})} />
      </div>
    </div>
    {error && <p role="alert" className="paypal-error">{error}</p>}

    {buyer && approvals.length > 0 && <div className="paypal-inbox" aria-label="Purchases waiting for approval">
      <h3><Inbox size={15} aria-hidden="true" />Waiting for you ({approvals.length})</h3>
      {approvals.map(task => <div key={task.id} className="paypal-inbox-row">
        <div>
          <strong>{merchantName(task.purchase?.merchant ?? "")} · {shownMoney(task.gross)}</strong>
          <span>{(task.purchase?.lines ?? []).map(l => `${l.qty} × ${l.name}`).join(", ")}</span>
          <small>Allowance {allowances.find(a => a.id === task.purchase?.allowance_id)?.name ?? task.purchase?.allowance_id}</small>
        </div>
        <div className="paypal-actions" style={{ margin: 0 }}>
          <Button label={`Approve ${shownMoney(task.gross)}`} isDisabled={busy} onClick={() => void act(async () => {
            const receipt = await api<Receipt>(`/purchases/${task.id}/approve`, "POST", { digest: task.quote_digest });
            if (live.current) onReceipt(receipt);
          })} />
          <Button label="Deny" variant="secondary" isDisabled={busy} onClick={() => void act(async () => {
            await api(`/purchases/${task.id}/deny`, "POST", { reason: "Denied by buyer" });
          })} />
        </div>
      </div>)}
    </div>}

    {buyer && <div className="paypal-allowance-builder">
      <form className="paypal-form-grid" aria-label="New allowance" onSubmit={e => {
        e.preventDefault();
        if (!formOk || !totalCents || !perCents) return;
        void act(async () => {
          const body = {
            request_id: requestId.current, name: name.trim(), total_cap_cents: jsonInt(totalCents), per_purchase_cap_cents: jsonInt(perCents),
            expires_at: expiresAt, cooldown_seconds: Number(cooldown), max_per_day: Number(maxPerDay), merchants: picked, mode,
            agent: agent.trim() || undefined, vault_source: source, card: source === "card" ? { number: card.number.replace(/\s/g, ""), expiry: card.expiry, name: card.name.trim() } : undefined,
          };
          await api("/allowances", "POST", body);
          requestId.current = crypto.randomUUID();
          setCard({ number: "", expiry: "", name: "" });
        });
      }}>
        <label>Name<input value={name} required maxLength={80} onChange={e => { setName(e.target.value); touch(); }} /></label>
        <label>Total cap (USD)<input inputMode="decimal" value={total} required onChange={e => { setTotal(e.target.value); touch(); }} aria-invalid={!totalCents} /></label>
        <label>Per purchase cap (USD)<input inputMode="decimal" value={perPurchase} required onChange={e => { setPerPurchase(e.target.value); touch(); }} aria-invalid={!perCents || (totalCents ? BigInt(perCents) > BigInt(totalCents) : false)} /></label>
        <fieldset className="paypal-choice">
          <legend>Mode</legend>
          {(["agent_pays", "ask_first"] as const).map(m => <label key={m} className={mode === m ? "is-active" : ""}>
            <input type="radio" name="allowance-mode" value={m} checked={mode === m} onChange={() => { setMode(m); touch(); }} />{modeWord[m]}
          </label>)}
        </fieldset>
        <fieldset className="paypal-choice">
          <legend>Merchants</legend>
          {merchants.map(m => <label key={m.id} className={picked.includes(m.id) ? "is-active" : ""}>
            <input type="checkbox" checked={picked.includes(m.id)} onChange={e => { setPicked(e.target.checked ? [...picked, m.id] : picked.filter(id => id !== m.id)); touch(); }} />{m.name}
          </label>)}
          {!merchants.length && <p className="paypal-note">Catalog loading.</p>}
        </fieldset>
        <label>Agent (optional)<input value={agent} maxLength={40} placeholder="Any agent" onChange={e => { setAgent(e.target.value); touch(); }} /></label>
        <label>Expires<input type="datetime-local" required value={expiry} onChange={e => { setExpiry(e.target.value); touch(); }} /></label>
        <label>Cooldown (seconds)<input inputMode="numeric" value={cooldown} required onChange={e => { setCooldown(e.target.value); touch(); }} /></label>
        <label>Max purchases per day<input inputMode="numeric" value={maxPerDay} required onChange={e => { setMaxPerDay(e.target.value); touch(); }} /></label>
        <fieldset className="paypal-choice">
          <legend>Payment method</legend>
          <label className={source === "paypal" ? "is-active" : ""}><input type="radio" name="allowance-source" checked={source === "paypal"} onChange={() => { setSource("paypal"); touch(); }} />PayPal sandbox</label>
          <label className={source === "card" ? "is-active" : ""}><input type="radio" name="allowance-source" checked={source === "card"} onChange={() => { setSource("card"); touch(); }} />Sandbox card</label>
        </fieldset>
        {source === "card" && <>
          <label>Card number<input inputMode="numeric" autoComplete="off" value={card.number} onChange={e => { setCard({ ...card, number: e.target.value }); touch(); }} /></label>
          <label>Card expiry (YYYY-MM)<input autoComplete="off" placeholder="2030-01" value={card.expiry} onChange={e => { setCard({ ...card, expiry: e.target.value }); touch(); }} /></label>
          <label>Name on card<input autoComplete="off" value={card.name} onChange={e => { setCard({ ...card, name: e.target.value }); touch(); }} /></label>
          <p className="paypal-note">Card details go to PayPal once and are not kept by ChainPay.</p>
        </>}
        <p className="paypal-note"><ShieldCheck size={14} style={{ verticalAlign: "text-bottom", marginRight: 4 }} aria-hidden="true" />The agent sees these rules and nothing about how you pay. It cannot raise a cap, resume a paused allowance or approve its own purchase.</p>
        <button className="paypal-btn-primary" disabled={busy || !formOk}>Create allowance</button>
      </form>

      <PermissionCard name={name} totalCents={totalCents} perCents={perCents} mode={mode} merchants={picked.map(merchantName)} agent={agent} expiresAt={expiresAt} cooldown={cooldown} maxPerDay={maxPerDay} />
    </div>}

    {allowances.length === 0 && <p className="paypal-note">{buyer ? "No allowances yet. The card on the right rewrites as you type." : "No Active allowance names this agent yet."}</p>}
    <div className="paypal-allowance-list">
      {allowances.map(a => {
        const spent = BigInt(a.spent_cents), total = BigInt(a.total_cap_cents);
        const pct = total > 0n ? Number(spent * 100n / total) : 0;
        return <article key={a.id} className={`paypal-allowance-row is-${a.status.toLowerCase()}`}>
          <div className="paypal-allowance-row-head">
            <div>
              <h3>{a.name}</h3>
              <p className="paypal-note" style={{ margin: 0 }}>{modeWord[a.mode]} · {a.merchants.map(merchantName).join(", ")} · {a.agent ? `agent ${a.agent}` : "any agent"}</p>
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
  </section>;
}

// The blue slab. Every field change re-renders it, so the buyer reads exactly what they are about to sign off.
function PermissionCard({ name, totalCents, perCents, mode, merchants, agent, expiresAt, cooldown, maxPerDay }: { name: string; totalCents: string | null; perCents: string | null; mode: Allowance["mode"]; merchants: string[]; agent: string; expiresAt: number; cooldown: string; maxPerDay: string }) {
  const per = shownMoney(dollars(perCents));
  const total = shownMoney(dollars(totalCents));
  const who = agent.trim() ? `Agent ${agent.trim()}` : "Any agent";
  const where = merchants.length ? listWords(merchants) : "no merchant yet";
  const until = Number.isFinite(expiresAt) ? new Date(expiresAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "an expiry you set";
  const sentence = mode === "agent_pays"
    ? `${who} may pay up to ${per} per purchase at ${where}, up to ${total} in total, at most ${maxPerDay || "?"} ${maxPerDay === "1" ? "time" : "times"} a day, until ${until}.`
    : `${who} may ask to buy up to ${per} per purchase at ${where}, up to ${total} in total, at most ${maxPerDay || "?"} ${maxPerDay === "1" ? "time" : "times"} a day, until ${until}. You approve each one.`;
  return <aside className="paypal-permission-card" aria-live="polite" aria-label="Allowance preview">
    <div className="paypal-permission-card-head"><BrandLogo /><span className="paypal-permission-card-kind">Allowance</span></div>
    <div className="paypal-permission-card-amount"><small>{name.trim() || "Untitled allowance"} · per purchase</small><strong>{per}<span>USD</span></strong></div>
    <p className="paypal-permission-card-sentence">{sentence}</p>
    <dl className="paypal-permission-card-rows">
      <div><dt>Total</dt><dd>{total}</dd></div>
      <div><dt>Mode</dt><dd>{modeWord[mode]}</dd></div>
      <div><dt>Merchants</dt><dd>{merchants.join(", ") || "None"}</dd></div>
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
