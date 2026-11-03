import { Inbox } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { shownMoney, type Allowance, type Merchant, type Receipt } from "./client";

/**
 * Purchases an agent asked the buyer to approve. Shared by the standalone
 * Allowances panel and the dashboard's PayPal tab, so both send the same
 * approve (with the quote digest) and deny calls.
 */
export function ApprovalInbox({ approvals, merchants, allowances, busy, onApprove, onDecline, declineLabel = "Deny" }: {
  approvals: Receipt[];
  merchants: Merchant[];
  allowances: Allowance[];
  busy: boolean;
  onApprove: (task: Receipt) => void | Promise<void>;
  onDecline: (task: Receipt) => void | Promise<void>;
  declineLabel?: string;
}) {
  if (!approvals.length) return null;
  const merchantName = (id: string) => merchants.find(m => m.id === id)?.name ?? id;
  return <div className="paypal-inbox" aria-label="Purchases waiting for approval">
    <h3><Inbox size={15} aria-hidden="true" />Waiting for you ({approvals.length})</h3>
    {approvals.map(task => <div key={task.id} className="paypal-inbox-row">
      <div>
        <strong>{merchantName(task.purchase?.merchant ?? "")} · {shownMoney(task.gross)}</strong>
        <span>{(task.purchase?.lines ?? []).map(l => `${l.qty} × ${l.name}`).join(", ")}</span>
        <small>Allowance {allowances.find(a => a.id === task.purchase?.allowance_id)?.name ?? task.purchase?.allowance_id}</small>
      </div>
      <div className="paypal-actions" style={{ margin: 0 }}>
        <Button label={`Approve ${shownMoney(task.gross)}`} isDisabled={busy} onClick={() => void onApprove(task)} />
        <Button label={declineLabel} variant="secondary" isDisabled={busy} onClick={() => void onDecline(task)} />
      </div>
    </div>)}
  </div>;
}
