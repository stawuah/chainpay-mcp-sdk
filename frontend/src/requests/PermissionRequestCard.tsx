import { Button } from "@astryxdesign/core/Button";
import type { AgentInboxItem } from "../owner/runtime";
import { buildPath } from "../routing/paths";
import {
  permissionRequestCard,
  requestReference,
  shortKey,
  type PermissionRequestRecord,
} from "./permissionRequest";
import "./permission-request.css";

/**
 * Someone else's signed ask for a spending permission, shown in Requests.
 * Its one action, Review permission, opens the existing mandate builder; the
 * only wallet prompt stays "Approve spending permission" there.
 */
export function PermissionRequestCard({
  item,
  symbolFor,
  retrying = false,
  onReview,
  onDecline,
  onRetryLink,
}: {
  item: AgentInboxItem;
  symbolFor: (mint: string) => string;
  retrying?: boolean;
  onReview: (record: PermissionRequestRecord) => void;
  onDecline: () => void;
  onRetryLink: (record: PermissionRequestRecord) => void;
}) {
  const record = item.permissionRequest;
  if (!record) return null;
  const view = permissionRequestCard(record, symbolFor);
  const archived = Boolean(item.archivedAt);

  if (view.status === "invalid") {
    return (
      <article className="permission-request-card" data-state="blocked" aria-labelledby={`permission-request-${record.requestHash}`}>
        <span className="soft-label permission-request-kicker">{view.kicker}</span>
        <h3 id={`permission-request-${record.requestHash}`}>{view.title}</h3>
        <p className="permission-request-blocked" role="alert"><b>Blocked</b><span>{view.reason}.</span></p>
        <p className="permission-request-note">Nothing from this link is shown or used. Ask the requester for a new link.</p>
        {!archived && <div className="permission-request-actions"><Button type="button" variant="secondary" label="Archive" onClick={onDecline} /></div>}
      </article>
    );
  }

  const payload = record.signed!.payload;
  const created = Boolean(record.mandateAddress);
  return (
    <article className="permission-request-card" data-state={created ? "created" : archived ? "declined" : "open"} data-role={payload.role} aria-labelledby={`permission-request-${record.requestHash}`}>
      <span className="soft-label permission-request-kicker">{view.kicker}</span>
      <h3 id={`permission-request-${record.requestHash}`}>{view.title}</h3>
      <p className="permission-request-role">{view.roleLabel}</p>
      <div className="permission-request-requester">
        {view.statedName && (
          <p className="permission-request-name">
            <span>{view.statedName}</span>
            <span className="permission-request-unverified">Not verified</span>
          </p>
        )}
        <p className="permission-request-key mono">{view.requester}</p>
        <p className="permission-request-signature"><span aria-hidden="true">✓</span> Signature valid <small>Checks the requester key only, not the name.</small></p>
      </div>
      <dl className="permission-request-rows">
        {view.rows.map((row) => (
          <div key={row.key} data-row={row.key}>
            <dt>{row.label}</dt>
            <dd className={row.mono ? "mono" : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {!record.checkedAtSlot && !created && (
        <p className="permission-request-note">The link’s expiry could not be checked against Solana just now. Days are estimated from 400 ms slots.</p>
      )}
      {created ? (
        <div className="permission-request-outcome" role="status">
          {record.link === "linked" ? (
            <p><b>Permission created · linked to {requestReference(payload)}</b></p>
          ) : (
            <>
              <p><b>Permission created.</b> The permission exists. Linking it to {requestReference(payload)} failed{record.linkError ? `: ${record.linkError}` : ""}.</p>
              <Button type="button" variant="secondary" label={retrying ? "Linking…" : "Retry link"} isDisabled={retrying} onClick={() => onRetryLink(record)} />
            </>
          )}
          <a href={buildPath({ kind: "app", tab: "mandates", mandateDetail: record.mandateAddress })}>View permission {shortKey(record.mandateAddress!)}</a>
        </div>
      ) : archived ? (
        <p className="permission-request-note">Declined. Nothing was sent to the requester.</p>
      ) : (
        <>
          <div className="permission-request-actions">
            <Button type="button" variant="primary" label="Review permission" onClick={() => onReview(record)} />
            <Button type="button" variant="secondary" label="Decline" onClick={onDecline} />
          </div>
          <p className="permission-request-note">Review opens the permission builder with these limits. You can change any of them. Decline archives it in this browser; the requester is not told.</p>
        </>
      )}
    </article>
  );
}
