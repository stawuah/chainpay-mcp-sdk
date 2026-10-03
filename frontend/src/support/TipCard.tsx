// Ruling P2–P7: one card, three steps + result.
import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { SUPPORT_PROGRAM_ID, USDC_MINT, explorerTx } from "./config";
import {
  NOTE_MAX,
  cleanNote,
  contributionInstructions,
  decimalsFor,
  formatUnits,
  shortAddress,
  supportAccounts,
  toBaseUnits,
  type SupportAsset,
} from "./donation";
import { usdHint, useSolUsd } from "./price";
import { checkBalance, friendlyError, sendSigned, signForSupport, type SendOutcome } from "./send";
import type { SupportWalletState } from "./useSupportWallet";
import { WalletGrid } from "./WalletGrid";
import { resolveConnectedWalletIcon } from "../wallet/icons";

const PRESETS: Record<SupportAsset, string[]> = { SOL: ["0.05", "0.1", "0.5"], USDC: ["5", "10", "25"] };
type Step = "amount" | "wallet" | "review" | "done";
type Pending = "" | "checking" | "signing" | "sending";

const STEP_INDEX: Record<Step, number> = { amount: 0, wallet: 1, review: 2, done: 3 };

export function TipCard({ walletState, onSent }: { walletState: SupportWalletState; onSent: () => void }) {
  const { wallet } = walletState;
  const [step, setStep] = useState<Step>("amount");
  const [asset, setAsset] = useState<SupportAsset>("SOL");
  const [amountText, setAmountText] = useState("0.1");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [hideAddress, setHideAddress] = useState(false);
  const [pending, setPending] = useState<Pending>("");
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const solUsd = useSolUsd();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const isCustom = !PRESETS[asset].includes(amountText);

  const units = toBaseUnits(amountText, decimalsFor(asset));
  const amountLabel = units ? `${formatUnits(units, decimalsFor(asset))} ${asset}` : "";
  const hint = usdHint(asset, units, solUsd);
  const busy = pending !== "";

  // P12: move focus to the new step's heading.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const go = (next: Step) => {
    setError("");
    setStep(next);
  };

  const switchAsset = (next: SupportAsset) => {
    setAsset(next);
    setAmountText(PRESETS[next][1]);
  };

  const continueFromAmount = () => {
    if (!units) {
      setError(`Enter an amount, up to ${decimalsFor(asset)} decimal places.`);
      return;
    }
    go(wallet ? "review" : "wallet");
  };

  const pickWallet = async (optionId: string) => {
    const connected = await walletState.connect(optionId);
    if (connected) go("review");
  };

  const send = async () => {
    if (!wallet || !units) return;
    setError("");
    const accounts = supportAccounts(SUPPORT_PROGRAM_ID, USDC_MINT);
    const owner = new PublicKey(wallet.address);
    try {
      setPending("checking");
      const problem = await checkBalance(owner, asset, units, accounts);
      if (problem) {
        setError(problem);
        return;
      }
      setPending("signing");
      const signed = await signForSupport(
        wallet,
        contributionInstructions({ donor: owner, asset, amount: units, note, hideAddress, accounts }),
      );
      setPending("sending");
      const result = await sendSigned(signed);
      setOutcome(result);
      if (result.status === "confirmed") {
        go("done");
        onSent();
      } else if (result.status === "failed") {
        setError(result.message);
      }
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setPending("");
    }
  };

  const reset = () => {
    setOutcome(null);
    setNote("");
    setNoteOpen(false);
    go("amount");
  };

  const walletIcon = wallet ? resolveConnectedWalletIcon(wallet.name, wallet.icon) : undefined;
  const sendLabel =
    pending === "checking" ? "Checking…" : pending === "signing" ? `Confirm in ${wallet?.name ?? "your wallet"}…` : pending === "sending" ? "Sending…" : `Send ${amountLabel}`;

  return (
    <section className="tip-card" aria-label="Buy us a coffee">
      {step !== "done" ? (
        <div className="tip-top">
          {step !== "amount" ? (
            <button type="button" className="tip-back" aria-label="Back" disabled={busy} onClick={() => go(step === "review" && wallet ? "amount" : step === "review" ? "wallet" : "amount")}>
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          ) : <span className="tip-back-spacer" />}
          <ol className="tip-dots" aria-label={`Step ${STEP_INDEX[step] + 1} of 3`}>
            {[0, 1, 2].map((i) => <li key={i} className={i <= STEP_INDEX[step] ? "is-on" : ""} />)}
          </ol>
          <span className="tip-back-spacer" />
        </div>
      ) : null}

      <div className="tip-body" key={step}>
        {step === "amount" ? (
          <>
            <h2 ref={headingRef} tabIndex={-1} className="tip-title">Choose an amount</h2>
            <div className="tip-segment" role="group" aria-label="Token">
              {(["SOL", "USDC"] as const).map((option) => (
                <button key={option} type="button" aria-pressed={asset === option} onClick={() => switchAsset(option)}>{option}</button>
              ))}
            </div>
            <label className="tip-amount">
              <span className="sr-only">Amount in {asset}</span>
              <input
                ref={amountRef}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={amountText}
                size={Math.max(2, amountText.length)}
                aria-invalid={amountText !== "" && !units}
                onChange={(event) => setAmountText(event.target.value.replace(/[^\d.]/g, ""))}
              />
              <span className="tip-amount-unit">{asset}</span>
            </label>
            <p className="tip-usd" aria-live="polite">{hint ?? " "}</p>
            <div className="tip-presets" role="group" aria-label="Quick amounts">
              {PRESETS[asset].map((preset) => (
                <button key={preset} type="button" aria-pressed={amountText === preset} onClick={() => setAmountText(preset)}>
                  {asset === "USDC" ? `$${preset}` : `${preset} SOL`}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={isCustom}
                onClick={() => {
                  if (!isCustom) setAmountText("");
                  amountRef.current?.focus();
                }}
              >
                Custom
              </button>
            </div>

            {noteOpen ? (
              <div className="tip-note">
                <label className="tip-field">
                  <span className="tip-field-row">
                    <span>Public note</span>
                    <span className="tip-counter">{cleanNote(note).length}/{NOTE_MAX}</span>
                  </span>
                  <input maxLength={NOTE_MAX} value={note} placeholder="gm from the MCP crowd" onChange={(event) => setNote(event.target.value)} />
                </label>
                <label className="tip-check">
                  <input type="checkbox" checked={hideAddress} onChange={(event) => setHideAddress(event.target.checked)} />
                  <span>
                    <span className="tip-check-label">Hide my address on this page</span>
                    <span className="tip-hint">Your transaction is still public on-chain.</span>
                  </span>
                </label>
              </div>
            ) : (
              <button type="button" className="tip-link-button" onClick={() => setNoteOpen(true)}>+ Add a note</button>
            )}

            {error ? <p className="tip-error" role="alert">{error}</p> : null}
            <button type="button" className="tip-primary" onClick={continueFromAmount}>Continue</button>
          </>
        ) : null}

        {step === "wallet" ? (
          <>
            <h2 ref={headingRef} tabIndex={-1} className="tip-title">Choose a wallet</h2>
            <p className="tip-sub">Connecting only shows your address. You approve the tip in the next step.</p>
            <WalletGrid options={walletState.options} connectingId={walletState.connectingId} onPick={(id) => void pickWallet(id)} onRefresh={walletState.refresh} />
            {walletState.error ? <p className="tip-error" role="alert">{walletState.error}</p> : null}
          </>
        ) : null}

        {step === "review" && wallet && units ? (
          <>
            <h2 ref={headingRef} tabIndex={-1} className="tip-title">Review</h2>
            <p className="tip-review-amount">{amountLabel}</p>
            {hint ? <p className="tip-usd">{hint}</p> : null}
            <dl className="tip-review">
              <div><dt>From</dt><dd className="tip-from">
                {walletIcon ? <img src={walletIcon} alt="" width={20} height={20} /> : null}
                <span>{wallet.name}</span>
                <span className="tip-mono">{shortAddress(wallet.address)}</span>
                <button type="button" className="tip-link-button" disabled={busy} onClick={() => { walletState.disconnect(); go("wallet"); }}>Change</button>
              </dd></div>
              <div><dt>Network fee</dt><dd>{"< $0.01"}</dd></div>
              {cleanNote(note) ? <div><dt>Note</dt><dd className="tip-note-value">{cleanNote(note)}</dd></div> : null}
              <div><dt>Shown as</dt><dd>{hideAddress ? "Anonymous supporter" : shortAddress(wallet.address)}</dd></div>
            </dl>
            <div aria-live="polite">
              {error ? <p className="tip-error" role="alert">{error}</p> : null}
              {outcome?.status === "unknown" ? (
                <p className="tip-error" role="alert">
                  We couldn't confirm it yet. <a href={explorerTx(outcome.signature)} target="_blank" rel="noreferrer">Check the transaction</a> before trying again.
                </p>
              ) : null}
            </div>
            <button type="button" className="tip-primary" disabled={busy || outcome?.status === "unknown"} onClick={() => void send()}>
              {busy ? <span className="tip-spinner" aria-hidden="true" /> : null}
              {sendLabel}
            </button>
          </>
        ) : null}

        {step === "done" && outcome?.status === "confirmed" ? (
          <div className="tip-done">
            <img className="tip-done-art" src="/support/thanks-480.webp" srcSet="/support/thanks-480.webp 480w, /support/thanks-960.webp 960w" sizes="160px" width={160} height={160} alt="The ChainPay robot next to a coffee cup with a heart of steam" />
            <h2 ref={headingRef} tabIndex={-1} className="tip-title">Thank you — you're on the ledger.</h2>
            <p className="tip-review-amount tip-done-amount">{amountLabel}</p>
            <div className="tip-done-actions">
              <a className="tip-secondary" href={explorerTx(outcome.signature)} target="_blank" rel="noreferrer">View on explorer ↗</a>
              <button type="button" className="tip-primary" onClick={reset}>Send another</button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
