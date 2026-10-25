import { useEffect, useRef, useState } from "react";
import { Gavel } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { shownMoney, type client, type Dispute, type EvidencePack } from "./client";
import { checkWords } from "./Marketplace";

export default function Disputes({ api, onOpenTask }: { api: ReturnType<typeof client>; onOpenTask: (taskId: string) => void }) {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [packs, setPacks] = useState<Record<string, EvidencePack>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  async function load() {
    const d = await api<{ disputes: Dispute[] }>("/disputes");
    if (live.current) setDisputes(d.disputes ?? []);
  }
  useEffect(() => { live.current = true; void load().catch(e => { if (live.current) setError(e.message); }); return () => { live.current = false; }; }, [api]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); await load(); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Unavailable; keep the original operation"); }
    finally { if (live.current) setBusy(false); }
  }
  const when = (s?: number | null) => s ? new Date(s * 1000).toLocaleString() : "—";

  return <section className="paypal-card paypal-disputes" aria-label="PayPal disputes">
    <div className="paypal-card-header">
      <div>
        <span className="paypal-eyebrow"><Gavel size={14} aria-hidden="true" />Merchant protection</span>
        <h2>Disputes</h2>
      </div>
      <div className="paypal-actions" style={{ margin: 0 }}>
        <Button label="Sync from PayPal" variant="secondary" isDisabled={busy} onClick={() => void act(async () => { await api("/disputes/sync", "POST", {}); })} />
      </div>
    </div>
    <p className="paypal-note">Each evidence pack is built from the task record: the allowance rules that passed, who approved, what was delivered, and any refund. Submitting it once is final.</p>
    {error && <p role="alert" className="paypal-error">{error}</p>}
    {!disputes.length && <p className="paypal-note">No disputes on file. Sync pulls open cases for captured purchases.</p>}
    {disputes.length > 0 && <div className="paypal-table-wrap">
      <table className="paypal-dispute-table">
        <thead><tr><th>Dispute</th><th>Task</th><th>Status</th><th>Stage</th><th>Reason</th><th>Amount</th><th>Respond by</th><th>Evidence</th></tr></thead>
        <tbody>
          {disputes.map(d => <tr key={d.id}>
            <td><code>{d.id}</code></td>
            <td><button type="button" className="paypal-link-button" onClick={() => onOpenTask(d.task_id)}>{d.task_id.slice(0, 8)}</button></td>
            <td>{d.status}</td>
            <td>{d.stage}</td>
            <td>{d.reason}</td>
            <td>{shownMoney(d.amount)}</td>
            <td>{when(d.seller_response_due)}</td>
            <td><span className={`paypal-pill is-${d.evidence === "submitted" ? "active" : d.evidence === "unknown" ? "paused" : "none"}`}>{d.evidence === "submitted" ? "Submitted" : d.evidence === "unknown" ? "Unknown" : "Not sent"}</span></td>
          </tr>)}
        </tbody>
      </table>
    </div>}
    {disputes.map(d => {
      const pack = packs[d.id];
      return <article key={d.id} className="paypal-dispute-detail">
        <div className="paypal-card-header" style={{ marginBottom: 6 }}>
          <h3>Dispute <code>{d.id}</code> · {shownMoney(d.amount)}</h3>
          <div className="paypal-actions" style={{ margin: 0 }}>
            <Button label="Preview evidence pack" variant="secondary" isDisabled={busy} onClick={() => void act(async () => {
              const p = await api<EvidencePack>(`/disputes/${d.id}/evidence`);
              if (live.current) setPacks(old => ({ ...old, [d.id]: p }));
            })} />
            {d.evidence === "none" && <Button label="Submit evidence pack" isDisabled={busy || !pack} onClick={() => void act(async () => {
              if (!pack) return;
              await api(`/disputes/${d.id}/evidence`, "POST", { digest: pack.digest });
            })} />}
          </div>
        </div>
        {d.evidence === "submitted" && <p className="paypal-note">Evidence submitted {when(d.evidence_submitted_at)} · digest <code>{d.evidence_digest}</code></p>}
        {d.evidence === "unknown" && <p className="paypal-notice">The submission did not confirm. Do not resend; sync again to learn what PayPal recorded.</p>}
        {pack && <dl className="paypal-evidence">
          <div><dt>Capture</dt><dd><code>{pack.capture_id}</code></dd></div>
          <div><dt>Allowance</dt><dd>{pack.allowance.name ?? "unknown"} · rule <code>{pack.allowance.rule ?? "none"}</code></dd></div>
          <div><dt>Rule checks</dt><dd>{(pack.allowance.checks ?? []).map(c => `${c.rule}: ${checkWords(c)}`).join("; ") || "None recorded"}</dd></div>
          <div><dt>Approval</dt><dd>{pack.approval ? `${pack.approval.approval} by ${pack.approval.approved_by ?? "buyer"} ${when(pack.approval.approval_decided_at)}` : "Agent paid within the allowance; no per-purchase approval"}</dd></div>
          <div><dt>Delivery</dt><dd>{pack.delivery.map(u => `unit ${u.unit + 1} ${u.state}${u.delivered_at ? ` ${when(u.delivered_at)}` : ""}`).join("; ") || "No delivery recorded"}</dd></div>
          <div><dt>Refunds</dt><dd>{pack.refunds.length ? pack.refunds.map(r => `${shownMoney(r.amount)} ${r.confirmed ? "confirmed" : "pending"}`).join("; ") : "None"}</dd></div>
          <div><dt>Receipt digest</dt><dd><code>{pack.receipt_digest}</code></dd></div>
          <div><dt>Public receipt</dt><dd>{pack.public_receipt_url ? <a href={pack.public_receipt_url} target="_blank" rel="noreferrer">{pack.public_receipt_url}</a> : "Not shared"}</dd></div>
          <div><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{pack.notes}</dd></div>
          <div><dt>Pack digest</dt><dd><code>{pack.digest}</code></dd></div>
        </dl>}
      </article>;
    })}
  </section>;
}
