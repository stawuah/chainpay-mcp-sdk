// Settings → Webhooks: owner endpoints for signed `payment.receipt_ready`
// events (docs/guides/owner-webhooks.md). Developer-facing and compact. The
// copy stays honest about delivery: verified receipts only, at least once, on
// a schedule (minutes, not instant), dedupe by webhook-id.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Copy, Plus, RefreshCw } from "lucide-react";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SectionHeader } from "../../ui/workspace/SectionHeader";
import { Status, statusFor, type StatusProps } from "../../ui/workspace/Status";
import { shortAddress } from "../../ui/marks";
import { copyValue } from "../../owner/runtime";
import { WebhooksOffError, webhooksSource, type WebhookDelivery, type WebhookEndpoint, type WebhookList } from "./source";
import "./webhooks.css";

export const WEBHOOKS_GUIDE_URL = "https://github.com/stawuah/chainpay-mcp-sdk/blob/master/docs/guides/owner-webhooks.md";

type Load = { kind: "loading" } | { kind: "off" } | { kind: "error"; message: string } | { kind: "ready"; list: WebhookList };
type Secret = { endpointId: string; value: string; previousUntil: number | null; rotated: boolean };
type Confirm = { kind: "disable" | "rotate"; endpoint: WebhookEndpoint } | null;

const time = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function deliveryStatus(delivery: WebhookDelivery, maxAttempts: number): StatusProps {
  switch (delivery.state) {
    case "delivered":
      return statusFor("settled", "Delivered", delivery.delivered_at_ms ? `Delivered ${time(delivery.delivered_at_ms)}` : undefined);
    case "retry_scheduled":
      return statusFor("review", "Retrying", delivery.next_attempt_at_ms ? `Next try around ${time(delivery.next_attempt_at_ms)}` : undefined);
    case "exhausted":
      return statusFor("failed", "Gave up", `Stopped after ${delivery.attempts} of ${maxAttempts} tries`);
    case "delivering":
      return statusFor("pending", "Sending");
    case "pending":
      return statusFor("pending", "Queued", "Goes out on the next scheduled run");
    default:
      return statusFor("unknown", "Unknown");
  }
}

