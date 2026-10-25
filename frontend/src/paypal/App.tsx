import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, Clock3, FileText, LayoutGrid, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { BrandLogo } from "../brand/Brand";
import { RobotStill } from "../pet/RobotStill";
import { checkoutUrl, client, exportReceipt, shownMoney, type Principal, type Proposal, type Receipt, type Service } from "./client";

import { Resolution } from "./Resolution";
import Subscriptions from "./Subscriptions";
import ServicePreflight, { type Preflight } from "./ServicePreflight";

const Analytics = lazy(() => import("./Analytics"));
const SESSION_KEY = "chainpay.paypal.session.v1";
const samples = [
  { name: "North supplier terms · sample", text: "North Workshop supplies recycled paper notebooks. Its minimum order is 200 units. Delivery takes three working days after artwork approval. Each notebook contains 80 sheets. Packaging uses recycled cardboard. Customers may cancel before artwork approval. Returns for manufacturing defects are accepted within 14 days of delivery." },
  { name: "South supplier terms · sample", text: "South Workshop supplies cotton tote bags. Its minimum order is 100 units. Delivery takes seven working days after the proof is approved. Each bag measures 38 by 42 centimetres. Customers receive a digital proof before manufacturing. A deposit is required before production. Manufacturing defects must be reported within 10 days of receipt." },
  { name: "West supplier terms · sample", text: "West Workshop supplies recycled packaging. Delivery takes five working days after approval. Orders require at least 100 boxes and damaged boxes can be returned within fourteen days." },
];
type Report = { note: string; truncated: boolean; transactions: { transaction_id: string; status: string; event_code: string; amount: { value: string; currency_code: string } }[] };
const unitLabel: Record<Receipt["units"][number]["state"], string> = {
  pending: "Pending",
  processing: "Processing",
  delivered: "Delivered",
  failed: "Failed",
  unknown: "Unknown",
};

