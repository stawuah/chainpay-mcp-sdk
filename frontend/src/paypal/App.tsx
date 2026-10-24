import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { BrandLogo } from "../brand/Brand";
import { checkoutUrl, client, exportReceipt, money, type Principal, type Proposal, type Receipt } from "./client";

const Analytics = lazy(() => import("./Analytics"));
const SESSION_KEY = "chainpay.paypal.session.v1";
const samples = [
  { name: "North supplier terms · sample", text: "North Workshop supplies recycled paper notebooks. Its minimum order is 200 units. Delivery takes three working days after artwork approval. Each notebook contains 80 sheets. Packaging uses recycled cardboard. Customers may cancel before artwork approval. Returns for manufacturing defects are accepted within 14 days of delivery." },
  { name: "South supplier terms · sample", text: "South Workshop supplies cotton tote bags. Its minimum order is 100 units. Delivery takes seven working days after the proof is approved. Each bag measures 38 by 42 centimetres. Customers receive a digital proof before manufacturing. A deposit is required before production. Manufacturing defects must be reported within 10 days of receipt." },
  { name: "Unreadable document · intentional sample", text: "� � � ???" },
];

export default function App({ origin }: { origin: string }) {
  const publicToken = location.pathname.startsWith("/paypal/receipt/") ? location.pathname.split("/").at(-1) : undefined;
  const [token, setToken] = useState(() => publicToken ? "" : sessionStorage.getItem(SESSION_KEY) ?? "");
  const [access, setAccess] = useState("");
  const [principal, setPrincipal] = useState<Principal>();
  const [tasks, setTasks] = useState<Receipt[]>([]);
  const [selected, setSelected] = useState<Receipt>();
  const [documents, setDocuments] = useState([{ name: "Document 1", text: "" }]);
  const [proposal, setProposal] = useState<Proposal>();
  const [explanation, setExplanation] = useState("");
  const [reporting, setReporting] = useState<{ note: string; truncated: boolean; transactions: { transaction_id: string; status: string; event_code: string; amount: {value: string; currency_code: string} }[] }>();
  const [dashboard, setDashboard] = useState(false);
  const [share, setShare] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const api = useMemo(() => client(origin, token), [origin, token]);
  const activeId = useRef<string | undefined>(undefined);
  const sessionGeneration = useRef(0);

  async function perform(action: () => Promise<void>) {
    setError(""); setBusy(true);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unavailable. Keep this task and check its status."); }
    finally { setBusy(false); }
  }
  function select(task: Receipt) {
    setDashboard(false); activeId.current = task.id; setSelected(task); setReporting(undefined); setProposal(undefined); setExplanation(""); setShare("");
    if (!publicToken) history.replaceState(null, "", `/paypal/?task=${encodeURIComponent(task.id)}`);
  }
  async function refresh() {
    const generation = sessionGeneration.current;
    const result = await api<{ tasks: Receipt[] }>("/tasks");
    if (generation !== sessionGeneration.current) return;
    setTasks(result.tasks);
    const id = activeId.current ?? new URLSearchParams(location.search).get("task");
    const current = result.tasks.find(t => t.id === id);
    if (current) { activeId.current = current.id; setSelected(current); }
  }
  useEffect(() => {
    let cancelled = false;
    if (publicToken) {
      void api<Receipt>(`/receipts/${encodeURIComponent(publicToken)}`).then(r => { if (!cancelled) setSelected(r); }).catch(e => { if (!cancelled) setError(String(e.message)); });
    } else if (token) {
      void api<Principal>("/session").then(async p => { if (!cancelled) { setPrincipal(p); await refresh(); } }).catch(e => { if (!cancelled) setError(String(e.message)); });
    }
    return () => { cancelled = true; };
  }, [api, publicToken]);
  useEffect(() => {
    if (!principal || publicToken) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [api, principal, publicToken]);
  const editable = principal?.role === "buyer" || principal?.role === "agent";
  const taskPath = selected ? `/tasks/${encodeURIComponent(selected.id)}` : "";

  return <div className="paypal-shell cp-app">
    <header className="paypal-header"><a href="/paypal/" aria-label="ChainPay PayPal workspace"><BrandLogo /></a><span className="paypal-badge">PayPal sandbox · no real money</span>{principal && <Button label="Sign out" variant="secondary" onClick={() => void perform(async () => { try { await api("/session", "DELETE"); } finally { ++sessionGeneration.current; sessionStorage.removeItem(SESSION_KEY); setToken(""); setPrincipal(undefined); setSelected(undefined); setTasks([]); activeId.current = undefined; } })} />}</header>
    <main>
      <div className={`paypal-heading ${selected ? "has-receipt" : ""}`}><p className="paypal-eyebrow">RECEIPTS FOR AGENT WORK</p><h1>{selected ? "Your work, accounted for." : <>Know what arrived.<br />Know what it cost.</>}</h1><p>Purchase evidence-linked document summaries. Track delivered work and approved refunds in one receipt.</p></div>
      {error && <p className="paypal-error" role="alert">{error}</p>}
      {!principal && !publicToken && <section className="paypal-card paypal-login"><h2>Open your workspace</h2><p>Use your dedicated buyer or merchant access code. Signing in does not approve a payment.</p><form onSubmit={e => { e.preventDefault(); void perform(async () => { const entered = access.trim(); const p = await client(origin, entered)<Principal>("/session"); ++sessionGeneration.current; sessionStorage.setItem(SESSION_KEY, entered); setToken(entered); setPrincipal(p); setAccess(""); }); }}><label htmlFor="paypal-access">Workspace access code</label><input id="paypal-access" type="password" autoComplete="off" required value={access} onChange={e => setAccess(e.target.value)} /><button className="paypal-submit" type="submit" disabled={busy}>Open workspace</button></form><small>The code stays in this tab to return from checkout. Sign out to revoke it.</small></section>}
      {(principal || publicToken) && <div className="paypal-layout">
        {principal && <aside className="paypal-sidebar"><p className="paypal-eyebrow">{principal.role} WORKSPACE</p><h2>Your tasks</h2><Button label="Outcome dashboard" variant="secondary" isDisabled={busy} onClick={() => setDashboard(true)} />{editable && <Button label="New task" variant="secondary" isDisabled={busy} onClick={() => { setDashboard(false); activeId.current = undefined; setSelected(undefined); setProposal(undefined); setShare(""); requestId.current = crypto.randomUUID(); history.replaceState(null,"","/paypal/"); }} />}<nav aria-label="Task receipts">{tasks.length ? tasks.map(task => <button key={task.id} className={task.id === selected?.id ? "selected" : ""} disabled={busy} onClick={() => select(task)}><strong>{task.units.length} document{task.units.length === 1 ? "" : "s"}</strong><span>{money(task.gross)} · {task.captured ? "Captured" : "Awaiting payment"}</span><small>{task.id.slice(0, 8)}</small></button>) : <p>No tasks yet. Your first quote will appear here.</p>}</nav></aside>}
        <div className="paypal-content">
          {dashboard && principal && <Suspense fallback={<p>Loading outcome dashboard…</p>}><Analytics origin={origin} token={token} onSelect={task => { void perform(async () => select(await api<Receipt>(`/tasks/${task.id}`))); }} /></Suspense>}
          {!dashboard && !selected && editable && <section className="paypal-card"><p className="paypal-eyebrow">01 · DEFINE THE WORK</p><h2>What should your agent read?</h2><p>USD 4.00 per document. Get a summary and factual claims linked to exact source excerpts. Text and Markdown, up to 10 documents.</p><div className="paypal-actions"><Button label="Use three sample documents" variant="secondary" isDisabled={busy} onClick={() => { setDocuments(samples); requestId.current = crypto.randomUUID(); }} /><label className="paypal-file">Upload text files<input type="file" multiple accept=".txt,.md,text/plain,text/markdown" onChange={e => void perform(async () => { const files = [...(e.target.files ?? [])]; if (!files.length || files.length > 10 || files.some(f => f.size > 16000)) throw new Error("Choose 1–10 text files of at most 16 KB each."); setDocuments(await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() })))); requestId.current = crypto.randomUUID(); })} /></label></div>{documents.map((document, index) => <div className="paypal-document" key={index}><label htmlFor={`document-name-${index}`}>Document {index + 1} name</label><input id={`document-name-${index}`} value={document.name} maxLength={120} onChange={e => { setDocuments(d => d.map((v,i) => i === index ? { ...v,name:e.target.value } : v)); requestId.current = crypto.randomUUID(); }} /><label htmlFor={`document-text-${index}`}>Source text</label><textarea id={`document-text-${index}`} rows={4} value={document.text} maxLength={16000} onChange={e => { setDocuments(d => d.map((v,i) => i === index ? { ...v,text:e.target.value } : v)); requestId.current = crypto.randomUUID(); }} /></div>)}<Button label="Prepare quote" isDisabled={busy} onClick={() => void perform(async () => { const task = await api<Receipt>("/tasks","POST",{ request_id:requestId.current,documents }); select(task); await refresh(); })} /><p className="paypal-note">Sample inputs include one intentionally unreadable document. Outputs are generated when you run the paid task.</p></section>}
          {!dashboard && !selected && !editable && <section className="paypal-card"><h2>{publicToken ? "Loading shared receipt…" : "Select a task to review"}</h2><p>Payment and delivery remain separate evidence.</p></section>}
          {!dashboard && selected && <section className="paypal-card" aria-label="Task receipt"><div className="paypal-receipt-title"><div><p className="paypal-eyebrow">TASK RECEIPT · USD</p><h2>{selected.units.length} documents, one clear record.</h2></div><span className="paypal-status">{selected.refund_confirmed ? "Refund confirmed" : selected.captured ? "PayPal capture confirmed" : "Awaiting payment"}</span></div>
            <div className="paypal-totals"><div><span>Original quote / charge</span><strong>{money(selected.gross)}</strong></div><div><span>Confirmed refund</span><strong>{money(selected.refund_confirmed ? selected.refund : "0.00")}</strong></div><div><span>Net buyer cost</span><strong>{money(selected.net)}</strong></div></div>
            {!publicToken && <div className="paypal-actions">
              {principal?.role === "buyer" && !selected.captured && !selected.order_state && <Button label={`Approve ${money(selected.gross)} quote & open checkout`} isDisabled={busy} onClick={() => void perform(async () => { const task = await api<Receipt>(`${taskPath}/checkout`,"POST",{digest:selected.quote_digest}); setSelected(task); if (task.approval_url) location.assign(checkoutUrl(task.approval_url)); })} />}
              {principal?.role === "buyer" && selected.approval_url && !selected.captured && <Button label="Continue PayPal approval" variant="secondary" isDisabled={busy} onClick={() => location.assign(checkoutUrl(selected.approval_url!))} />}
              {principal?.role === "buyer" && selected.order_id && !selected.captured && !selected.capture_state && <Button label={`Confirm capture of ${money(selected.gross)}`} isDisabled={busy} onClick={() => void perform(async () => { setSelected(await api<Receipt>(`${taskPath}/capture`,"POST",{digest:selected.quote_digest})); await refresh(); })} />}
              {selected.captured && selected.units.some(u => ["pending","unknown","processing"].includes(u.state)) && <Button label="Run or recover this paid task" isDisabled={busy} onClick={() => void perform(async () => { await api(`${taskPath}/process`,"POST"); await refresh(); })} />}
              <Button label="Check original payment" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => { setSelected(await api<Receipt>(`${taskPath}/reconcile`,"POST")); })} />
            </div>}
            {[selected.order_state, selected.capture_state, selected.refund_state].some(s => s === "unknown" || s === "dispatching") && <p className="paypal-notice">An operation is unresolved. Check this original task; do not create a replacement payment.</p>}
            <div className="paypal-units">{selected.units.map(unit => <article key={unit.index}><div className="paypal-unit-title"><h3>{unit.name ?? `Document ${unit.index + 1}`}</h3><span className={`paypal-unit-state ${unit.state}`}>{unit.state}</span></div>{unit.reason && <p>{unit.reason}</p>}{unit.result && <><p>{unit.result.output.summary}</p>{unit.result.output.facts.map((fact,i) => <div className="paypal-fact" key={i}><strong>{fact.claim}</strong><blockquote>{fact.evidence}</blockquote></div>)}<small>Processed by {unit.result.model}. Review the output against its source.</small></>}<details><summary>Evidence hashes</summary><p>Input: <code>{unit.input_hash}</code></p><p>Output: <code>{unit.output_hash ?? "No delivered output"}</code></p></details></article>)}</div>
            <p className="paypal-note">Payment: PayPal sandbox API observation. Delivery: merchant processing record, not buyer acceptance. This is not an on-chain receipt.</p>
            {!publicToken && <div className="paypal-review"><h3>Review the outcome</h3><div className="paypal-actions"><Button label="Ask AI to explain this receipt" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => { const answer = await api<{explanation:string}>(`${taskPath}/explain`,"POST"); setExplanation(answer.explanation); })} /><Button label="Review failed-unit refund" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => setProposal(await api<Proposal>(`${taskPath}/refund-proposal`)))} /></div>{explanation && <aside className="paypal-explanation"><strong>AI explanation · not payment authority</strong><p>{explanation}</p></aside>}{proposal && <div className="paypal-refund"><h3>Proposed refund: {money(proposal.amount)}</h3><p>{proposal.reason}</p>{principal?.role === "merchant" ? <Button label={`Approve ${money(proposal.amount)} sandbox refund`} isDisabled={busy || Boolean(selected.refund_state)} onClick={() => void perform(async () => { setSelected(await api<Receipt>(`${taskPath}/refund`,"POST",{digest:proposal.digest})); setProposal(undefined); await refresh(); })} /> : <p>A merchant must review and approve this refund.</p>}</div>}</div>}
            {!publicToken && <div className="paypal-review"><Button label="Check PayPal transaction report" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => setReporting(await api(`${taskPath}/reporting`, "POST")))} />{reporting && <div><p>{reporting.note}</p>{reporting.truncated && <p>Result window reached the five-page limit; this report is incomplete.</p>}{reporting.transactions.length ? <ul>{reporting.transactions.map(row => <li key={row.transaction_id}><code>{row.transaction_id}</code> · {row.status} · {row.event_code} · {row.amount?.currency_code} {row.amount?.value}</li>)}</ul> : <p>No matching transactions in this reporting window yet.</p>}</div>}</div>}
            <details className="paypal-identifiers"><summary>Provider references</summary><dl>{[["Task",selected.id],["Order",selected.order_id],["Capture",selected.capture_id],["Refund",selected.refund_id]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "Not established"}</dd></div>)}</dl></details>
            <div className="paypal-actions"><Button label="Export CSV" variant="secondary" onClick={() => { const url = URL.createObjectURL(new Blob([exportReceipt(selected)],{type:"text/csv;charset=utf-8"})); const link=document.createElement("a");link.href=url;link.download=`chainpay-${selected.id}.csv`;link.click();URL.revokeObjectURL(url); }} />{principal?.role === "buyer" && <><Button label="Share redacted receipt" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => { const result=await api<{token:string}>(`${taskPath}/share`,"POST");setShare(`${location.origin}/paypal/receipt/${result.token}`); })} /><Button label="Revoke share link" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => { await api(`${taskPath}/share`,"DELETE");setShare(""); })} /></>}</div>{share && <p className="paypal-share"><a href={share} target="_blank" rel="noreferrer">Open redacted receipt</a><input aria-label="Public receipt URL" readOnly value={share} onFocus={e => e.target.select()} /></p>}
          </section>}
        </div>
      </div>}
    </main><footer className="paypal-footer">ChainPay · Sandbox payments. Real work, inspectable evidence.</footer>
  </div>;
}
