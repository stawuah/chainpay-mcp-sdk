import { useState } from "react";
import { SectionHeader } from "../../ui/workspace/SectionHeader";
import { Button } from "@astryxdesign/core/Button";
import { CircleCheck, CircleHelp, CircleX, Cpu, Eye, EyeOff, Globe } from "lucide-react";
import type { CardAttestationView, CardView } from "@chainpay/sdk";
import type { CardsSource, PrivacyCheckResult, ReadResult } from "./source";
import { errorText } from "./shared";
import { UnlockStrip } from "./Unlock";
import { PRIVACY_COPY } from "./privacyCopy";
import { formatWhen, shortKey } from "./ui";

export const ATTESTATION_VERIFIED_COPY = "Genuine TDX hardware and expected MagicBlock build verified (Devnet).";

/** True only when both halves passed: Intel's signature chain and the pinned MagicBlock build. */
export function attestationPassed(attestation: PrivacyCheckResult["attestation"]): boolean {
  return attestation.hardware === "verified" && attestation.measurements === "matched";
}

/** Says that this check is the browser's own and pauses nothing (the approver runs its own, below). */
export const BROWSER_CHECK_NOTE = "This check ran in your browser. It doesn't pause anything; ChainPay's approver runs its own check before approving purchases.";

const BUILD_COPY: Record<PrivacyCheckResult["attestation"]["measurements"], string> = {
  matched: "It answered with MagicBlock's expected Devnet build.",
  mismatch: "It's running a build that isn't MagicBlock's confirmed Devnet build.",
  unavailable: "Its build couldn't be checked.",
  pending: "There were no expected build values to compare against.",
};

/**
 * Attestation line for the proof panel (contracts CD-6), built from what was actually
 * checked (hardware × build), never from a label. Never claims more than was checked,
 * and never says approvals were paused: this browser check doesn't pause anything.
 */
export function attestationCopy(attestation: PrivacyCheckResult["attestation"]): string {
  if (attestationPassed(attestation)) return ATTESTATION_VERIFIED_COPY;
  if (attestation.hardware === "failed") return "Couldn't confirm the private rollup runs on genuine secure hardware.";
  if (attestation.hardware === "not_checked") return "This browser couldn't run the hardware check.";
  const hardware = attestation.hardware === "verified"
    ? "Intel's hardware signature checked out."
    : "The private rollup answered a fresh challenge, but Intel's hardware signature wasn't checked here.";
  return `${hardware} ${BUILD_COPY[attestation.measurements] ?? BUILD_COPY.unavailable}`;
}

export type ApproverAttestation = {
  mode: "enforce" | "report" | "unknown";
  hardware: "verified" | "failed" | "not_checked";
  measurements: PrivacyCheckResult["attestation"]["measurements"];
  checkedAt: string | null;
};

/**
 * Axum's own attestation (the one that gates approvals), normalized in one place:
 * Axum says `match` and `unchecked` where the browser check says `matched` and
 * `not_checked`. Anything unrecognized reads as not checked, never as passed.
 */
export function normalizeApproverAttestation(raw: CardAttestationView | undefined | null): ApproverAttestation | null {
  if (!raw || typeof raw !== "object") return null;
  const measurements = raw.measurements === "match" || raw.measurements === "matched" ? "matched"
    : raw.measurements === "mismatch" ? "mismatch"
      : raw.measurements === "pending" ? "pending" : "unavailable";
  const hardware = raw.hardware === "verified" ? "verified" : raw.hardware === "failed" ? "failed" : "not_checked";
  const mode = raw.mode === "enforce" ? "enforce" : raw.mode === "report" ? "report" : "unknown";
  return { mode, hardware, measurements, checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null };
}

/** True only when the approver's check passed in enforce mode, the one setting where a failure stops approvals. */
export function approverAttestationPassed(a: ApproverAttestation | null): boolean {
  return Boolean(a && a.mode === "enforce" && a.hardware === "verified" && a.measurements === "matched");
}

export function approverAttestationCopy(a: ApproverAttestation | null): string {
  if (!a) return "ChainPay's approver hasn't reported its own hardware check for this card yet.";
  const hardware = a.hardware === "verified" ? "Intel's hardware signature verified" : a.hardware === "failed" ? "the hardware check failed" : "the hardware wasn't checked";
  const build = a.measurements === "matched" ? "MagicBlock's expected build" : a.measurements === "mismatch" ? "a build that isn't MagicBlock's confirmed one" : a.measurements === "pending" ? "no expected build to compare" : "a build it couldn't read";
  const mode = a.mode === "enforce"
    ? "Purchases are declined while this check fails."
    : a.mode === "report"
      ? "Report only: purchases are still approved when this check fails."
      : "It didn't say whether a failure stops purchases.";
  return `ChainPay's approver checks the private rollup before approving purchases: ${hardware}, ${build}. ${mode}`;
}

function AttestationIcon({ attestation }: { attestation: PrivacyCheckResult["attestation"] }) {
  if (attestationPassed(attestation)) return <CircleCheck size={16} aria-hidden="true" />;
  if (attestation.hardware === "failed" || attestation.measurements === "mismatch") return <CircleX size={16} aria-hidden="true" />;
  return <Cpu size={16} aria-hidden="true" />;
}