export default function App({ origin }: { origin: string }) {
  const publicToken = location.pathname.startsWith("/paypal/receipt/") ? location.pathname.split("/").at(-1) : undefined;
  const [token, setToken] = useState(() => publicToken ? "" : sessionStorage.getItem(SESSION_KEY) ?? "");
  const [access, setAccess] = useState("");
  const [principal, setPrincipal] = useState<Principal>();
  const [tasks, setTasks] = useState<Receipt[]>([]);
  const [selected, setSelected] = useState<Receipt>();
  const [documents, setDocuments] = useState([{ name: "Document 1", text: "" }]);
  const [services, setServices] = useState<Service[]>([]);
  const initialService = useRef(new URLSearchParams(location.search).get("service"));
  const [serviceId, setServiceId] = useState("document-extract-v1");
  const [requirements, setRequirements] = useState("");
  const service = services.find(s => s.id === serviceId);
  const requirementsBytes = new TextEncoder().encode(requirements).length;
  const countValid = documents.length >= (service?.min_documents ?? 1) && documents.length <= (service?.max_documents ?? 10);
  const quoteValid = countValid && (serviceId !== "requirements-check-v1" || (requirements.trim().length > 0 && requirementsBytes <= 4000));
  const [proposal, setProposal] = useState<Proposal>();
  const [explanation, setExplanation] = useState("");
  const [reporting, setReporting] = useState<Report>();
  const [dashboard, setDashboard] = useState(false);
  const [share, setShare] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const activeId = useRef<string | undefined>(undefined);
  const sessionGeneration = useRef(0);
  const api = useMemo(() => {
    const generation = sessionGeneration.current;
    const request = client(origin, token);
    return async function guardedRequest<T>(...args: Parameters<typeof request>): Promise<T> {
      const current = () => generation === sessionGeneration.current;
      if (!current()) throw new Error("Workspace session changed");
      try {
        const result = await request<T>(...args);
        if (!current()) throw new Error("Workspace session changed");
        return result;
      } catch (cause) {
        if (!current()) throw new Error("Workspace session changed");
        throw cause;
      }
    };
  }, [origin, token]);

  async function perform(action: () => Promise<void>) {
    const generation = sessionGeneration.current;
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      if (generation === sessionGeneration.current) setError(cause instanceof Error ? cause.message : "Unavailable. Keep this task and check its status.");
    } finally {
      if (generation === sessionGeneration.current) setBusy(false);
    }
  }
  function select(task: Receipt) {
    setDashboard(false);
    activeId.current = task.id;
    setSelected(task);
    setReporting(undefined);
    setProposal(undefined);
    setExplanation("");
    setShare("");
    if (!publicToken) history.replaceState(null, "", `/paypal/?task=${encodeURIComponent(task.id)}`);
  }
  async function refresh() {
    const generation = sessionGeneration.current;
    const result = await api<{ tasks: Receipt[] }>("/tasks");
    if (generation !== sessionGeneration.current) return;
    setTasks(result.tasks);
    const id = activeId.current ?? new URLSearchParams(location.search).get("task");
    const current = result.tasks.find(task => task.id === id);
    if (current) {
      activeId.current = current.id;
      setSelected(current);
    }
  }
  useEffect(() => {
    let cancelled = false;
    if (publicToken) {
      void api<Receipt>(`/receipts/${encodeURIComponent(publicToken)}`).then(receipt => {
        if (!cancelled) setSelected(receipt);
      }).catch(cause => {
        if (!cancelled) setError(String(cause.message));
      });
    } else if (token) {
      void api<Principal>("/session").then(async next => {
        if (!cancelled) {
          setPrincipal(next);
          await refresh();
          const catalog = await api<{ offers: Service[] }>("/offers");
          if (!cancelled) {
            setServices(catalog.offers);
            if (initialService.current) {
              const id = initialService.current;
              initialService.current = null;
              if (catalog.offers.some(service => service.id === id)) setServiceId(id);
              else setError("Unknown service link. Choose a registered service below.");
            }
          }
        }
      }).catch(cause => {
        if (!cancelled) setError(String(cause.message));
      });
    }
    return () => { cancelled = true; };
  }, [api, publicToken]);
  useEffect(() => {
    if (!principal || publicToken) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [api, principal, publicToken]);

  const editable = principal?.role === "buyer" || principal?.role === "agent";
  const restoring = Boolean(token) && !principal && !error && !publicToken;
  const taskPath = selected ? `/tasks/${encodeURIComponent(selected.id)}` : "";
  const heading = pageHeading({ dashboard, selected, publicToken, principal, restoring });

  return <div className="paypal-shell cp-app">
    <header className="paypal-header">
      <a href="/paypal/" aria-label="ChainPay PayPal workspace"><BrandLogo /></a>
      <div className="paypal-header-meta">
        <span className="paypal-badge"><i className="paypal-badge-dot" aria-hidden="true" />PayPal sandbox · no real money</span>
        {principal && <span className="paypal-role-chip"><LayoutGrid size={14} aria-hidden="true" />{principal.role} · {principal.workspace}</span>}
        {principal && <Button label="Sign out" variant="secondary" onClick={() => void perform(async () => {
          ++sessionGeneration.current;
          setBusy(false);
          setError("");
          sessionStorage.removeItem(SESSION_KEY);
          setToken("");
          setDocuments([{ name: "Document 1", text: "" }]);
          setRequirements("");
          setServiceId("document-extract-v1");
          initialService.current = null;
          requestId.current = crypto.randomUUID();
          setPrincipal(undefined);
          setSelected(undefined);
          setTasks([]);
          setProposal(undefined);
          setExplanation("");
          setReporting(undefined);
          setShare("");
          activeId.current = undefined;
          setDashboard(false);
        })} />}
      </div>
    </header>
    <main>
      <div className="paypal-heading">
        <div className="paypal-heading-copy">
          <div className="paypal-breadcrumb" aria-hidden="true">
            <span>Workspace</span>
            <span>/</span>
            <span>{dashboard ? "Outcomes" : selected ? "Receipt" : publicToken ? "Shared receipt" : "Agent work"}</span>
          </div>
          <h1>{heading.title}</h1>
          <p>{heading.lede}</p>
        </div>
        {principal && !publicToken && <div className="paypal-mode-pills" role="group" aria-label="Workspace view switcher">
          {editable && <button type="button" className={`paypal-mode-pill${!dashboard && !selected ? " is-active" : ""}`} disabled={busy} onClick={() => {
            setDashboard(false);
            activeId.current = undefined;
            setSelected(undefined);
            setProposal(undefined);
            setShare("");
            requestId.current = crypto.randomUUID();
            history.replaceState(null, "", "/paypal/");
          }}>Work studio</button>}
          {selected && <button type="button" className={`paypal-mode-pill${!dashboard && selected ? " is-active" : ""}`} disabled={busy} onClick={() => setDashboard(false)}>Active receipt ({selected.id.slice(0, 6)})</button>}
          <button type="button" className={`paypal-mode-pill${dashboard ? " is-active" : ""}`} disabled={busy} onClick={() => setDashboard(true)}>Outcome analytics</button>
        </div>}
      </div>
      {error && <p className="paypal-error" role="alert">{error}</p>}
      {restoring && <div className="paypal-card paypal-entry-hero" role="status">
        <span className="paypal-entry-robot"><RobotStill expression="idle" /></span>
        <div>
          <h2>Checking this tab’s access code.</h2>
          <p className="paypal-note">Verifying your scoped workspace session before loading tasks and receipts.</p>
        </div>
      </div>}
      {!principal && !publicToken && !restoring && <div className="paypal-entry-grid">
        <section className="paypal-card paypal-login">
          <div>
            <div className="paypal-entry-hero">
              <span className="paypal-entry-robot"><RobotStill expression="happy" /></span>
              <div>
                <h2>Enter your PayPal workspace</h2>
                <p>Receipts for agent work: exact quotes, source-linked outputs, and merchant-approved refunds.</p>
              </div>
            </div>
            <form onSubmit={event => {
              event.preventDefault();
              void perform(async () => {
                const entered = access.trim();
                const next = await client(origin, entered)<Principal>("/session");
                ++sessionGeneration.current;
                setBusy(false);
                sessionStorage.removeItem(SESSION_KEY);
                sessionStorage.setItem(SESSION_KEY, entered);
                setToken(entered);
                setPrincipal(next);
                setAccess("");
              });
            }}>
              <label htmlFor="paypal-access">Workspace access code</label>
              <input id="paypal-access" type="password" autoComplete="off" required value={access} onChange={event => setAccess(event.target.value)} placeholder="Enter buyer, merchant, or agent access code" />
              <button className="paypal-submit" type="submit" disabled={busy}>Open workspace</button>
            </form>
          </div>
          <small>The code stays in this tab to return from checkout. Sign out to clear this tab. The operator can revoke the access code.</small>
        </section>
        <section className="paypal-card" aria-label="Workspace roles and guarantees">
          <span className="paypal-eyebrow"><ShieldCheck size={14} aria-hidden="true" />Role separation</span>
          <h2>Explicit authority at every step</h2>
          <div className="paypal-role-cards">
            <div className="paypal-role-preview">
              <span className="paypal-role-icon" aria-hidden="true"><FileText size={18} /></span>
              <div>
                <strong>Buyer workspace</strong>
                <span>Prepare document quotes, approve PayPal sandbox checkout or prepaid allowance, and accept or challenge delivered revisions.</span>
              </div>
            </div>
            <div className="paypal-role-preview">
              <span className="paypal-role-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
              <div>
                <strong>Merchant workspace</strong>
                <span>Inspect delivery evidence, approve free rework or exact failed-unit refunds, and reconcile PayPal reporting observations.</span>
              </div>
            </div>
            <div className="paypal-role-preview">
              <span className="paypal-role-icon" aria-hidden="true"><Bot size={18} /></span>
              <div>
                <strong>Bounded agent</strong>
                <span>Prepare quotes and allocate within a buyer-approved delegation ceiling. Agents never approve checkout, refunds, or acceptance.</span>
              </div>
            </div>
          </div>
        </section>
      </div>}
      {(principal || publicToken) && <div className="paypal-layout">
        {principal && <aside className="paypal-sidebar">
          <div className="paypal-sidebar-head">
            <h2>Your tasks</h2>
          </div>
          <div className="paypal-sidebar-role">
            <span className="paypal-sidebar-role-icon" aria-hidden="true"><LayoutGrid size={16} /></span>
            <div>
              <strong>{principal.role} workspace</strong>
              <p className="paypal-note" style={{ margin: 0 }}>{principal.workspace} scope</p>
            </div>
          </div>
          <div className="paypal-actions">
            <Button label="Outcome dashboard" variant="secondary" isDisabled={busy} onClick={() => setDashboard(true)} />
            {editable && <Button label="New task" variant="secondary" isDisabled={busy} onClick={() => {
              setDashboard(false);
              activeId.current = undefined;
              setSelected(undefined);
              setProposal(undefined);
              setShare("");
              requestId.current = crypto.randomUUID();
              history.replaceState(null, "", "/paypal/");
            }} />}
          </div>
          <p className="paypal-sidebar-kicker">TASK RECEIPTS ({tasks.length})</p>
          <nav aria-label="Task receipts">
            {tasks.length ? tasks.map(task => <button key={task.id} className={!dashboard && task.id === selected?.id ? "selected" : ""} disabled={busy} onClick={() => select(task)}>
              <strong>{task.units.length} output{task.units.length === 1 ? "" : "s"}</strong>
              <span>{shownMoney(task.gross)} · {listStatus(task)}</span>
              <small>{task.id.slice(0, 8)}</small>
            </button>) : <p className="paypal-note">No tasks yet. Your first quote will appear here.</p>}
          </nav>
        </aside>}
        <div className="paypal-content">
          {dashboard && principal && <Suspense fallback={<p role="status">Loading outcome dashboard…</p>}>
            <Analytics key={`analytics:${principal.workspace}:${principal.id}:${token}`} origin={origin} token={token} onSelect={task => { void perform(async () => select(await api<Receipt>(`/tasks/${task.id}`))); }} />
          </Suspense>}
          {!dashboard && !selected && editable && <section className="paypal-card">
            <span className="paypal-eyebrow"><Sparkles size={14} aria-hidden="true" />Define the work</span>
            <h2>What should your agent read?</h2>
            {services.length > 0 && <div className="paypal-service-grid" role="group" aria-label="Registered service cards">
              {services.map(s => (
                <button
                  key={s.id}
                  type="button"
                  disabled={busy}
                  className={`paypal-service-tile${s.id === serviceId ? " is-active" : ""}`}
                  onClick={() => { setServiceId(s.id); requestId.current = crypto.randomUUID(); }}
                >
                  <span className="paypal-service-tile-top">
                    <strong>{s.name}</strong>
                    <span className="paypal-service-price">{shownMoney(s.unit_price)}</span>
                  </span>
                  <small>{s.delivery}</small>
                </button>
              ))}
            </div>}
            <label htmlFor="paypal-service">Service</label>
            <select id="paypal-service" value={serviceId} disabled={busy} onChange={e => { setServiceId(e.target.value); requestId.current = crypto.randomUUID(); }}>
              {services.length ? services.map(s => <option key={s.id} value={s.id}>{s.name} · {shownMoney(s.unit_price)}</option>) : <option value="document-extract-v1">Evidence-linked document summary · $4.00</option>}
            </select>
            <p>{service?.delivery ?? "Summary and factual claims linked to source excerpts."} {serviceId === "document-compare-v1" ? "Exactly two documents, $8.00 per pair." : "USD 4.00 per document. Text and Markdown, up to 10 documents."}</p>
            {serviceId === "requirements-check-v1" && <>
              <label htmlFor="paypal-requirements">Requirements to check</label>
              <textarea id="paypal-requirements" rows={3} aria-describedby="requirements-limit" value={requirements} onChange={e => { setRequirements(e.target.value); requestId.current = crypto.randomUUID(); }} />
              <p id="requirements-limit" className="paypal-note" role={requirementsBytes > 4000 ? "alert" : undefined}>{requirementsBytes} / 4000 UTF-8 bytes. Non-ASCII characters may use multiple bytes.</p>
            </>}
            <div className="paypal-actions">
              <Button label={serviceId === "document-compare-v1" ? "Use two sample documents" : "Use three sample documents"} variant="secondary" isDisabled={busy} onClick={() => { setDocuments(serviceId === "document-compare-v1" ? samples.slice(0, 2) : samples); requestId.current = crypto.randomUUID(); }} />
              <label className="paypal-file"><Upload size={15} aria-hidden="true" />Upload text files<input type="file" multiple accept=".txt,.md,text/plain,text/markdown" onChange={e => void perform(async () => { const generation = sessionGeneration.current; const draftId = requestId.current; const files = [...(e.target.files ?? [])]; if (!files.length || files.length > 10 || files.some(f => f.size > 16000)) throw new Error("Choose 1–10 text files of at most 16 KB each."); const uploaded = await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() }))); if (generation !== sessionGeneration.current || draftId !== requestId.current) return; setDocuments(uploaded); requestId.current = crypto.randomUUID(); })} /></label>
            </div>
            {documents.map((document, index) => {
              const alnumCount = (document.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
              return <div className="paypal-document" key={index}>
                <div className="paypal-document-head">
                  <strong>Document {index + 1}</strong>
                  <span className={`paypal-document-badge${alnumCount >= 30 ? " is-ready" : ""}`}>
                    {alnumCount >= 30 ? "Readable input" : `${alnumCount} / 30 readable chars`}
                  </span>
                </div>
                <label htmlFor={`document-name-${index}`}>Document {index + 1} name</label>
                <input id={`document-name-${index}`} value={document.name} maxLength={120} onChange={e => { setDocuments(d => d.map((v, i) => i === index ? { ...v, name: e.target.value } : v)); requestId.current = crypto.randomUUID(); }} />
                <label htmlFor={`document-text-${index}`}>Source text</label>
                <textarea id={`document-text-${index}`} rows={4} value={document.text} maxLength={16000} onChange={e => { setDocuments(d => d.map((v, i) => i === index ? { ...v, text: e.target.value } : v)); requestId.current = crypto.randomUUID(); }} />
                <div className="paypal-actions">
                  <Button label={`Remove document ${index + 1}`} variant="secondary" isDisabled={busy || documents.length <= 1} onClick={() => { setDocuments(d => d.filter((_, i) => i !== index)); requestId.current = crypto.randomUUID(); }} />
                </div>
              </div>;
            })}
            <div className="paypal-actions">
              <Button label="Add document" variant="secondary" isDisabled={busy || documents.length >= (service?.max_documents ?? 10)} onClick={() => { setDocuments(d => [...d, { name: `Document ${d.length + 1}`, text: "" }]); requestId.current = crypto.randomUUID(); }} />
            </div>
            <p className="paypal-note">{documents.length} documents supplied. {serviceId === "document-compare-v1" ? "Exactly 2 documents required." : "Supply 1–10 documents."}</p>
            <ServicePreflight api={api} services={services} input={{ service_id: serviceId, documents, requirements: serviceId === "requirements-check-v1" ? requirements : undefined }} onSelect={id => { setServiceId(id); requestId.current = crypto.randomUUID(); }} />
            <div className="paypal-actions">
              <Button label="Prepare quote" isDisabled={busy || !quoteValid} onClick={() => void perform(async () => { const generation = sessionGeneration.current; const request = { request_id: requestId.current, documents: structuredClone(documents), service_id: serviceId, requirements: serviceId === "requirements-check-v1" ? requirements : undefined }; const { request_id, ...inputs } = request; const check = await api<Preflight>("/preflight", "POST", inputs); if (generation !== sessionGeneration.current || request_id !== requestId.current) return; if (!check.ready) throw new Error(check.issues.map(i => `Document ${i.document_index + 1} (${request.documents[i.document_index]?.name}): ${i.message}`).join("; ")); const task = await api<Receipt>("/tasks", "POST", request); if (generation !== sessionGeneration.current || request_id !== requestId.current) return; select(task); await refresh(); })} />
            </div>
            <p className="paypal-note">{serviceId === "document-compare-v1" ? "Compare both sample sources in one output." : "Sample inputs contain readable supplier terms."} Outputs are generated when you run the paid task.</p>
          </section>}
          {!dashboard && !selected && !editable && <section className="paypal-card">
            <h2>{publicToken ? "Loading shared receipt…" : "Select a task to review"}</h2>
            <p>Payment and delivery remain separate evidence.</p>
          </section>}
          {!dashboard && selected && <ReceiptView
            selected={selected}
            principal={principal}
            publicToken={publicToken}
            busy={busy}
            taskPath={taskPath}
            proposal={proposal}
            explanation={explanation}
            reporting={reporting}
            share={share}
            perform={perform}
            api={api}
            refresh={refresh}
            setSelected={receipt => { setSelected(receipt); setTasks(tasks => tasks.map(task => task.id === receipt.id ? receipt : task)); }}
            setProposal={setProposal}
            setExplanation={setExplanation}
            setReporting={setReporting}
            setShare={setShare}
          />}
          {principal && <Subscriptions key={`subscriptions:${principal.workspace}:${principal.id}:${token}`} api={api} principal={principal} services={services} selected={selected} onAllocated={task => { select(task); void refresh(); }} />}
        </div>
      </div>}
    </main>
    <footer className="paypal-footer">
      <span>ChainPay · Sandbox payments. Real work, inspectable evidence.</span>
      <span>Explicit approvals · Immutable operation claims</span>
    </footer>
  </div>;
}

