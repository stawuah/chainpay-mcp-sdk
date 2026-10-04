import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import {
  privateRepaymentDisclosure,
  type PrivateRepaymentAttempt,
  type PrivateRepaymentResult,
} from "@chainpay/sdk/cards/private-repayment";
import "./private-repay.css";

/*
 * Opt-in step for paying a card statement privately through MagicBlock
 * Private Payments (contracts.md §7.3). Self-contained: the statement view
 * mounts it as an alternative inside its repayment dialog and passes the three
 * actions below (see the integration note in the cards memlog).
 *
 * Order matters: the vault model is shown and agreed to before anything
 * touches the network. Nothing is prepared, signed or sent until then.
 */

type PayOutcome = { transferOutcome: "sent" | "unknown" };

export type PrivateRepayOptInProps = {
  /** Amount due, integer cents. */
  amountCents: string;
  /** Get or create the attempt (`preparePrivateRepayment`). */
  prepare: () => Promise<PrivateRepaymentAttempt>;
  /** Ask ChainPay once (`submitPrivateRepayment`); throws `settlement_pending` until paid. */
  check: (attempt: PrivateRepaymentAttempt) => Promise<PrivateRepaymentResult>;
  /**
   * Wallet signs: deposit shortfall + private transfer (`payStatementPrivately`). `onSigned`
   * is called with the transfer's signature once the wallet returns it, before it is sent.
   */
  pay: (attempt: PrivateRepaymentAttempt, onSigned: (signature: string) => void) => Promise<PayOutcome>;
  /** Poll ChainPay until the settlement shows up (`waitForPrivateRepayment`). */
  wait: (attempt: PrivateRepaymentAttempt) => Promise<PrivateRepaymentResult>;
  onDone: (result: PrivateRepaymentResult) => void;
  onBack: () => void;
};

type Phase =
  | { kind: "explain" }
  | { kind: "working"; text: string }
  | { kind: "sent"; attempt: PrivateRepaymentAttempt; unknown: boolean; signature: string | null }
  | { kind: "done"; result: PrivateRepaymentResult }
  | { kind: "error"; text: string; attempt?: PrivateRepaymentAttempt; paid: boolean };

const MISMATCH: Record<string, string> = {
  amount: "The partner got a different amount than this statement.",
  mint: "That payment wasn't Devnet USDC from MagicBlock's vault.",
  recipient: "That payment went somewhere other than the card partner.",
  reference: "That payout was already counted for another statement.",
};

function message(cause: unknown): { code: string; text: string } {
  const e = cause as { code?: string; message?: string };
  return { code: e?.code ?? "", text: e?.message || "Something went wrong. Nothing new was paid." };
}

/*
 * Per-attempt "already sent" marker. A transfer whose outcome was unknown, or
 * that is still in MagicBlock's queue, looks exactly like an unpaid attempt to
 * ChainPay (settlement_pending). Without this, a reload would pay the same
 * reference twice. It is written only once the wallet has returned the signed
 * transfer, and it records that signature: a wallet that cancelled, or a step
 * that failed before signing, leaves nothing behind and the owner can try again.
 * Browser storage is a convenience: when it is unavailable the owner is asked,
 * in words, before paying again.
 */
function sentKey(attempt: PrivateRepaymentAttempt): string {
  return `cp-private-sent:${attempt.statementId}:${attempt.attemptId}`;
}
function markSent(attempt: PrivateRepaymentAttempt, signature: string): void {
  try { window.localStorage.setItem(sentKey(attempt), JSON.stringify({ signature, at: new Date().toISOString() })); } catch { /* unavailable */ }
}
/** The signed transfer this browser handed off for this attempt, or null. A marker without a signature doesn't count. */
function sentSignature(attempt: PrivateRepaymentAttempt): string | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(sentKey(attempt)) ?? "null") as { signature?: unknown } | null;
    return typeof raw?.signature === "string" && raw.signature ? raw.signature : null;
  } catch {
    return null;
  }
}