/** A null answer means "this wallet can't see it", never "the card is missing" (contracts CD-4). */
export function readVerdict(read: ReadResult): string {
  if (read.state === "not_visible") return "Hidden from this wallet";
  if (read.state === "visible") return "Readable";
  return "No clean answer";
}

function ReadRow({ read }: { read: ReadResult }) {
  const Icon = read.state === "visible" ? Eye : read.state === "not_visible" ? EyeOff : CircleHelp;
  return (
    <li data-read={read.state}>
      <Icon size={16} aria-hidden="true" />
      <div>
        <b>{read.label}: {readVerdict(read)}</b>
        <code>{read.raw}</code>
        {read.summary && <small>{read.summary}</small>}
      </div>
    </li>
  );
}

export function CardPrivacyCheck({ source, card, unlocked, onUnlocked }: { source: CardsSource; card: CardView; unlocked: boolean; onUnlocked: () => void }) {
  const [result, setResult] = useState<PrivacyCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      setResult(await source.privacyCheck(card));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const strangerHidden = result?.stranger.reads.every((read) => read.state === "not_visible");
  return (
    <section className="cp-privacy" data-testid="privacy-check">
      <div className="cp-surface cp-cards-surface">
        <SectionHeader
          title="Read as another wallet"
          description="Opens a brand-new wallet in this browser and asks for the same card. Run it as often as you like; nothing is saved."
          action={<Button type="button" variant="primary" label={busy ? "Checking…" : result ? "Run again" : "Run the check"} isDisabled={busy || !unlocked} onClick={() => void run()} />}
        />
        {!unlocked && <UnlockStrip source={source} onUnlocked={onUnlocked} compact />}
        {error && <div className="builder-error" role="alert"><b>The check didn't finish</b><span>{error}</span></div>}
        {result && (
          <>
            <div className="cp-privacy-grid" data-testid="privacy-grid">
              <article data-column="owner">
                <h3><Eye size={16} aria-hidden="true" /> You</h3>
                <ul>{result.owner.map((read) => <ReadRow key={read.label} read={read} />)}</ul>
              </article>
              <article data-column="stranger" data-hidden={strangerHidden ? "yes" : "no"}>
                <h3><EyeOff size={16} aria-hidden="true" /> Another wallet</h3>
                <small className="mono">{shortKey(result.stranger.wallet)} · made just now</small>
                <ul>{result.stranger.reads.map((read) => <ReadRow key={read.label} read={read} />)}</ul>
              </article>
              <article data-column="public" data-public={result.publicChain.state}>
                <h3><Globe size={16} aria-hidden="true" /> Public chain</h3>
                <small className="mono">{shortKey(result.publicChain.address)}</small>
                <ul>
                  <li data-read={result.publicChain.state === "empty" ? "not_visible" : result.publicChain.state === "has_data" ? "visible" : "rpc_error"}>
                    {result.publicChain.state === "empty" ? <EyeOff size={16} aria-hidden="true" /> : <CircleHelp size={16} aria-hidden="true" />}
                    <div>
                      <b>{result.publicChain.state === "empty" ? "No limits on Solana" : result.publicChain.state === "has_data" ? `${result.publicChain.nonZeroAfterOwnerLink} non-zero bytes after the owner link` : result.publicChain.state === "missing" ? "Couldn't find the card's public account, so nothing was checked" : "Couldn't read the public account, so nothing was checked"}</b>
                      {result.publicChain.preview && <code>{result.publicChain.preview}</code>}
                    </div>
                  </li>
                </ul>
              </article>
            </div>
            <p className="cp-null-note" data-testid="null-note">Null means this wallet can't see it. It doesn't mean the card is missing. {PRIVACY_COPY}</p>
            <p className="cp-attestation" data-testid="attestation" data-passed={attestationPassed(result.attestation) ? "true" : "false"} data-hardware={result.attestation.hardware} data-measurements={result.attestation.measurements}>
              <AttestationIcon attestation={result.attestation} />
              <span>
                {attestationCopy(result.attestation)}
                {result.attestation.provenance && (result.attestation.measurements === "matched" || result.attestation.measurements === "mismatch") && (
                  <small className="cp-attestation-source">Expected build values: {result.attestation.provenance}.</small>
                )}
              </span>
            </p>
            <small className="owner-muted" data-testid="browser-check-note">{BROWSER_CHECK_NOTE}</small>
            <small className="owner-muted">Checked {formatWhen(result.checkedAt)}</small>
          </>
        )}
        <ApproverAttestationLine card={card} />
      </div>
    </section>
  );
}

function ApproverAttestationLine({ card }: { card: CardView }) {
  const approver = normalizeApproverAttestation(card.attestation);
  const passed = approverAttestationPassed(approver);
  return (
    <p className="cp-attestation" data-testid="approver-attestation" data-passed={passed ? "true" : "false"} data-mode={approver?.mode ?? "none"}>
      {passed ? <CircleCheck size={16} aria-hidden="true" /> : approver?.hardware === "failed" || approver?.measurements === "mismatch" ? <CircleX size={16} aria-hidden="true" /> : <Cpu size={16} aria-hidden="true" />}
      <span>
        {approverAttestationCopy(approver)}
        {approver?.checkedAt && <small className="cp-attestation-source">Last checked {formatWhen(approver.checkedAt)}.</small>}
      </span>
    </p>
  );
}
