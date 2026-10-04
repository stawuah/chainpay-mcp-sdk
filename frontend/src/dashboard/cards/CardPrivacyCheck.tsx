import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CircleCheck, CircleHelp, CircleX, Cpu, Eye, EyeOff, Globe } from "lucide-react";
import type { CardView } from "@chainpay/sdk";
import type { CardsSource, PrivacyCheckResult, ReadResult } from "./source";
import { errorText } from "./shared";
import { UnlockStrip } from "./Unlock";
import { formatWhen, shortKey } from "./ui";

export const ATTESTATION_VERIFIED_COPY = "Genuine TDX hardware and expected MagicBlock build verified (Devnet).";

/** True only when both halves passed: Intel's signature chain and the pinned MagicBlock build. */
export function attestationPassed(attestation: PrivacyCheckResult["attestation"]): boolean {
  return attestation.hardware === "verified" && attestation.measurements === "matched";
}

/** Attestation line for the proof panel (contracts CD-6). Never claims more than was checked. */
export function attestationCopy(attestation: PrivacyCheckResult["attestation"]): string {
  if (attestationPassed(attestation)) return ATTESTATION_VERIFIED_COPY;
  if (attestation.hardware === "failed") return "Couldn't confirm the private rollup runs on genuine secure hardware.";
  // Everything else (build mismatch, chain not checked, browser can't run it) is the check's own plain label.
  return /[.!?]$/.test(attestation.label) ? attestation.label : `${attestation.label}.`;
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
      <div className="dashboard-card">
        <div className="dashboard-card-heading">
          <div>
            <h2>Read as another wallet</h2>
            <p className="owner-muted">Opens a brand-new wallet in this browser and asks for the same card. Run it as often as you like; nothing is saved.</p>
          </div>
          <Button type="button" variant="primary" label={busy ? "Checking…" : result ? "Run again" : "Run the check"} isDisabled={busy || !unlocked} onClick={() => void run()} />
        </div>
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
            <p className="cp-null-note" data-testid="null-note">Null means this wallet can't see it. It doesn't mean the card is missing.</p>
            <p className="cp-attestation" data-testid="attestation" data-passed={attestationPassed(result.attestation) ? "true" : "false"} data-hardware={result.attestation.hardware} data-measurements={result.attestation.measurements}>
              <AttestationIcon attestation={result.attestation} />
              <span>
                {attestationCopy(result.attestation)}
                {result.attestation.provenance && (result.attestation.measurements === "matched" || result.attestation.measurements === "mismatch") && (
                  <small className="cp-attestation-source">Expected build values: {result.attestation.provenance}.</small>
                )}
              </span>
            </p>
            <small className="owner-muted">Checked {formatWhen(result.checkedAt)}</small>
          </>
        )}
      </div>
    </section>
  );
}
