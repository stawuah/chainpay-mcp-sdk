import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { FileText, Lock, Receipt, Snowflake, Sun } from "lucide-react";
import type { CardActivityRow, CardEvidence, CardView } from "@chainpay/sdk";
import { ReceiptEvidenceCard } from "../../receipts/ReceiptCard";
import { activityEvidence } from "./evidence";
import { ACTIVITY_TITLES, activityPills, rowNeedsReview, type StatePill } from "./lifecycle";
import type { CardsSource } from "./source";
import { CardSharePicker } from "./CardSharePicker";
import { errorText } from "./shared";
import { CardStatus, formatWhen, Money, shortKey } from "./ui";

export function CardActivity({ source, card, rows, onChanged }: { source: CardsSource; card: CardView; rows: CardActivityRow[] | null; onChanged: () => void }) {
  const [open, setOpen] = useState<{ row: CardActivityRow; evidence: CardEvidence } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [resolving, setResolving] = useState("");
  const [error, setError] = useState("");

  async function resolve(row: CardActivityRow) {
    setResolving(row.rowId);
    setError("");
    try {
      await source.resolveException(card, row);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setResolving("");
    }
  }

  if (rows === null) return <p className="owner-muted" aria-busy="true">Loading activity…</p>;
  if (rows.length === 0) {
    return <div className="owner-small-empty"><Receipt /><h3>No activity yet</h3><p>When your agent buys something, the hold, the charge and any refund land here as separate lines.</p></div>;
  }
  return (
    <>
      {error && <div className="builder-error" role="alert"><b>Needs attention</b><span>{error}</span></div>}
      <ul className="dashboard-card cp-activity" data-testid="card-activity">
        {rows.map((row) => {
          const pills = activityPills(row);
          const evidence = activityEvidence(card, row);
          const review = rowNeedsReview(row);
          return (
            <li key={row.rowId} data-lifecycle={row.lifecycle ?? row.kind} data-review={review ? "yes" : "no"}>
              <Monogram row={row} />
              <div className="cp-activity-main">
                <b>{row.merchant ? row.merchant.displayName : ACTIVITY_TITLES[row.kind]}</b>
                <small>{row.merchant && <span className="cp-activity-kind">{ACTIVITY_TITLES[row.kind]} · </span>}{formatWhen(row.at)}{row.agent ? ` · agent ${shortKey(row.agent)}` : ""}</small>
                {pills.map((pill) => detailShown(pill) ? <small key={`${pill.key}-d`} className="cp-activity-detail">{pill.detail}</small> : null)}
              </div>
              <div className="cp-activity-pills">{pills.map((pill) => <CardStatus key={pill.key} pill={pill} detailShown={detailShown(pill)} />)}</div>
              <div className="cp-activity-amount">{row.amountCents ? <Money cents={row.amountCents} className={row.lifecycle === "declined" || row.lifecycle === "reversed" || row.lifecycle === "expired" ? "is-struck" : row.lifecycle === "refunded" ? "is-credit" : ""} /> : null}</div>
              <div className="cp-activity-actions">
                {review && <Button type="button" variant="secondary" label={resolving === row.rowId ? "Waiting for wallet…" : "Mark reviewed"} isDisabled={Boolean(resolving)} onClick={() => void resolve(row)} />}
                {evidence && <Button type="button" variant="ghost" label="Receipt" icon={<Receipt size={16} />} onClick={() => setOpen({ row, evidence })} />}
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog isOpen={Boolean(open)} onOpenChange={(next) => { if (!next) setOpen(null); }} purpose="info" width={560}>
        <Layout
          height="auto"
          header={<DialogHeader title="Card receipt" onOpenChange={(next) => { if (!next) setOpen(null); }} />}
          content={<LayoutContent>{open && <ReceiptEvidenceCard evidence={open.evidence} onShare={() => { setOpen(null); setSharing(true); }} />}</LayoutContent>}
        />
      </Dialog>
      <CardSharePicker source={source} card={card} open={sharing} onClose={() => setSharing(false)} />
    </>
  );
}

/** Warnings and declines print their detail under the row; the rest keep it on the status. */
function detailShown(pill: StatePill): boolean {
  return Boolean(pill.detail) && (pill.tone === "warning" || pill.tone === "danger");
}

const SYSTEM_ICONS: Partial<Record<CardActivityRow["kind"], typeof Snowflake>> = { freeze: Snowflake, unfreeze: Sun, policy_change: Lock, repayment: FileText };

/** Shop initials, so rows are recognizable at a glance (ruling P7). Muted when nothing was spent. */
function Monogram({ row }: { row: CardActivityRow }) {
  if (!row.merchant) {
    const Icon = SYSTEM_ICONS[row.kind] ?? Receipt;
    return <span className="cp-monogram" data-tone="system" aria-hidden="true"><Icon size={16} /></span>;
  }
  const words = row.merchant.displayName.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  const muted = row.lifecycle === "declined" || row.lifecycle === "reversed" || row.lifecycle === "expired";
  return <span className="cp-monogram" data-tone={muted ? "muted" : "shop"} aria-hidden="true">{initials}</span>;
}
