import { useEffect, useRef, useState } from "react";
import { ShoppingBag, Store } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { modeLabel } from "./Allowances";
import { dollars, shownMoney, type Allowance, type client, type Merchant, type PolicyCheck, type Principal, type Quote, type Receipt } from "./client";

// Plain words for the policy reason codes the server returns. The code itself is shown too.
export const reasonWords: Record<string, string> = {
  allowance_not_active: "This allowance is not Active",
  allowance_expired: "This allowance has expired",
  agent_not_allowed: "This agent is not named on the allowance",
  merchant_not_allowed: "This merchant is not on the allowance",
  per_purchase_cap: "Over the per-purchase cap",
  total_cap: "Over the total cap",
  max_per_day: "Daily purchase count reached",
  cooldown: "Too soon after the last purchase",
  vault_not_ready: "The buyer has not finished setting up payment",
  denied: "Denied by the buyer",
};

export default function Marketplace({ api, principal, onPurchased }: { api: ReturnType<typeof client>; principal: Principal; onPurchased: (r: Receipt) => void }) {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [allowances, setAllowances] = useState<Allowance[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [allowanceId, setAllowanceId] = useState("");
  const [quote, setQuote] = useState<Quote>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const requestId = useRef(crypto.randomUUID());
  const quoteCount = useRef(0);

  useEffect(() => {
    live.current = true;
    Promise.all([api<{ merchants: Merchant[] }>("/catalog"), api<{ allowances: Allowance[] }>("/allowances")]).then(([c, a]) => {
      if (!live.current) return;
      setMerchants(c.merchants ?? []);
      const usable = (a.allowances ?? []).filter(x => x.status === "Active");
      setAllowances(usable);
      setAllowanceId(old => old || usable[0]?.id || "");
    }).catch(e => { if (live.current) setError(e.message); });
    return () => { live.current = false; };
  }, [api]);

  const merchant = merchants.find(m => m.id === merchantId);
  const items = Object.entries(basket).filter(([, qty]) => qty > 0).map(([id, qty]) => ({ id, qty }));
  const basketKey = JSON.stringify([merchantId, items, allowanceId]);

  // Re-quote whenever the basket or the allowance changes. Only the latest answer is kept.
  useEffect(() => {
    setQuote(undefined);
    if (!merchantId || !items.length) return;
    const n = ++quoteCount.current;
    api<Quote>("/purchases/quote", "POST", { merchant: merchantId, items, allowance_id: allowanceId || undefined })
      .then(q => { if (live.current && n === quoteCount.current) setQuote(q); })
      .catch(e => { if (live.current && n === quoteCount.current) setError(e.message); });
  }, [api, basketKey]);

  function setQty(id: string, qty: number, max: number) {
    setBasket({ ...basket, [id]: Math.max(0, Math.min(max, qty)) });
    requestId.current = crypto.randomUUID();
    setError("");
  }
  function pickMerchant(id: string) {
    setMerchantId(id); setBasket({}); setQuote(undefined); setError("");
    requestId.current = crypto.randomUUID();
  }

  const allowed = quote?.policy?.allowed === true;
  const reason = quote?.policy?.reason_code;

  return <section className="paypal-card paypal-market" aria-label="Marketplace">
    <div className="paypal-card-header">
      <div>
        <span className="paypal-eyebrow"><Store size={14} aria-hidden="true" />Sandbox catalog</span>
        <h2>Marketplace</h2>
      </div>
    </div>
    {error && <p role="alert" className="paypal-error">{error}</p>}

    <div className="paypal-merchant-grid" role="group" aria-label="Merchants">
      {merchants.map(m => <button key={m.id} type="button" className={`paypal-merchant-tile${m.id === merchantId ? " is-active" : ""}`} disabled={busy} onClick={() => pickMerchant(m.id)}>
        <strong>{m.name}</strong>
        <small>{m.kind} · {m.items.length} items</small>
      </button>)}
      {!merchants.length && <p className="paypal-note">Catalog loading.</p>}
    </div>

    {merchant && <div className="paypal-market-body">
      <div className="paypal-item-list">
        {merchant.items.map(item => {
          const max = maxPerOrder(item.availability);
          const qty = basket[item.id] ?? 0;
          return <div key={item.id} className="paypal-item-row">
            <div>
              <strong>{item.name}</strong>
              <span>{shownMoney(dollars(item.price_cents))}{availabilityWords(item.availability) ? ` · ${availabilityWords(item.availability)}` : ""}</span>
            </div>
            <div className="paypal-stepper" role="group" aria-label={`${item.name} quantity`}>
              <button type="button" aria-label={`Fewer ${item.name}`} disabled={busy || qty <= 0} onClick={() => setQty(item.id, qty - 1, max)}>−</button>
              <output aria-label={`${item.name} quantity`}>{qty}</output>
              <button type="button" aria-label={`More ${item.name}`} disabled={busy || qty >= max} onClick={() => setQty(item.id, qty + 1, max)}>+</button>
            </div>
          </div>;
        })}
      </div>

      <div className="paypal-checkout-pane">
        <label htmlFor="market-allowance">Pay with allowance</label>
        <select id="market-allowance" value={allowanceId} disabled={busy} onChange={e => { setAllowanceId(e.target.value); requestId.current = crypto.randomUUID(); }}>
          {!allowances.length && <option value="">No Active allowance</option>}
          {allowances.map(a => <option key={a.id} value={a.id}>{a.name} · {shownMoney(dollars(a.remaining_cents))} left · {modeLabel(a)}</option>)}
        </select>

        {!items.length && <p className="paypal-note">Add something to see the quote and the rule check.</p>}
        {quote && <div className="paypal-quote">
          <ul>{quote.lines.map(l => <li key={l.id}><span>{l.qty} × {l.name}</span><span>{shownMoney(dollars(l.line_cents))}</span></li>)}</ul>
          <div className="paypal-quote-total"><span>Total</span><strong>{shownMoney(quote.amount)}</strong></div>
          {quote.policy && <p className={`paypal-verdict ${allowed ? "is-ok" : "is-refused"}`} role="status">
            {allowed ? "Allowed by the allowance rules." : `Refused: ${reason ? reasonWords[reason] ?? reason : "the rules did not pass"}.`}
            {reason && <code>{reason}</code>}
          </p>}
          {!quote.policy && <p className="paypal-note">Pick an allowance to check the rules before buying.</p>}
          {quote.policy?.checks && quote.policy.checks.length > 0 && <details>
            <summary>Rule checks</summary>
            <dl className="paypal-checks">{quote.policy.checks.map(c => <div key={c.rule}><dt>{c.rule}</dt><dd>{checkWords(c)}</dd></div>)}</dl>
          </details>}
        </div>}

        <div className="paypal-actions">
          <Button label={quote ? `Buy now · ${shownMoney(quote.amount)}` : "Buy now"} isDisabled={busy || !quote || !allowanceId || !allowed} onClick={() => void (async () => {
            setBusy(true); setError("");
            try {
              const mode = allowances.find(a => a.id === allowanceId)?.mode;
              const receipt = await api<Receipt>("/purchases", "POST", { request_id: requestId.current, allowance_id: allowanceId, mode, merchant: merchantId, items });
              requestId.current = crypto.randomUUID();
              if (live.current) { setBasket({}); onPurchased(receipt); }
            } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Unavailable; keep the original operation"); }
            finally { if (live.current) setBusy(false); }
          })()} />
        </div>
        <p className="paypal-note">{principal.role === "agent" ? "Ask-me-first allowances send the buyer a one-tap approval instead of paying." : "Buying as the buyer runs the same rule check your agent gets."}</p>
      </div>
    </div>}
  </section>;
}

export function maxPerOrder(availability: string): number {
  const m = /^max_per_order:(\d+)$/.exec(availability);
  return m ? Number(m[1]) : 10;
}
export function availabilityWords(availability: string): string {
  if (availability === "weekdays") return "Weekdays only";
  const m = /^max_per_order:(\d+)$/.exec(availability);
  return m ? `Up to ${m[1]} per order` : "";
}
export function checkWords(c: PolicyCheck): string {
  if (c.limit_cents !== undefined) return `${shownMoney(dollars(c.observed_cents ?? 0))} of ${shownMoney(dollars(c.limit_cents))} · ${c.allowed ? "within" : "over"}`;
  // The expiry check reports a unix timestamp; show it as a date.
  if (c.rule === "expiry" && c.observed && /^\d+$/.test(c.observed)) return `${new Date(Number(c.observed) * 1000).toLocaleDateString()} · ${c.allowed ? "allowed" : "not allowed"}`;
  if (c.observed) return `${c.observed} · ${c.allowed ? "allowed" : "not allowed"}`;
  return c.allowed ? "Allowed" : "Not allowed";
}
