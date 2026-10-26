import { useEffect, useRef, useState } from "react";
import { Gavel } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { shownMoney, type client, type Dispute, type EvidencePack } from "./client";
import { checkWords } from "./Marketplace";

export default function Disputes({ api, onOpenTask, canAct = true }: { api: ReturnType<typeof client>; onOpenTask: (taskId: string) => void; /** Sync, preview and submit are merchant actions. A buyer sees the cases read-only. */ canAct?: boolean }) {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [packs, setPacks] = useState<Record<string, EvidencePack>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  async function load() {
    const d = await api<{ disputes: Dispute[] }>("/disputes");
    if (live.current) { setDisputes(d.disputes ?? []); setLoading(false); }
  }
  useEffect(() => { live.current = true; void load().catch(e => { if (live.current) { setError(e.message); setLoading(false); } }); return () => { live.current = false; }; }, [api]);

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
        <span className="paypal-eyebrow"><Gavel size={14} aria-hidden="true" />{canAct ? "Merchant protection" : "Your purchase disputes"}</span>
        <h2>Disputes</h2>
      </div>
      {canAct && <div className="paypal-actions" style={{ margin: 0 }}>
        <Button label="Sync from PayPal" variant="secondary" isDisabled={busy} onClick={() => void act(async () => { await api("/disputes/sync", "POST", {}); })} />
      </div>}
    </div>
    {canAct ? <p className="paypal-note">Each evidence pack is built from the task record: the recorded authorization, who approved, what was delivered, and any refund. Submitting it once is final.</p>
      : <p className="paypal-note">The merchant answers a dispute with an evidence pack built from the purchase record: the recorded authorization, who approved, what was delivered, and any refund. You see where it stands here.</p>}
    {error && <p role="alert" className="paypal-error">{error}</p>}
    {loading && <p className="paypal-note" role="status">Loading disputes…</p>}
    {!loading && !error && !disputes.length && <p className="paypal-note">{canAct ? "No disputes on file. Sync pulls open cases for captured purchases." : "No disputes on your purchases."}</p>}
    {disputes.length > 0 && <div className="paypal-table-wrap">
      <table className="paypal-dispute-table">
        <thead><tr><th>Dispute</th><th>Task</th><th>Status</th><th>Stage</th><th>Reason</th><th>Amount</th>{canAct && <><th>Respond by</th><th>Evidence</th></>}</tr></thead>
        <tbody>
          {disputes.map(d => <tr key={d.id}>
            <td><code>{d.id}</code></td>
            <td><button type="button" className="paypal-link-button" onClick={() => onOpenTask(d.task_id)}>{d.task_id.slice(0, 8)}</button></td>
            <td>{d.status}</td>
            <td>{d.stage}</td>
            <td>{d.reason}</td>
            <td>{shownMoney(d.amount)}</td>
            {canAct && <><td>{when(d.seller_response_due)}</td>
            <td><span className={`paypal-pill is-${d.evidence === "submitted" ? "active" : d.evidence === "unknown" ? "paused" : "none"}`}>{d.evidence === "submitted" ? "Submitted" : d.evidence === "unknown" ? "Unknown" : "Not sent"}</span></td></>}
          </tr>)}
        </tbody>
      </table>
    </div>}
    {disputes.map(d => {
      const pack = packs[d.id];
      return <article key={d.id} className="paypal-dispute-detail">
        <div className="paypal-card-header" style={{ marginBottom: 6 }}>
          <h3>Dispute <code>{d.id}</code> · {shownMoney(d.amount)}</h3>
          {canAct && <div className="paypal-actions" style={{ margin: 0 }}>
            <Button label="Preview evidence pack" variant="secondary" isDisabled={busy} onClick={() => void act(async () => {
              const p = await api<EvidencePack>(`/disputes/${d.id}/evidence`);
              if (live.current) setPacks(old => ({ ...old, [d.id]: p }));
            })} />
            {d.evidence === "none" && <Button label="Submit evidence pack" isDisabled={busy || !pack} onClick={() => void act(async () => {
              if (!pack) return;
              await api(`/disputes/${d.id}/evidence`, "POST", { digest: pack.digest });
            })} />}
          </div>}
        </div>
        <dl className="paypal-dispute-summary">
          <div><dt>Status</dt><dd>{d.status.toLowerCase().replaceAll("_", " ")}</dd></div>
          <div><dt>Stage</dt><dd>{d.stage.toLowerCase().replaceAll("_", " ")}</dd></div>
          <div><dt>Reason</dt><dd>{d.reason.toLowerCase().replaceAll("_", " ")}</dd></div>
          {canAct && <><div><dt>Respond by</dt><dd>{when(d.seller_response_due)}</dd></div><div><dt>Evidence</dt><dd>{d.evidence === "submitted" ? "Submitted" : d.evidence === "unknown" ? "Unknown" : "Not sent"}</dd></div></>}
        </dl>
        <Button label="View purchase receipt" variant="secondary" onClick={() => onOpenTask(d.task_id)} />
        {canAct && d.evidence === "submitted" && <p className="paypal-note">Evidence submitted {when(d.evidence_submitted_at)} · digest <code>{d.evidence_digest}</code></p>}
        {canAct && d.evidence === "unknown" && <p className="paypal-notice">The submission did not confirm. Do not resend; sync again to learn what PayPal recorded.</p>}
        {pack && <dl className="paypal-evidence">
          <div><dt>Capture</dt><dd><code>{pack.capture_id}</code></dd></div>
          <div><dt>Allowance</dt><dd>{pack.allowance.name ?? "unknown"} · rule <code>{pack.allowance.rule ?? "none"}</code></dd></div>
          <div><dt>Rule checks</dt><dd>{(pack.allowance.checks ?? []).map(c => `${c.rule}: ${checkWords(c)}`).join("; ") || "None recorded"}</dd></div>
          <div><dt>Approval</dt><dd>{pack.approval ? `${pack.approval.approval} by ${pack.approval.approved_by ?? "buyer"} ${when(pack.approval.approval_decided_at)}` : "No per-purchase approval recorded"}</dd></div>
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