function ReceiptView({ selected, principal, publicToken, busy, taskPath, proposal, explanation, reporting, share, perform, api, refresh, setSelected, setProposal, setExplanation, setReporting, setShare }: {
  selected: Receipt;
  principal?: Principal;
  publicToken?: string;
  busy: boolean;
  taskPath: string;
  proposal?: Proposal;
  explanation: string;
  reporting?: Report;
  share: string;
  perform: (action: () => Promise<void>) => Promise<void>;
  api: ReturnType<typeof client>;
  refresh: () => Promise<void>;
  setSelected: (receipt: Receipt) => void;
  setProposal: (proposal: Proposal | undefined) => void;
  setExplanation: (value: string) => void;
  setReporting: (value: Report | undefined) => void;
  setShare: (value: string) => void;
}) {
  const unresolved = unresolvedPayment(selected);
  const quoteReady = quoteStillOpen(selected);
  const nextCapture = principal?.role === "buyer" && selected.order_id && !selected.captured && !selected.capture_state;
  const nextCheckout = principal?.role === "buyer" && !selected.subscription_funding && !selected.captured && !selected.funded && !selected.order_state && quoteReady;
  const nextWork = (selected.funded || selected.captured) && !selected.payment_review && selected.units.some(unit => ["pending", "unknown", "processing"].includes(unit.state));
  const fundedOrCaptured = Boolean(selected.captured || selected.funded || selected.subscription_funding);
  const deliveredCount = selected.units.filter(u => u.state === "delivered").length;
  const failedCount = selected.units.filter(u => u.state === "failed").length;
  const allProcessed = selected.units.every(u => u.state === "delivered" || u.state === "failed");
  const statusText = receiptStatus(selected);

  return <section className="paypal-card" aria-label="Task receipt">
    <div className="paypal-receipt-title">
      <div>
        <span className="paypal-eyebrow"><CheckCircle2 size={14} aria-hidden="true" />Verified task record</span>
        <h2>{selected.units.length} outputs, one clear record.</h2>
      </div>
      <span className={`paypal-status${selected.captured || selected.refund_confirmed ? " is-ok" : selected.payment_review || unresolved ? " is-warn" : ""}`}>{statusText}</span>
    </div>

    {/* Live 4-stage Payment & AI Work Timeline (PR 72 inspired) */}
    <ol className="paypal-live-steps" aria-label="Task lifecycle progress">
      <li className="paypal-live-step is-done">
        <span className="paypal-live-step-mark" aria-hidden="true">✓</span>
        <span className="paypal-live-step-body">
          <strong>1. Quote bound</strong>
          <small>{selected.units.length} unit{selected.units.length === 1 ? "" : "s"} · SHA-256 locked</small>
        </span>
      </li>
      <li className={`paypal-live-step ${selected.payment_review || unresolved ? "is-warn" : fundedOrCaptured ? "is-done" : "is-current"}`}>
        <span className="paypal-live-step-mark" aria-hidden="true">{fundedOrCaptured ? "✓" : "2"}</span>
        <span className="paypal-live-step-body">
          <strong>2. Funding</strong>
          <small>{selected.subscription_funding ? "Prepaid allowance" : selected.captured ? "PayPal captured" : "Awaiting approval"}</small>
        </span>
      </li>
      <li className={`paypal-live-step ${allProcessed ? (failedCount > 0 ? "is-warn" : "is-done") : fundedOrCaptured ? "is-current" : ""}`}>
        <span className="paypal-live-step-mark" aria-hidden="true">{allProcessed ? (failedCount > 0 ? "!" : "✓") : "3"}</span>
        <span className="paypal-live-step-body">
          <strong>3. AI processing</strong>
          <small>{deliveredCount} delivered · {failedCount} failed</small>
        </span>
      </li>
      <li className={`paypal-live-step ${selected.refund_confirmed ? "is-done" : selected.payment_review ? "is-warn" : selected.net ? "is-done" : ""}`}>
        <span className="paypal-live-step-mark" aria-hidden="true">{selected.refund_confirmed || selected.net ? "✓" : "4"}</span>
        <span className="paypal-live-step-body">
          <strong>4. Settlement</strong>
          <small>{selected.refund_confirmed ? "Refund applied" : selected.payment_review ? "Review pending" : selected.net ? "Net established" : "Pending settlement"}</small>
        </span>
      </li>
    </ol>

    <div className="paypal-service-terms">
      <h3>{selected.service_name ?? "Evidence-linked document summary"}</h3>
      <p>Service version: <code>{selected.offer_version ?? "document-extract-v1"}</code></p>
      {!publicToken && typeof selected.requirements === "string" && <>
        <h3>Purchased requirements</h3>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{selected.requirements}</p>
      </>}
    </div>
    {selected.subscription_funding && <p>Prepaid service allocation: {selected.subscription_funding.units} units. No per-task PayPal capture. Payment reference: <code>{selected.subscription_funding.payment_id}</code>. Failed output units restore allowance once, not cash.</p>}
    {selected.payment_review && <p className="paypal-notice" role="alert">{selected.payment_review}. Net cost is not established.</p>}
    {!quoteReady && <p className="paypal-notice">This quote expired. Prepare a new quote. No payment was submitted.</p>}
    <div className="paypal-cost">
      <div>
        <span>Net buyer cost</span>
        <strong>{shownMoney(selected.net)}</strong>
      </div>
      <dl>
        <div><dt>Original quote</dt><dd>{shownMoney(selected.gross)}</dd></div>
        <div><dt>Confirmed refund</dt><dd>{shownMoney(selected.refund_confirmed ? selected.refund : "0.00")}</dd></div>
      </dl>
    </div>
    {!publicToken && <div className="paypal-actions">
      {nextCheckout && <Button label={`Approve ${shownMoney(selected.gross)} quote & open checkout`} isDisabled={busy} onClick={() => void perform(async () => {
        const task = await api<Receipt>(`${taskPath}/checkout`, "POST", { digest: selected.quote_digest });
        setSelected(task);
        if (task.approval_url) location.assign(checkoutUrl(task.approval_url));
      })} />}
      {principal?.role === "buyer" && selected.approval_url && !selected.captured && <Button label="Continue PayPal approval" variant={nextCheckout ? "secondary" : undefined} isDisabled={busy} onClick={() => location.assign(checkoutUrl(selected.approval_url!))} />}
      {nextCapture && <Button label={`Confirm capture of ${shownMoney(selected.gross)}`} isDisabled={busy} onClick={() => void perform(async () => {
        setSelected(await api<Receipt>(`${taskPath}/capture`, "POST", { digest: selected.quote_digest }));
        await refresh();
      })} />}
      {nextWork && <Button label="Run or recover this paid task" isDisabled={busy} onClick={() => void perform(async () => {
        await api(`${taskPath}/process`, "POST");
        await refresh();
      })} />}
      <Button label="Check original payment" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => {
        setSelected(await api<Receipt>(`${taskPath}/reconcile`, "POST"));
      })} />
    </div>}
    {unresolved && <p className="paypal-notice">An operation is unresolved. Check this original task; do not create a replacement payment.</p>}
    <div className="paypal-units">
      {selected.units.map(unit => <article key={unit.index}>
        <div className="paypal-unit-title">
          <h3>{unit.name ?? `Document ${unit.index + 1}`}</h3>
          <div className="paypal-unit-meta">
            <span className={`paypal-unit-state ${unit.state}`}>{unitLabel[unit.state]}</span>
            <span>Revision {unit.revision ?? 0} · {unit.buyer_review === "accept" ? "Accepted by buyer" : unit.buyer_review === "challenge" ? "Challenged by buyer" : "Buyer acceptance not recorded"}</span>
          </div>
        </div>
        {unit.reason && <p className="paypal-notice">{unit.reason}</p>}
        {unit.result && <>
          <p>{unit.result.output.summary}</p>
          {unit.result.output.facts.length > 0 && <div className="paypal-facts-grid">
            {unit.result.output.facts.map((fact, index) => <div className="paypal-fact" key={index}>
              <strong>{fact.claim}</strong>
              <blockquote>{fact.evidence}</blockquote>
              {fact.document_index !== undefined && <small>Source document {fact.document_index + 1}</small>}
            </div>)}
          </div>}
          {selected.offer_version === "requirements-check-v1" && unit.result.output.assessment && typeof unit.result.output.assessment.conclusion === "string" && typeof unit.result.output.assessment.requirements === "string" && Array.isArray(unit.result.output.assessment.missing_evidence) && <div className="paypal-assessment-box"><strong>Requirements assessment</strong><p>{unit.result.output.assessment.conclusion}</p><p>Requirements: {unit.result.output.assessment.requirements}</p><strong>Requirements findings</strong><ul>{unit.result.output.assessment.missing_evidence.filter((item) => typeof item === "string").map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
          <small>Processed by {unit.result.model}. Review the output against its source.</small>
        </>}
        <details>
          <summary>Evidence hashes</summary>
          <p>Input: <code>{unit.input_hash}</code></p>
          <p>Output: <code>{unit.output_hash ?? "No delivered output"}</code></p>
        </details>
      </article>)}
    </div>
    {!publicToken && <Resolution key={selected.id} receipt={selected} principal={principal} api={api} update={setSelected} busy={busy} perform={perform} />}
    <p className="paypal-note">Payment: PayPal sandbox API observation. Delivery: merchant processing record, not buyer acceptance. This is not an on-chain receipt.</p>
    {!publicToken && <div className="paypal-review">
      <h3>Review the outcome</h3>
      <div className="paypal-actions">
        <Button label="Ask AI to explain this receipt" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => {
          const answer = await api<{ explanation: string }>(`${taskPath}/explain`, "POST");
          setExplanation(answer.explanation);
        })} />
        {!selected.subscription_funding && !selected.payment_review && !selected.refunds?.length && <Button label="Review failed-unit refund" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => setProposal(await api<Proposal>(`${taskPath}/refund-proposal`)))} />}
      </div>
      {explanation && <aside className="paypal-explanation"><strong>AI explanation · not payment authority</strong><p>{explanation}</p></aside>}
      {proposal && !selected.refunds?.length && <div className="paypal-refund">
        <h3>Proposed refund: {shownMoney(proposal.amount)}</h3>
        <p>{proposal.reason}</p>
        {principal?.role === "merchant"
          ? <Button label={`Approve ${shownMoney(proposal.amount)} sandbox refund`} isDisabled={busy || Boolean(selected.refund_state)} onClick={() => void perform(async () => {
            setSelected(await api<Receipt>(`${taskPath}/refund`, "POST", { digest: proposal.digest }));
            setProposal(undefined);
            await refresh();
          })} />
          : <p>A merchant must review and approve this refund.</p>}
      </div>}
    </div>}
    {!publicToken && <div className="paypal-review">
      <Button label="Check PayPal transaction report" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => setReporting(await api(`${taskPath}/reporting`, "POST")))} />
      {reporting && <div>
        <p>{reporting.note}</p>
        {reporting.truncated && <p>Result window reached the five-page limit; this report is incomplete.</p>}
        {reporting.transactions.length
          ? <ul>{reporting.transactions.map(row => <li key={row.transaction_id}><code>{row.transaction_id}</code> · {row.status} · {row.event_code} · {row.amount?.currency_code} {row.amount?.value}</li>)}</ul>
          : <p>No matching transactions in this reporting window yet.</p>}
      </div>}
    </div>}
    <details className="paypal-identifiers">
      <summary>Provider references</summary>
      <dl>{[["Task", selected.id], ["Order", selected.order_id], ["Capture", selected.capture_id], ["Refund", selected.refund_id]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "Not established"}</dd></div>)}</dl>
    </details>
    <div className="paypal-actions">
      <Button label="Export CSV" variant="secondary" onClick={() => {
        const url = URL.createObjectURL(new Blob([exportReceipt(selected)], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `chainpay-${selected.id}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      }} />
      {principal?.role === "buyer" && <>
        <Button label="Share redacted receipt" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => {
          const result = await api<{ token: string }>(`${taskPath}/share`, "POST");
          setShare(`${location.origin}/paypal/receipt/${result.token}`);
        })} />
        <Button label="Revoke share link" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => {
          await api(`${taskPath}/share`, "DELETE");
          setShare("");
        })} />
      </>}
    </div>
    {share && <p className="paypal-share"><a href={share} target="_blank" rel="noreferrer">Open redacted receipt</a><input aria-label="Public receipt URL" readOnly value={share} onFocus={event => event.target.select()} /></p>}
  </section>;
}

function pageHeading({ dashboard, selected, publicToken, principal, restoring }: { dashboard: boolean; selected?: Receipt; publicToken?: string; principal?: Principal; restoring: boolean }) {
  if (restoring) return { title: "Opening your workspace", lede: "Checking the access code stored in this tab." };
  if (!principal && !publicToken) return { title: "Open your workspace", lede: "Use your dedicated buyer or merchant access code. Signing in does not approve a payment." };
  if (dashboard) return { title: "Settled outcomes", lede: "Quotes and unconfirmed refunds stay out of the net. This view is the latest 100 tasks, not a lifetime total." };
  if (publicToken) return { title: "Shared receipt", lede: selected ? "Redacted record. Names, document text, and approval actions stay off this page." : "Loading the redacted record. Payment and delivery remain separate evidence." };
  if (selected) return { title: "Task receipt", lede: "Payment and delivery remain separate evidence. Net cost appears only when the server has established it." };
  if (principal?.role === "merchant") return { title: "Select a task", lede: "Review a quote, a capture, or a failed unit. Opening a task does not approve a refund." };
  return { title: "Prepare a quote", lede: "Choose a summary, comparison or requirements check. Review the exact quote before approving PayPal sandbox payment." };
}

function quoteStillOpen(task: Receipt): boolean {
  if (task.subscription_funding || task.funded || task.captured || task.order_id || task.order_state) return true;
  if (task.quote_expires_at == null) return true;
  return task.quote_expires_at * 1000 > Date.now();
}

function unresolvedPayment(task: Receipt): boolean {
  return !!task.refund_pending || [task.order_state, task.capture_state, task.refund_state, ...(task.refunds ?? []).map(r => r.state)].some(state => state === "unknown" || state === "dispatching");
}

function receiptStatus(task: Receipt): string {
  if (task.payment_review) return "Merchant review required";
  if (unresolvedPayment(task)) return "Payment unresolved";
  if (task.refund_confirmed) return "Refund confirmed";
  if (task.subscription_funding) return "Prepaid allowance reserved";
  if (task.captured) return "PayPal capture confirmed";
  return "Awaiting payment";
}

function listStatus(task: Receipt): string {
  if (task.payment_review) return "Needs review";
  if (unresolvedPayment(task)) return "Payment unresolved";
  if (task.subscription_funding) return "Allowance reserved";
  if (task.captured) return "Captured";
  return "Awaiting payment";
}