function dollars(cents: string): string {
  const padded = cents.padStart(3, "0");
  return `$${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

export function PrivateRepayOptIn({ amountCents, prepare, check, pay, wait, onDone, onBack }: PrivateRepayOptInProps) {
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "explain" });
  const lines = privateRepaymentDisclosure({ amountCents, amountBaseUnits: "" });

  async function confirmPaid(attempt: PrivateRepaymentAttempt, unknown: boolean, signature: string | null) {
    setPhase({ kind: "sent", attempt, unknown, signature });
    try {
      const result = await wait(attempt);
      setPhase({ kind: "done", result });
      if (result.state !== "repayment_mismatch") onDone(result);
    } catch (cause) {
      // Money may have moved: never read this as "not paid".
      setPhase({ kind: "error", text: message(cause).text, attempt, paid: true });
    }
  }

  async function start() {
    let attempt: PrivateRepaymentAttempt | undefined;
    try {
      setPhase({ kind: "working", text: "Getting this statement's private reference…" });
      attempt = await prepare();
      // An attempt that already settled (say, after a reload) is never paid twice.
      try {
        const result = await check(attempt);
        setPhase({ kind: "done", result });
        if (result.state !== "repayment_mismatch") onDone(result);
        return;
      } catch (cause) {
        if (message(cause).code !== "settlement_pending") throw cause;
      }
      const earlier = sentSignature(attempt);
      if (earlier) {
        // This browser already signed a payment for this reference: wait for it.
        await confirmPaid(attempt, true, earlier);
        return;
      }
      setPhase({ kind: "working", text: "Check your wallet. You'll sign a deposit into the vault if needed, then the private payment." });
      let signature: string | null = null;
      const paying = attempt;
      const outcome = await pay(paying, (signed) => { signature = signed; markSent(paying, signed); });
      await confirmPaid(attempt, outcome.transferOutcome === "unknown", signature);
    } catch (cause) {
      // Signed and handed off: money may move, so never "not paid". Otherwise nothing was sent.
      const signed = attempt ? sentSignature(attempt) !== null : false;
      setPhase({ kind: "error", text: message(cause).text, attempt, paid: signed });
    }
  }

  if (phase.kind === "explain") {
    return (
      <section className="cp-private" data-testid="private-repay-optin" aria-labelledby="cp-private-title">
        <h3 id="cp-private-title">Pay privately with MagicBlock</h3>
        <p className="cp-private-lede">Before you opt in, here's how this one works.</p>
        <ul className="cp-private-points" data-testid="private-repay-disclosure">
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <label className="cp-private-agree">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} data-testid="private-repay-agree" />
          <span>Got it. Move my USDC into MagicBlock's vault to pay {dollars(amountCents)}.</span>
        </label>
        <div className="cp-private-actions">
          <Button type="button" variant="secondary" label="Pay the regular way" onClick={onBack} />
          <Button type="button" variant="primary" label={`Pay ${dollars(amountCents)} privately`} isDisabled={!agreed} onClick={() => void start()} />
        </div>
      </section>
    );
  }

  if (phase.kind === "working") {
    return <section className="cp-private" data-testid="private-repay-working" aria-busy="true"><p role="status">{phase.text}</p></section>;
  }

  if (phase.kind === "sent") {
    return (
      <section className="cp-private" data-testid="private-repay-sent" aria-busy="true">
        <p role="status">
          {phase.unknown
            ? "Your wallet signed, but the network didn't confirm the send. It may still have gone through, so don't pay again. Checking with the partner…"
            : "Sent. Waiting for MagicBlock to pay the partner from the vault. Usually a few seconds."}
        </p>
        {phase.signature && <small className="cp-private-sig">Signed transfer <span className="mono">{phase.signature.slice(0, 8)}…{phase.signature.slice(-8)}</span></small>}
      </section>
    );
  }

  if (phase.kind === "done") {
    const result = phase.result;
    if (result.state === "repayment_mismatch") {
      return (
        <section className="cp-private" data-testid="private-repay-mismatch" role="alert">
          <h3>That payment didn't match</h3>
          <ul>{result.mismatch.map((field) => <li key={field} data-field={field}>{MISMATCH[field] ?? `${field} didn't match.`}</li>)}</ul>
          <p>The statement is still open. Nothing was closed with the wrong payment. A new try gets a fresh reference.</p>
          <div className="cp-private-actions"><Button type="button" variant="secondary" label="Back" onClick={onBack} /></div>
        </section>
      );
    }
    return (
      <section className="cp-private" data-testid="private-repay-done" role="status">
        <h3>{result.state === "discharged" ? "Statement paid off" : "Payment found"}</h3>
        <p>The partner got exactly {dollars(amountCents)} with this statement's reference. ChainPay checked that on Solana. It didn't check who paid, which is the point of paying privately.</p>
      </section>
    );
  }

  return (
    <section className="cp-private" data-testid="private-repay-error" role="alert">
      <h3>{phase.paid ? "Not confirmed yet" : "Not paid"}</h3>
      <p>{phase.text}</p>
      {phase.paid && phase.attempt && (
        <>
          <p>Don't pay again. Check again in a minute; the same reference is still waiting.</p>
          <div className="cp-private-actions">
            <Button type="button" variant="primary" label="Check again" onClick={() => void confirmPaid(phase.attempt!, false, sentSignature(phase.attempt!))} />
          </div>
        </>
      )}
      {!phase.paid && (
        <>
          <p>Nothing was sent, so you can try again.</p>
          <div className="cp-private-actions">
            <Button type="button" variant="secondary" label="Back" onClick={onBack} />
            <Button type="button" variant="primary" label="Try again" onClick={() => void start()} />
          </div>
        </>
      )}
    </section>
  );
}
