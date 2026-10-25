import { useEffect, useMemo, useRef, useState } from "react";
import { AgStudio, AgStudioProvider, createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import { AgStudioAiModule, AgStudioLicenseManager, createAiHarness, studioTheme, type AgAiHarnessSetup, type AgReportState, type AgWidgetData, type AgWidgetDataFormat } from "ag-studio";
import { client, shownMoney, type Receipt } from "./client";

type Snapshot = { cash_scope?: string; prepaid_units_allocated?: number; captured: string; confirmed_refunds: string; known_net_cost: string | null; delivered_units: number; failed_units: number; unresolved_tasks: number; task_count: number; scope: string; tasks: Receipt[] };
type WidgetState = AgWidgetData<Record<string, never>, AgWidgetDataFormat<Record<string, never>>> & { type: "costs" | "outcomes" | "receipts" };
interface Registry extends AgRegistry { widgets: readonly AgWidgetDefinition<"costs" | "outcomes" | "receipts", WidgetState>[] }

function reportState(wide: boolean): AgReportState<Registry> {
  const widgetLayout = wide
    ? { costs: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 8 }, outcomes: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 8 }, receipts: { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 12 } }
    : { costs: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 8 }, outcomes: { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 8 }, receipts: { xTrack: 0, yTrack: 16, xSpan: 12, ySpan: 12 } };
  return { selectedPageId: "outcomes", pages: [{ id: "outcomes", layout: { columns: 12, rowHeight: 32, minWidth: 0 }, widgets: { costs: { type: "costs", dataMapping: {} }, outcomes: { type: "outcomes", dataMapping: {} }, receipts: { type: "receipts", dataMapping: {} } }, widgetLayout }], panels: { ai: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true }, filters: { collapsed: true } } };
}

