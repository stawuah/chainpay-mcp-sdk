import { Clock3, Lock, Snowflake, TriangleAlert } from "lucide-react";
import type { CardView } from "@chainpayhq/sdk";
import { CONNECTION_PATH } from "../../brand/Brand";
import { CARD_ISSUER_ENV, type CardIssuerEnvironment } from "../../config/public";
import { cardStatus } from "./lifecycle";
import { Money } from "./ui";
import "./agent-card.css";

/*
 * The card object (premium ruling P1/P2). Pure CSS + inline SVG. It shows the
 * owner's label and the last four the issuer reported, nothing else: never a
 * full number, expiry or CVV, and no card-network logo. Frozen cards are
 * frosted, and the frost is redundant coding: the freeze lines and the status
 * pill around it always carry the same fact in words.
 *
 * While the issuer is a sandbox (Lithic sandbox today) the face carries a
 * small "Sandbox" mark, so a screenshot of the card never reads as a live
 * card. There is no card back and no flip (nothing honest to put there).
 */

export type AgentCardFrost = "none" | "frozen" | "freeze_pending" | "needs_restore";

export function frostFor(card: CardView): AgentCardFrost {
  const key = cardStatus(card).key;
  if (key === "needs_restore") return "needs_restore";
  if (key === "freeze_pending") return "freeze_pending";
  if (key === "frozen" || key === "freeze_failed") return "frozen";
  return "none";
}

function LogoTile() {
  return (
    <span className="cp-agent-card-logo" aria-hidden="true">
      <svg viewBox="0 0 180 180" fill="none" stroke="currentColor" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        <path d={CONNECTION_PATH} /><path d={CONNECTION_PATH} transform="rotate(180 90 90)" />
      </svg>
    </span>
  );
}

function Contactless() {
  return (
    <svg className="cp-agent-card-wave" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M8.5 8.5a5 5 0 0 1 0 7" /><path d="M12 6a8.5 8.5 0 0 1 0 12" /><path d="M15.5 3.5a12 12 0 0 1 0 17" />
    </svg>
  );
}

export type AgentCardProps = {
  label: string;
  /** From the issuer. Absent while the card is still being created. */
  lastFour?: string;
  frost?: AgentCardFrost;
  /** Exact cents left this period, or null while the limits are private to this viewer. */
  leftCents?: string | bigint | null;
  size?: "mini" | "standard";
  /** Short caption under the face's top-right corner while creating. */
  pendingNote?: string;
  /** Issuer environment. Defaults to VITE_CHAINPAY_CARD_ISSUER_ENV (sandbox unless it says production). */
  issuerEnvironment?: CardIssuerEnvironment;
  className?: string;
};

const FROST_COPY: Record<Exclude<AgentCardFrost, "none">, { icon: typeof Snowflake; label: string; sub?: string }> = {
  frozen: { icon: Snowflake, label: "Frozen" },
  freeze_pending: { icon: Snowflake, label: "Frozen", sub: "Card network confirming" },
  needs_restore: { icon: TriangleAlert, label: "Needs restore" },
};

export function AgentCard({ label, lastFour, frost = "none", leftCents = null, size = "standard", pendingNote, issuerEnvironment = CARD_ISSUER_ENV, className }: AgentCardProps) {
  const sandbox = issuerEnvironment === "sandbox";
  const digits = lastFour && /^\d{4}$/.test(lastFour) ? lastFour : "····";
  const frostCopy = frost === "none" ? null : FROST_COPY[frost];
  const FrostIcon = frostCopy?.icon;
  const description = `${label || "New card"}, ${sandbox ? "sandbox " : ""}card ending ${lastFour ?? "not issued yet"}${frostCopy ? `, ${frostCopy.label.toLowerCase()}` : ""}`;

  if (size === "mini") {
    return (
      <span className={`cp-agent-card is-mini${frost !== "none" ? " is-frosted" : ""}${className ? ` ${className}` : ""}`} data-frost={frost} data-issuer-env={issuerEnvironment} aria-hidden="true">
        <span className="cp-agent-card-face">
          <LogoTile />
          <span className="cp-agent-card-digits">{digits}</span>
        </span>
        {frost !== "none" && <span className="cp-agent-card-frost"><Snowflake size={12} strokeWidth={2.2} /></span>}
      </span>
    );
  }

  return (
    <figure className={`cp-agent-card${frost !== "none" ? " is-frosted" : ""}${className ? ` ${className}` : ""}`} data-frost={frost} data-issuer-env={issuerEnvironment} aria-label={description} role="img">
      <span className="cp-agent-card-face">
        <span className="cp-agent-card-top">
          <span className="cp-agent-card-brand"><LogoTile /><span className="cp-agent-card-word">chainpay</span></span>
          <span className="cp-agent-card-limit">
            {leftCents === null || leftCents === undefined
              ? <><Lock size={11} strokeWidth={2.4} /> {pendingNote ?? "Private"}</>
              : <>Left <Money cents={leftCents} /></>}
          </span>
        </span>
        <span className="cp-agent-card-mid">
          <span className="cp-agent-card-chip"><i /><i /><i /></span>
          <Contactless />
          {sandbox && <span className="cp-agent-card-sandbox" data-testid="card-sandbox-mark">Sandbox</span>}
        </span>
        <span className="cp-agent-card-bottom">
          <span className="cp-agent-card-name">{label || "Name your card"}</span>
          <span className="cp-agent-card-number">
            <span className="cp-agent-card-digits"><span aria-hidden="true">••••</span> {digits}</span>
            <small>Virtual</small>
          </span>
        </span>
      </span>
      {frostCopy && FrostIcon && (
        <span className="cp-agent-card-frost">
          <span className="cp-agent-card-frost-badge">
            <FrostIcon size={16} strokeWidth={2.2} />
            <b>{frostCopy.label}</b>
            {frostCopy.sub && <small><Clock3 size={12} strokeWidth={2.2} /> {frostCopy.sub}</small>}
          </span>
        </span>
      )}
    </figure>
  );
}
