import { useEffect, useRef, useState } from "react";
import { FileSearch, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import type { client } from "./client";

type Money = { value: string; currency_code: string } | null;
type Row = { observation_ambiguity?: boolean; history_truncated?: boolean; observations?: { hash: string; provider_status: string; amount: Money; fee: Money; net: Money }[]; id: string; transaction_id: string; event_code: string; provider_status: string; references: string[]; amount: Money; fee: Money; net: Money; checked_at: number; changed: boolean; observation_count: number; status: string; matches: string[] };
type Inbox = { cursor: { coverage_start: number; window_start: number; window_end: number; next_page: number; completed: boolean; watermark: number | null; checked_at: number | null } | null; rows: Row[]; next: string | null; note: string };
const amount = (value: Money) => value ? `${value.value} ${value.currency_code}` : "Unknown";
const date = (value: number | null) => value == null ? "Not checked" : new Date(value * 1000).toLocaleString();

export default function ReportingInbox({ api }: { api: ReturnType<typeof client> }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Inbox>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [explanations, setExplanations] = useState<Record<string, { explanation: string; citations: string[] }>>({});
  const generation = useRef(0);
  const activeRequest = useRef(false);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [api]);

  async function run(action: () => Promise<void>) {
    if (activeRequest.current) return;
    activeRequest.current = true;
    setBusy(true); setError("");
    const current = generation.current;
    try { await action(); } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "Reporting unavailable"); }
    finally { activeRequest.current = false; if (generation.current === current) setBusy(false); }
  }
  async function load(sync = false, after = "") {
    const current = generation.current;
    const result = await api<Inbox>(sync ? "/reporting/sync" : `/reporting/inbox${after ? `?after=${encodeURIComponent(after)}` : ""}`, sync ? "POST" : "GET");
    if (generation.current === current) { setData(result); setExplanations({}); }
  }

  return <section className="paypal-card" aria-label="Merchant reconciliation inbox">
    <div className="paypal-card-header" style={{ marginBottom: open ? 12 : 0 }}>
      <div>
        <span className="paypal-eyebrow"><FileSearch size={14} aria-hidden="true" />Provider ledger</span>
        <p className="paypal-note" style={{ margin: 0 }}>Inspect PayPal Transaction Search observations alongside local task and refund records.</p>
      </div>
      <button className="paypal-submit" aria-expanded={open} disabled={busy} style={{ margin: 0 }} onClick={() => { setOpen(!open); if (!open) void run(() => load()); }}>Merchant reconciliation inbox</button>
    </div>
    {open && <>
      <h2>Merchant proceeds & reconciliation</h2>
      <p>Provider observations, separate from buyer receipt cost. No payment or refund is authorized here.</p>
      {error && <p role="alert" className="paypal-error">{error}</p>}
      <div className="paypal-actions">
        <button className="paypal-btn-primary" disabled={busy} onClick={() => void run(() => load(true))}><RefreshCw size={14} aria-hidden="true" />{data?.cursor && !data.cursor.completed ? "Resume sync" : "Sync transactions"}</button>
        <button disabled={busy} onClick={() => void run(() => load())}>Refresh saved inbox</button>
      </div>
      {busy && <p className="paypal-note" role="status">Checking reporting evidence…</p>}
      <p className="paypal-note">Each sync reads at most two pages. Reporting may lag three hours. No automatic polling.</p>
      {data && <>
        <p className="paypal-service-terms" style={{ fontWeight: 500 }}>{data.note}</p>
        {data.cursor ? <div className="paypal-identifiers" style={{ marginBottom: 14 }}>
          <dl>
            <div><dt>Coverage begins</dt><dd>{date(data.cursor.coverage_start)}</dd></div>
            <div><dt>Current window</dt><dd>{date(data.cursor.window_start)} – {date(data.cursor.window_end)}</dd></div>
            <div><dt>Import progress</dt><dd>{data.cursor.completed ? "Window imported; provider coverage remains incomplete" : `Incomplete; next page ${data.cursor.next_page}`}</dd></div>
            <div><dt>Completed through</dt><dd>{date(data.cursor.watermark)}</dd></div>
            <div><dt>Last checked</dt><dd>{date(data.cursor.checked_at)}</dd></div>
          </dl>
        </div> : <p className="paypal-note">No sync yet. The first window covers the previous day.</p>}
        <p className="paypal-note">Showing one saved inbox page (up to 100 rows). No combined totals: currencies, uncertain observations and balance effects remain separate.</p>
        {data.rows.length === 0 && <p className="paypal-note">No rows on this page. Absence does not establish payment failure.</p>}
        <div className="paypal-units">
          {data.rows.map(row => <article className="paypal-card" key={row.id} style={{ background: "var(--pp-surface-subtle)" }}>
            <div className="paypal-unit-title">
              <h3>{row.status} · {row.transaction_id}</h3>
              <span className={`paypal-unit-state ${row.status === "matched" ? "delivered" : row.status === "ambiguous" ? "failed" : "pending"}`}>{row.status}</span>
            </div>
            <p>{row.event_code} · Provider status {row.provider_status || "unknown"}{row.changed && " · External observation changed; review required"}</p>
            <div className="paypal-cost" style={{ gridTemplateColumns: "1fr", padding: 14, background: "var(--pp-surface)" }}>
              <dl>
                <div><dt>Gross observation</dt><dd>{amount(row.amount)}</dd></div>
                <div><dt>Fee</dt><dd>{amount(row.fee)}</dd></div>
                <div><dt>Merchant net proceeds</dt><dd>{amount(row.net)} (provider-reported only)</dd></div>
              </dl>
            </div>
            {row.observation_ambiguity && <details>
              <summary><TriangleAlert size={14} style={{ verticalAlign: "text-bottom", marginRight: 6 }} aria-hidden="true" />Multiple observations — late update or ambiguous row identity; review required</summary>
              {row.observations?.map(observation => <p key={observation.hash} style={{ overflowWrap: "anywhere" }}>Observation {observation.hash}: status {observation.provider_status || "unknown"} · gross {amount(observation.amount)} · fee {amount(observation.fee)} · net {amount(observation.net)}</p>)}
              {row.history_truncated && <p>History display limited to 100 observations; complete raw evidence remains saved.</p>}
            </details>}
            <p><strong>Exact matches:</strong> {row.matches.join(", ") || "None — merchant review required"}</p>
            <p style={{ overflowWrap: "anywhere" }}><strong>References:</strong> <code>{row.references.join(", ")}</code></p>
            <p className="paypal-note">Checked {date(row.checked_at)} · {row.observation_count} distinct observations</p>
            <small style={{ overflowWrap: "anywhere", display: "block", marginBottom: 10 }}>Evidence row: <code>{row.id}</code></small>
            <div className="paypal-actions">
              <button disabled={busy} onClick={() => void run(async () => {
                const current = generation.current;
                const result = await api<{ explanation: string; citations: string[] }>(`/reporting/rows/${encodeURIComponent(row.id)}/explain`, "POST");
                if (generation.current === current) setExplanations(old => ({ ...old, [row.id]: result }));
              })}><Sparkles size={14} aria-hidden="true" />Explain row</button>
            </div>
            {explanations[row.id] && <aside className="paypal-explanation">
              <p style={{ margin: "0 0 4px", fontWeight: 600 }}>AI explanation — not payment authority</p>
              <p>{explanations[row.id].explanation}</p>
              <small style={{ overflowWrap: "anywhere" }}>Citations: {explanations[row.id].citations.join(", ")}</small>
            </aside>}
          </article>)}
        </div>
        {data.next && <div className="paypal-actions"><button disabled={busy} onClick={() => void run(() => load(false, data.next!))}>Next inbox page</button></div>}
      </>}
    </>}
  </section>;
}