function DeliveryRows({ endpoint, maxAttempts }: { endpoint: WebhookEndpoint; maxAttempts: number }) {
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setRows(await webhooksSource().deliveries(endpoint.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't load deliveries."); }
  }, [endpoint.id]);
  useEffect(() => { void load(); }, [load]);
  const resend = async (delivery: WebhookDelivery) => {
    setBusy(delivery.id); setError("");
    try {
      const updated = await webhooksSource().redeliver(delivery.id);
      setRows((current) => current?.map((row) => row.id === updated.id ? updated : row) ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't queue it again."); }
    finally { setBusy(""); }
  };
  if (error && !rows) return <div className="cp-webhooks-deliveries"><p role="alert">{error}</p><Button label="Try again" variant="secondary" size="sm" onClick={() => void load()} /></div>;
  if (!rows) return <div className="cp-webhooks-deliveries"><p className="cp-webhooks-muted" aria-busy="true">Loading deliveries…</p></div>;
  return <div className="cp-webhooks-deliveries">
    {rows.length === 0 ? <p className="cp-webhooks-muted">No deliveries yet. They show up after your next verified payment.</p> : <ul aria-label={`Recent deliveries to ${endpoint.url}`}>
      {rows.map((delivery) => {
        const detail = [
          `${delivery.attempts} ${delivery.attempts === 1 ? "try" : "tries"}`,
          delivery.last_status ? `HTTP ${delivery.last_status}` : null,
          delivery.state === "retry_scheduled" && delivery.next_attempt_at_ms ? `next ~${time(delivery.next_attempt_at_ms)}` : null,
        ].filter(Boolean).join(" · ");
        const canResend = endpoint.status === "active" && ["delivered", "retry_scheduled", "exhausted"].includes(delivery.state);
        return <li key={delivery.id} className="cp-webhooks-delivery">
          <div className="cp-webhooks-delivery-body">
            <div className="cp-webhooks-delivery-main">
              <Status {...deliveryStatus(delivery, maxAttempts)} />
              <a href={`/verify/${encodeURIComponent(delivery.receipt_address)}`}>Receipt {shortAddress(delivery.receipt_address)}</a>
              <span className="cp-webhooks-muted">{time(delivery.created_at_ms)}</span>
            </div>
            <p className="cp-webhooks-muted">{detail}{delivery.last_error && delivery.state !== "delivered" ? ` · ${delivery.last_error}` : ""}</p>
            <p className="cp-webhooks-id"><span>webhook-id</span> <code>{delivery.event_id}</code></p>
          </div>
          {canResend && <Button label={busy === delivery.id ? "Queuing…" : "Send again"} variant="secondary" size="sm" isDisabled={busy === delivery.id} onClick={() => void resend(delivery)} />}
        </li>;
      })}
    </ul>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function WebhooksSection({ sessionReady, onSignIn }: { sessionReady: boolean; onSignIn: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [copied, setCopied] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [actionError, setActionError] = useState("");
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const run = ++generation.current;
    setLoad((current) => current.kind === "ready" ? current : { kind: "loading" });
    try {
      const list = await webhooksSource().list();
      if (run === generation.current) setLoad({ kind: "ready", list });
    } catch (cause) {
      if (run !== generation.current) return;
      setLoad(cause instanceof WebhooksOffError ? { kind: "off" } : { kind: "error", message: cause instanceof Error ? cause.message : "Couldn't load your webhooks." });
    }
  }, []);
  useEffect(() => { if (sessionReady) void refresh(); }, [sessionReady, refresh]);

  const add = async () => {
    setSaving(true); setFormError("");
    try {
      const created = await webhooksSource().create(url.trim(), label.trim() || null);
      setSecret({ endpointId: created.subscription.id, value: created.secret, previousUntil: null, rotated: false });
      setAdding(false); setUrl(""); setLabel("");
      await refresh();
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : "Couldn't add that endpoint."); }
    finally { setSaving(false); }
  };
  const act = async (pending: NonNullable<Confirm>) => {
    setConfirm(null); setActionError("");
    try {
      if (pending.kind === "disable") await webhooksSource().disable(pending.endpoint.id);
      else {
        const rotated = await webhooksSource().rotate(pending.endpoint.id);
        setSecret({ endpointId: pending.endpoint.id, value: rotated.secret, previousUntil: rotated.previous_secret_expires_at_ms, rotated: true });
      }
      await refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "That didn't go through. Try again."); }
  };

  const list = load.kind === "ready" ? load.list : null;
  const active = list?.subscriptions.filter((s) => s.status === "active").length ?? 0;
  const atCap = list ? active >= list.max_active : true;
  const header = <SectionHeader title="Webhooks" description="A signed POST to your server when a payment's receipt is verified." action={list && !adding ? <Button label="Add endpoint" variant="secondary" icon={<Plus size={16} />} isDisabled={atCap} onClick={() => { setAdding(true); setFormError(""); }} /> : undefined} />;
  const note = <p className="cp-webhooks-note">Verified receipts only. Sent at least once, on a schedule — usually within minutes, never instant. Dedupe by <code>webhook-id</code>. <a href={WEBHOOKS_GUIDE_URL} target="_blank" rel="noreferrer">Verify signatures</a></p>;

  if (!sessionReady) return <section className="cp-surface cp-webhooks" aria-label="Webhooks">{header}<div className="owner-settings-row"><div><strong>Sign in to manage webhooks</strong><p>Signing in never approves a payment.</p></div><Button label="Sign in" variant="secondary" onClick={onSignIn} /></div></section>;
  if (load.kind === "off") return <section className="cp-surface cp-webhooks" aria-label="Webhooks">{header}<div className="owner-settings-row"><div><strong>Not switched on yet</strong><p>This relay isn't sending webhooks. Nothing here can be saved until it does.</p></div></div></section>;
  if (load.kind === "error") return <section className="cp-surface cp-webhooks" aria-label="Webhooks">{header}<div className="owner-settings-row"><div><strong>Couldn't load your webhooks</strong><p role="alert">{load.message}</p></div><Button label="Try again" variant="secondary" icon={<RefreshCw size={16} />} onClick={() => void refresh()} /></div></section>;
  if (load.kind === "loading") return <section className="cp-surface cp-webhooks" aria-label="Webhooks" aria-busy="true">{header}<p className="cp-webhooks-muted">Loading webhooks…</p></section>;
  const ready = load.list;

  return <section className="cp-surface cp-webhooks" aria-label="Webhooks">
    {header}
    {note}
    {secret && <div className="cp-webhooks-secret" role="status">
      <strong>{secret.rotated ? "Your new signing secret" : "Your signing secret"}</strong>
      <p>Copy it now. You won't see it again.{secret.rotated && secret.previousUntil ? ` Your old secret keeps signing until ${time(secret.previousUntil)}, so you can swap without missing events.` : ""}</p>
      <code className="cp-webhooks-secret-value">{secret.value}</code>
      <div className="cp-webhooks-actions">
        <Button label={copied === secret.value ? "Copied" : "Copy secret"} variant="secondary" icon={<Copy size={16} />} onClick={() => void copyValue(secret.value).then((ok) => setCopied(ok ? secret.value : ""))} />
        <Button label="I saved it" variant="primary" onClick={() => { setSecret(null); setCopied(""); }} />
      </div>
    </div>}
    {adding && <form className="cp-webhooks-form" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <TextInput label="Endpoint URL" value={url} onChange={setUrl} placeholder="https://hooks.example.com/chainpay" />
      <TextInput label="Label (optional)" value={label} onChange={setLabel} placeholder="Bookkeeping" />
      <p className="cp-webhooks-muted">HTTPS on a public address. Localhost and private networks are blocked.</p>
      {formError && <p role="alert">{formError}</p>}
      <div className="cp-webhooks-actions">
        <Button type="submit" label={saving ? "Adding…" : "Add endpoint"} variant="primary" isDisabled={saving || !url.trim()} />
        <Button label="Cancel" variant="secondary" isDisabled={saving} onClick={() => { setAdding(false); setFormError(""); }} />
      </div>
    </form>}
    {ready.subscriptions.length === 0 && !adding ? <div className="owner-settings-row"><div><strong>No endpoints yet</strong><p>Add an HTTPS URL and your server hears about every verified receipt.</p></div></div> : <ul className="cp-webhooks-list" aria-label="Webhook endpoints">
      {ready.subscriptions.map((endpoint) => <li key={endpoint.id} className="cp-webhooks-endpoint" data-status={endpoint.status}>
        <div className="cp-webhooks-endpoint-head">
          <div className="cp-webhooks-endpoint-text">
            {endpoint.description && <strong>{endpoint.description}</strong>}
            <code className="cp-webhooks-url">{endpoint.url}</code>
            <span className="cp-webhooks-muted">Added {time(endpoint.created_at_ms)}{endpoint.previous_secret_expires_at_ms ? ` · old secret signs until ${time(endpoint.previous_secret_expires_at_ms)}` : ""}</span>
          </div>
          <Status {...(endpoint.status === "active" ? statusFor("active", "Active") : statusFor("paused", "Disabled", "Nothing is sent to this endpoint"))} />
        </div>
        <div className="cp-webhooks-actions">
          <Button label={open === endpoint.id ? "Hide deliveries" : "Deliveries"} variant="secondary" size="sm" aria-expanded={open === endpoint.id} onClick={() => setOpen(open === endpoint.id ? null : endpoint.id)} />
          {endpoint.status === "active" && <Button label="Rotate secret" variant="secondary" size="sm" onClick={() => setConfirm({ kind: "rotate", endpoint })} />}
          {endpoint.status === "active" && <Button label="Disable" variant="destructive" size="sm" onClick={() => setConfirm({ kind: "disable", endpoint })} />}
        </div>
        {open === endpoint.id && <DeliveryRows endpoint={endpoint} maxAttempts={ready.max_attempts} />}
      </li>)}
    </ul>}
    <p className="cp-webhooks-muted cp-webhooks-cap">{active} of {ready.max_active} active{atCap ? " · disable one to add another" : ""}</p>
    {actionError && <p role="alert">{actionError}</p>}
    <ConfirmDialog open={confirm?.kind === "rotate"} title="Rotate the signing secret?" description="You get a new secret, shown once. The old one keeps signing for 24 hours so nothing is missed while you swap." confirmLabel="Rotate secret" onClose={() => setConfirm(null)} onConfirm={() => { if (confirm) void act(confirm); }} />
    <ConfirmDialog open={confirm?.kind === "disable"} title="Disable this endpoint?" description="Nothing else gets sent to it and queued deliveries stop. A request already on its way can't be called back. To use it again, add it as a new endpoint." confirmLabel="Disable endpoint" onClose={() => setConfirm(null)} onConfirm={() => { if (confirm) void act(confirm); }} />
  </section>;
}