const license = import.meta.env.VITE_CHAINPAY_PAYPAL_STUDIO_LICENSE;
if (license) AgStudioLicenseManager.setLicenseKey(license);
const theme = studioTheme.withParams({ accentColor: "#0052ff", studioMinWidth: 0, fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" });

function captureLabel(task: Receipt): string {
  if (task.payment_review) return "Needs review";
  if (task.subscription_funding) return "Prepaid units";
  if (task.captured) return "Confirmed";
  return "Not established";
}

function CostPanel({ snapshot }: { snapshot?: Snapshot }) {
  return <div className="paypal-studio-widget"><h3>Orders cash cost</h3><div className="paypal-cost"><div><span>Known Orders net</span><strong>{shownMoney(snapshot?.known_net_cost)}</strong></div><dl><div><dt>Captured</dt><dd>{shownMoney(snapshot?.captured)}</dd></div><div><dt>Refunded</dt><dd>{shownMoney(snapshot?.confirmed_refunds)}</dd></div></dl></div><small>Exact USD amounts for Orders only. Subscription cash is separate; see subscription payment references. Quotes and unconfirmed refunds are excluded.</small></div>;
}
function OutcomePanel({ snapshot }: { snapshot?: Snapshot }) {
  return <div className="paypal-studio-widget"><h3>Work outcomes</h3><p>Cumulative prepaid units allocated (including consumed/restored): {snapshot?.prepaid_units_allocated ?? 0}</p><dl className="paypal-outcomes"><div><dt>Delivered units</dt><dd>{snapshot?.delivered_units ?? "—"}</dd></div><div><dt>Failed units</dt><dd>{snapshot?.failed_units ?? "—"}</dd></div><div><dt>Unresolved payments</dt><dd>{snapshot?.unresolved_tasks ?? "—"}</dd></div></dl><small>Delivery is a merchant record, not buyer acceptance.</small></div>;
}
function ReceiptPanel({ snapshot, onSelect }: { snapshot?: Snapshot; onSelect: (receipt: Receipt) => void }) {
  return <div className="paypal-studio-widget"><h3>Receipt evidence</h3>{snapshot?.tasks.length ? <table><thead><tr><th>Task</th><th>Capture</th><th>Net buyer cost</th></tr></thead><tbody>{snapshot.tasks.map(task => <tr key={task.id}><td><button onClick={() => onSelect(task)}>{task.id.slice(0, 8)}</button></td><td>{captureLabel(task)}</td><td>{shownMoney(task.net)}</td></tr>)}</tbody></table> : <p>No tasks in this workspace.</p>}</div>;
}

export default function Analytics({ origin, token, onSelect }: { origin: string; token: string; onSelect: (receipt: Receipt) => void }) {
  const api = useMemo(() => client(origin, token), [origin, token]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 960px)").matches;
  const state = useRef<AgReportState<Registry>>(reportState(wide));
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await api<Snapshot>("/analytics"));
      setVersion(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Snapshot unavailable");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, [api]);
  const widgets = useMemo(() => createWidgets<Registry>({ additionalTypes: [
    { id: "costs", label: "Orders cash cost", defaultSize: { width: 500, height: 240 }, minSize: { width: 220, height: 160 }, dataMapping: {}, form: params => params.createDefaults({ dataMappingItems: [] }), comp: () => <CostPanel snapshot={snapshot} /> },
    { id: "outcomes", label: "Work outcomes", defaultSize: { width: 500, height: 240 }, minSize: { width: 220, height: 160 }, dataMapping: {}, form: params => params.createDefaults({ dataMappingItems: [] }), comp: () => <OutcomePanel snapshot={snapshot} /> },
    { id: "receipts", label: "Receipt evidence", defaultSize: { width: 500, height: 240 }, minSize: { width: 220, height: 160 }, dataMapping: {}, form: params => params.createDefaults({ dataMappingItems: [] }), comp: () => <ReceiptPanel snapshot={snapshot} onSelect={onSelect} /> },
  ], menu: [{ label: "ChainPay outcomes", widgetIds: ["costs", "outcomes", "receipts"] }] }), [snapshot, onSelect]);
  const ai = useMemo<AgAiHarnessSetup>(() => ({ api: studio }) => createAiHarness(studio, () => ({ primary: "outcomes", promptStarters: [{ label: "Explain my costs", prompt: "Explain confirmed spend, refunds, and unresolved outcomes." }], agents: [{ id: "outcomes", name: "Outcome analyst", description: "Read-only analysis of your authorized receipts", run: async function* (input, context) {
    yield { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId };
    try {
      const question = [...input.messages].reverse().find(message => message.role === "user")?.content;
      if (typeof question !== "string") throw new Error("Enter a question about your outcomes.");
      const answer = await api<{ answer: string }>("/analytics/ask", "POST", { question }, context.signal);
      if (context.signal?.aborted) return;
      const messageId = crypto.randomUUID();
      yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
      yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: answer.answer + "\n\nBased on a fresh server snapshot. Refresh the dashboard to update its cards. AI cannot approve payments or refunds." };
      yield { type: "TEXT_MESSAGE_END", messageId };
      yield { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId };
    } catch (cause) {
      if (!context.signal?.aborted) yield { type: "RUN_ERROR", message: cause instanceof Error ? cause.message : "Analysis unavailable" };
    }
  } }] })), [api]);
  return <section className="paypal-analytics" aria-busy={loading}>
    <div className="paypal-actions">
      <h2>Outcome dashboard</h2>
      <button onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh snapshot"}</button>
    </div>
    <p>{snapshot?.scope ?? "Loading authorized receipts…"}. Cards show the full snapshot; filters do not change these totals. Refresh restarts the in-memory analyst conversation.</p>
    {error && <p className="paypal-error" role="alert">{error}</p>}
    {snapshot && wide && <AgStudioProvider modules={[AgStudioAiModule]}><AgStudio<Registry> key={version} theme={theme} data={{ sources: [{ id: "receipts", data: snapshot.tasks.map(task => ({ task: task.id, captured: task.captured, net_usd: task.net })) }] }} widgets={widgets} initialState={state.current} onStateUpdated={event => { state.current = event.state as unknown as AgReportState<Registry>; }} ai={ai} mode="edit" panels={{ edit: { right: ["ai"] } }} style={{ height: 720, width: "100%" }} /></AgStudioProvider>}
    {snapshot && !wide && <div className="paypal-analytics-stack"><CostPanel snapshot={snapshot} /><OutcomePanel snapshot={snapshot} /><ReceiptPanel snapshot={snapshot} onSelect={onSelect} /></div>}
  </section>;
}
