import { useEffect, useRef, useState } from "react";
import { Scale } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { type OutputBinding, type Receipt, type Principal, type client, shownMoney } from "./client";

export function Resolution({ receipt, principal, api, update, busy, perform }: { receipt: Receipt; principal?: Principal; api: ReturnType<typeof client>; update: (r: Receipt) => void; busy: boolean; perform: (fn: () => Promise<void>) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<OutputBinding[]>([]);
  // Persist the same operation identity after transport uncertainty. Changed intent gets a new ID.
  const requests = useRef(new Map<string, string>());
  const path = `/tasks/${receipt.id}`;
  function mutate(route: string, body: Record<string, unknown>) {
    const intent = JSON.stringify([receipt.id, route, body]);
    const id = requests.current.get(intent) ?? crypto.randomUUID(); requests.current.set(intent, id);
    void perform(async () => {
      const result = await api<Receipt>(`${path}/${route}`, "POST", { ...body, request_id: id });
      if (requests.current.get(intent) === id) requests.current.delete(intent);
      if (route === "resolution-refunds") setSelected([]);
      update(result);
    });
  }
  const binding = (index: number) => { const u = receipt.units[index]; return { unit: index, revision: u.revision ?? 0, output_hash: u.output_hash ?? null }; };
  const reasonBytes = new TextEncoder().encode(reason).length;
  const validReason = !!reason.trim() && reasonBytes <= 2000;
  const currentDecision = (index: number) => [...(receipt.resolution ?? [])].reverse().find(e => e.intent.binding.unit === index && e.intent.binding.revision === binding(index).revision && e.intent.binding.output_hash === binding(index).output_hash && ["accept", "challenge"].includes(e.intent.action));
  const eligible = (b: OutputBinding) => {
    const u = receipt.units.find(u => u.index === b.unit);
    const reserved = receipt.legacy_refund_units?.includes(b.unit) || receipt.refunds?.some(r => r.state && r.bindings.some(v => v.unit === b.unit));
    return !!u && !reserved && (u.revision ?? 0) === b.revision && (u.output_hash ?? null) === b.output_hash && (u.state === "failed" || (u.state === "delivered" && currentDecision(b.unit)?.intent.action === "challenge"));
  };
  const validSelected = selected.filter(eligible);
  const selectionKey = JSON.stringify(validSelected);
  useEffect(() => { setSelected(s => s.filter(b => JSON.parse(selectionKey).some((v: OutputBinding) => v.unit === b.unit && v.revision === b.revision && v.output_hash === b.output_hash))); }, [selectionKey]);
  return <section className="paypal-review" aria-label="Buyer resolution">
    <span className="paypal-eyebrow"><Scale size={14} aria-hidden="true" />Revision-bound review</span>
    <h3>Review delivered outputs</h3>
    <p>Acceptance records your review of this exact output. It never waives your PayPal dispute rights. Merchant-approved rework uses the original inputs and requirements, free of charge.</p>
    {principal?.role !== "agent" && <>
      <label htmlFor="resolution-reason">Review reason</label>
      <textarea id="resolution-reason" value={reason} aria-describedby="resolution-reason-limit" onChange={e => setReason(e.target.value)} placeholder="Cite the output claim, missing source excerpt, or rework reason…" />
      <p id="resolution-reason-limit" className="paypal-note" role={reasonBytes > 2000 ? "alert" : undefined}>{reasonBytes} / 2000 UTF-8 bytes. Shorten the reason before submitting if it exceeds the limit.</p>
    </>}
    {receipt.units.map(u => {
      const current = currentDecision(u.index);
      const canResolve = eligible(binding(u.index));
      return <article key={u.index} className="paypal-resolution-unit">
        <div className="paypal-unit-title" style={{ marginBottom: 6 }}>
          <h4 style={{ margin: 0 }}>Output {u.index + 1} · revision {u.revision ?? 0}</h4>
          <p className={`paypal-unit-state ${current?.intent.action === "accept" ? "delivered" : current?.intent.action === "challenge" ? "failed" : "pending"}`} style={{ margin: 0 }}>
            {current?.intent.action === "accept" ? "Accepted by buyer" : current?.intent.action === "challenge" ? "Challenged by buyer" : "Buyer acceptance not recorded"}
          </p>
        </div>
        <div className="paypal-actions">
          {principal?.role === "buyer" && u.state === "delivered" && ["accept", "challenge"].map(action => <Button key={action} label={`${action === "accept" ? "Accept" : "Challenge"} output ${u.index + 1}`} variant={action === "accept" ? undefined : "secondary"} isDisabled={busy || !validReason} onClick={() => mutate("resolution", { binding: binding(u.index), action, reason })} />)}
          {principal?.role === "merchant" && canResolve && <>
            <Button label={`Approve free rework for output ${u.index + 1}`} variant="secondary" isDisabled={busy || !validReason || !!receipt.payment_review} onClick={() => mutate("rework", { binding: binding(u.index), action: "rework", reason })} />
            {!receipt.subscription_funding && <label style={{ display: "inline-flex", alignItems: "center", margin: 0 }}><input type="checkbox" checked={validSelected.some(b => b.unit === u.index)} onChange={e => setSelected(s => e.target.checked ? [...s, binding(u.index)] : s.filter(b => b.unit !== u.index))} />Refund output {u.index + 1}</label>}
          </>}
        </div>
        {!!receipt.revisions?.[u.index]?.length && <details>
          <summary>Original outputs and earlier revisions</summary>
          {receipt.revisions[u.index].map(r => <div key={r.revision} className="paypal-fact">
            <strong>Revision {r.revision} · {r.state}</strong>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, fontFamily: "var(--pp-mono)", margin: "8px 0" }}>{JSON.stringify(r.result, null, 2)}</pre>
            <p>{r.reason}</p>
            <code>{r.output_hash}</code>
          </div>)}
        </details>}
      </article>;
    })}
    {principal?.role === "merchant" && !receipt.subscription_funding && <div className="paypal-actions">
      <Button label="Prepare selected-output refund" variant="secondary" isDisabled={busy || !validReason || !validSelected.length || !!receipt.payment_review} onClick={() => mutate("resolution-refunds", { bindings: validSelected, reason })} />
    </div>}
    {(receipt.refunds ?? []).map(r => {
      const stale = !r.state && !r.bindings.every(eligible);
      return <article key={r.request_id} className="paypal-refund">
        <h4 style={{ marginTop: 0 }}>Refund proposal · {shownMoney(r.amount)}</h4>
        <p>Outputs {r.bindings.map(b => b.unit + 1).join(", ")} · {r.reason}</p>
        <p style={{ fontWeight: 600 }}>{r.confirmed ? "Confirmed refund" : r.state ? "Refund reserved; check original provider record" : stale ? "Proposal is stale: an output was revised, accepted, or reserved by another refund. Prepare a new eligible proposal." : "Awaiting merchant approval"}</p>
        {principal?.role === "merchant" && !r.state && <div className="paypal-actions">
          <Button label={`Approve ${shownMoney(r.amount)} selected-output refund`} isDisabled={busy || stale || !!receipt.payment_review} onClick={() => mutate("resolution-refunds/approve", { digest: r.digest })} />
        </div>}
      </article>;
    })}
    <h4>Private decision history</h4>
    <ol className="paypal-decision-list">
      {(receipt.resolution ?? []).map((e, i) => <li key={i}>{new Date(e.timestamp * 1000).toLocaleString()} · {e.role} {e.actor} · {e.intent.action} · output {e.intent.binding.unit + 1}, revision {e.intent.binding.revision}: {e.intent.reason}</li>)}
    </ol>
    {receipt.reserved_refunds && <p className="paypal-note">Reserved or confirmed refunds: {shownMoney(receipt.reserved_refunds)}. Confirmed: {shownMoney(receipt.confirmed_refunds)}.</p>}
  </section>;
}
