import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { client, money, type Service } from "./client";

export type Preflight = { ready: boolean; outputs: number; amount: string; issues: { document_index: number; message: string }[] };
type Props = { api: ReturnType<typeof client>; services: Service[]; input: { service_id: string; documents: { name: string; text: string }[]; requirements?: string }; onSelect: (id: string) => void };
export default function ServicePreflight({ api, services, input, onSelect }: Props) {
  const [objective, setObjective] = useState("");
  const [suggestion, setSuggestion] = useState<{ service_id: string; explanation: string }>();
  const [result, setResult] = useState<Preflight>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const objectiveBytes = new TextEncoder().encode(objective).length;
  const mounted = useRef(false);
  const objectiveRef = useRef(objective); objectiveRef.current = objective;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const version = JSON.stringify(input);
  const current = useRef(version); current.current = version;
  useEffect(() => { setResult(undefined); setError(""); }, [version]);
  async function check() {
    setBusy(true); setError(""); setStatus("Checking inputs…");
    const requested = version;
    try { const next = await api<Preflight>("/preflight", "POST", input); if (mounted.current && current.current === requested) { setResult(next); setStatus("Input check complete."); } }
    catch (e) { if (mounted.current && current.current === requested) { setStatus("Input check unavailable."); setError(e instanceof Error ? e.message : "Input check unavailable. Try again before paying."); } }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="paypal-review">
    <div className="paypal-card-header" style={{ marginBottom: 8 }}>
      <div>
        <span className="paypal-eyebrow"><CheckCircle2 size={14} aria-hidden="true" />Readability preflight</span>
        <h3>Check inputs before payment</h3>
      </div>
      <Button label="Check inputs" variant="secondary" isDisabled={busy} onClick={() => void check()} />
    </div>
    <p className="paypal-note" role="status" aria-live="polite">{status}</p>
    {result && <div className={result.ready ? "paypal-service-terms" : "paypal-notice"} role="status">
      <p style={{ margin: 0, fontWeight: 600 }}>
        {result.ready ? <CheckCircle2 size={15} style={{ verticalAlign: "text-bottom", marginRight: 6 }} aria-hidden="true" /> : <TriangleAlert size={15} style={{ verticalAlign: "text-bottom", marginRight: 6 }} aria-hidden="true" />}
        {result.ready ? "Inputs ready" : "Inputs need attention"}: {result.outputs} output{result.outputs === 1 ? "" : "s"} · {money(result.amount)} USD. This check does not create a task or approve payment.
      </p>
      {result.issues.map(issue => <p key={issue.document_index} style={{ marginTop: 6, marginBottom: 0 }}>Document {issue.document_index + 1} ({input.documents[issue.document_index]?.name}): {issue.message}</p>)}
    </div>}
    <div className="paypal-service-terms" style={{ marginTop: 14 }}>
      <span className="paypal-eyebrow"><Sparkles size={14} aria-hidden="true" />Optional AI advisor</span>
      <label htmlFor="paypal-objective" style={{ marginTop: 4 }}>What do you want to learn? (optional)</label>
      <textarea id="paypal-objective" rows={2} disabled={busy} maxLength={2000} aria-describedby="objective-limit" value={objective} onChange={e => { setObjective(e.target.value); setSuggestion(undefined); }} />
      <p id="objective-limit" className="paypal-note">{objectiveBytes} / 2000 UTF-8 bytes.</p>
      <div className="paypal-actions">
        <Button label="Suggest a service" variant="secondary" isDisabled={busy || !objective.trim() || objectiveBytes > 2000} onClick={() => void (async () => {
          const requestedObjective = objective;
          setBusy(true); setError(""); setSuggestion(undefined); setStatus("Finding a service suggestion…");
          try { const next = await api<{ service_id: string; explanation: string }>("/recommend-service", "POST", { objective }); if (!mounted.current || objectiveRef.current !== requestedObjective) return; if (!services.some(s => s.id === next.service_id)) throw new Error("Unknown suggestion. Select a service manually."); setSuggestion(next); setStatus("Service suggestion ready for your review."); }
          catch (e) { if (mounted.current && objectiveRef.current === requestedObjective) { setError(e instanceof Error ? e.message : "Suggestion unavailable. Select a service manually."); setStatus("Suggestion unavailable. Select a service manually."); } }
          finally { if (mounted.current) setBusy(false); }
        })()} />
      </div>
      {suggestion && <aside className="paypal-explanation">
        <strong>{services.find(s => s.id === suggestion.service_id)?.name}</strong>
        <p>{suggestion.explanation}</p>
        <div className="paypal-actions">
          <Button label="Use suggested service" variant="secondary" onClick={() => { onSelect(suggestion.service_id); setSuggestion(undefined); }} />
        </div>
        <p className="paypal-note">You still choose inputs, prepare the quote, and explicitly approve checkout.</p>
      </aside>}
      {error && <p className="paypal-error" role="alert">{error}</p>}
      <p className="paypal-note" style={{ marginBottom: 0 }}>Manual service selection is always available. Only your objective is sent for the optional AI suggestion.</p>
    </div>
  </div>;
}
