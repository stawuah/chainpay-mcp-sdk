import { useEffect, useMemo, useRef, useState } from "react";
import { AgStudio, AgStudioProvider, createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import { AgStudioAiModule, AgStudioLicenseManager, createAiHarness, studioTheme, type AgAiHarnessSetup, type AgReportState, type AgWidgetData, type AgWidgetDataFormat } from "ag-studio";
import { client, money, type Receipt } from "./client";

type Snapshot = { captured: string; confirmed_refunds: string; known_net_cost: string; delivered_units: number; failed_units: number; unresolved_tasks: number; task_count: number; scope: string; tasks: Receipt[] };
type WidgetState = AgWidgetData<Record<string, never>, AgWidgetDataFormat<Record<string, never>>> & { type: "costs" | "outcomes" | "receipts" };
interface Registry extends AgRegistry { widgets: readonly AgWidgetDefinition<"costs" | "outcomes" | "receipts", WidgetState>[] }
const initialState: AgReportState<Registry> = { selectedPageId: "outcomes", pages: [{ id: "outcomes", layout: { columns: 12, rowHeight: 32, minWidth: 0 }, widgets: { costs: { type: "costs", dataMapping: {} }, outcomes: { type: "outcomes", dataMapping: {} }, receipts: { type: "receipts", dataMapping: {} } }, widgetLayout: { costs: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 10 }, outcomes: { xTrack: 0, yTrack: 10, xSpan: 12, ySpan: 10 }, receipts: { xTrack: 0, yTrack: 20, xSpan: 12, ySpan: 15 } } }], panels: { ai: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true }, filters: { collapsed: true } } };
const license = import.meta.env.VITE_CHAINPAY_PAYPAL_STUDIO_LICENSE;
if (license) AgStudioLicenseManager.setLicenseKey(license);
const theme = studioTheme.withParams({ accentColor: "#0052ff", studioMinWidth: 0, fontFamily: "Inter, system-ui, sans-serif" });

export default function Analytics({ origin, token, onSelect }: { origin: string; token: string; onSelect: (receipt: Receipt) => void }) {
  const api = useMemo(() => client(origin, token), [origin, token]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const state = useRef<AgReportState<Registry>>(initialState);
  async function refresh() {
    setLoading(true); setError("");
    try { setSnapshot(await api<Snapshot>("/analytics")); setVersion(v => v + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Snapshot unavailable"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [api]);
  const widgets = useMemo(() => createWidgets<Registry>({ additionalTypes: [
    { id: "costs", label: "Confirmed buyer cost", defaultSize: { width: 500, height: 240 }, minSize: { width: 220, height: 160 }, dataMapping: {}, form: p => p.createDefaults({ dataMappingItems: [] }), comp: () => <div className="paypal-studio-widget"><h3>Confirmed buyer cost</h3><div className="paypal-totals">{[["Captured", snapshot?.captured], ["Refunded", snapshot?.confirmed_refunds], ["Known net cost", snapshot?.known_net_cost]].map(([label, amount]) => <div key={label}><span>{label}</span><strong>{money(amount ?? null)}</strong></div>)}</div><small>Exact USD amounts. Quotes and unconfirmed refunds are excluded.</small></div> },
    { id: "outcomes", label: "Work outcomes", defaultSize: { width: 500, height: 240 }, minSize: { width: 220, height: 160 }, dataMapping: {}, form: p => p.createDefaults({ dataMappingItems: [] }), comp: () => <div className="paypal-studio-widget"><h3>Work outcomes</h3><div className="paypal-totals">{[["Delivered units", snapshot?.delivered_units], ["Failed units", snapshot?.failed_units], ["Unresolved payments", snapshot?.unresolved_tasks]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><small>Delivery is a merchant record, not buyer acceptance.</small></div> },
    { id: "receipts", label: "Receipt evidence", defaultSize: { width: 500, height: 240 }, minSize: { width: 220, height: 160 }, dataMapping: {}, form: p => p.createDefaults({ dataMappingItems: [] }), comp: () => <div className="paypal-studio-widget"><h3>Receipt evidence</h3>{snapshot?.tasks.length ? <table><thead><tr><th>Task</th><th>Capture</th><th>Net buyer cost</th></tr></thead><tbody>{snapshot.tasks.map(task => <tr key={task.id}><td><button onClick={() => onSelect(task)}>{task.id.slice(0, 8)}</button></td><td>{task.captured ? "Confirmed" : "Not established"}</td><td>{money(task.net)}</td></tr>)}</tbody></table> : <p>No tasks in this workspace.</p>}</div> },
  ], menu: [{ label: "ChainPay outcomes", widgetIds: ["costs", "outcomes", "receipts"] }] }), [snapshot, onSelect]);
  const ai = useMemo<AgAiHarnessSetup>(() => ({ api: studio }) => createAiHarness(studio, () => ({ primary: "outcomes", promptStarters: [{ label: "Explain my costs", prompt: "Explain confirmed spend, refunds, and unresolved outcomes." }], agents: [{ id: "outcomes", name: "Outcome analyst", description: "Read-only analysis of your authorized receipts", run: async function* (input, context) {
    yield { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId };
    try {
      const question = [...input.messages].reverse().find(m => m.role === "user")?.content;
      if (typeof question !== "string") throw new Error("Enter a question about your outcomes.");
      const answer = await api<{ answer: string }>("/analytics/ask", "POST", { question }, context.signal);
      if (context.signal?.aborted) return;
      const messageId = crypto.randomUUID();
      yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
      yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: answer.answer + "\n\nBased on a fresh server snapshot. Refresh the dashboard to update its cards. AI cannot approve payments or refunds." };
      yield { type: "TEXT_MESSAGE_END", messageId };
      yield { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId };
    } catch (e) { if (!context.signal?.aborted) yield { type: "RUN_ERROR", message: e instanceof Error ? e.message : "Analysis unavailable" }; }
  } }] })), [api]);
  return <section className="paypal-analytics"><div className="paypal-actions"><h2>Outcome dashboard</h2><button onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh snapshot"}</button></div><p>{snapshot?.scope ?? "Loading authorized receipts…"}. Cards show the full snapshot; filters do not change these totals. Refresh restarts the in-memory analyst conversation.</p>{error && <p role="alert">{error}</p>}{snapshot && <AgStudioProvider modules={[AgStudioAiModule]}><AgStudio<Registry> key={version} theme={theme} data={{ sources: [{ id: "receipts", data: snapshot.tasks.map(t => ({ task: t.id, captured: t.captured, net_usd: t.net })) }] }} widgets={widgets} initialState={state.current} onStateUpdated={event => { state.current = event.state as unknown as AgReportState<Registry>; }} ai={ai} mode="edit" panels={{ edit: { right: ["ai"] } }} style={{ height: 900, width: "100%" }} /></AgStudioProvider>}</section>;
}
