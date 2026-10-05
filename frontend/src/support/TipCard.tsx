// Ruling P2–P7: one card, three steps + result. This release is Devnet only:
// Devnet SOL and Devnet USDC, no "Other" token and no Jupiter swap (SWAP_ENABLED
// is false; the swap path below stays for a later, separately reviewed release).
import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { SOL_DECIMALS, SWAP_ENABLED, USDC_DECIMALS, USDC_MINT, explorerTx } from "./config";

// Devnet tokens have no value, so the card never shows a dollar figure for them.
const TEST_TOKENS = true;
import {
  NOTE_MAX,
  cleanNote,
  contributionInstructions,
  decimalsFor,
  formatUnits,
  shortAddress,
  toBaseUnits,
  type SupportAccounts,
  type SupportAsset,
} from "./donation";
import { clearPendingTip, loadPendingTip, recheckTip, savePendingTip, type PendingTip } from "./recovery";
import { usdHint, useSolUsd } from "./price";
import { checkBalance, friendlyError, sendSigned, signForSupport, supportConnection, type SendOutcome } from "./send";
import {
  BASE_FEE_LAMPORTS,
  SLIPPAGE_BPS,
  buildSwapTip,
  existingAccounts,
  quoteToUsdc,
  signVersionedForSupport,
  worseThanShown,
  type PreparedSwap,
  type SwapQuote,
  type SwapToken,
} from "./swap";
import { TokenIcon, TokenPicker } from "./TokenPicker";
import type { SupportWalletState } from "./useSupportWallet";
import { WalletGrid } from "./WalletGrid";
import { resolveConnectedWalletIcon } from "../wallet/icons";

type Mode = SupportAsset | "OTHER";
const PRESETS: Record<SupportAsset, string[]> = { SOL: ["0.05", "0.1", "0.5"], USDC: ["5", "10", "25"] };
type Step = "amount" | "wallet" | "review" | "status" | "done";
type Pending = "" | "checking" | "quoting" | "signing" | "sending";

const STEP_INDEX: Record<Step, number> = { amount: 0, wallet: 1, review: 2, status: 3, done: 3 };
type Recheck = "" | "checking" | "unknown" | "failed" | "expired";
// A saved tip that confirmed this long ago is history, not an uncertain send.
const STALE_CONFIRMED_MS = 30 * 60_000;
// A swap prepared longer ago than this is rebuilt before signing, and only signed
// as-is if it's at least as good as what the card showed.
const SWAP_FRESH_MS = 20_000;

function useSwapQuote(token: SwapToken | null, units: bigint | null) {
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none">("idle");
  useEffect(() => {
    setQuote(null);
    if (!token || !units) {
      setState("idle");
      return;
    }
    let alive = true;
    setState("loading");
    const timer = window.setTimeout(() => {
      quoteToUsdc(token.mint, units, USDC_MINT)
        .then((q) => {
          if (!alive) return;
          setQuote(q);
          setState(q ? "idle" : "none");
        })
        .catch(() => alive && setState("none"));
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [token, units]);
  return { quote, state };
}

function swapError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  return /^Swap |^Jupiter |^Unexpected /.test(message) ? `${message} Nothing was sent.` : friendlyError(cause);
}

export type TipCardProps = {
  walletState: SupportWalletState;
  accounts: SupportAccounts;
  /** Re-reads the chain right before signing. Returns why signing is blocked, or null. */
  ensureReady: () => Promise<string | null>;
  /** True once the public ledger lists this signature. */
  indexed: (signature: string) => boolean;
  onSent: () => void;
  onRefreshLedger: () => void;
};

export function TipCard({ walletState, accounts, ensureReady, indexed, onSent, onRefreshLedger }: TipCardProps) {
  const { wallet } = walletState;
  // A tip signed earlier (this tab or a previous one) whose outcome we never saw.
  const [pendingTip, setPendingTip] = useState<PendingTip | null>(() => loadPendingTip());
  const [recheck, setRecheck] = useState<Recheck>("");
  const [step, setStep] = useState<Step>(() => (pendingTip ? "status" : "amount"));
  const [mode, setMode] = useState<Mode>("SOL");
  const [token, setToken] = useState<SwapToken | null>(null);
  const [amountText, setAmountText] = useState("0.1");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [hideAddress, setHideAddress] = useState(false);
  const [pending, setPending] = useState<Pending>("");
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const [prepared, setPrepared] = useState<PreparedSwap | null>(null);
  const solUsd = useSolUsd();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // Only reachable when SWAP_ENABLED lists "OTHER" (never on Devnet).
  const swapping = mode === "OTHER";
  const symbol = swapping ? token?.symbol ?? "" : mode;
  const decimals = swapping ? token?.decimals ?? 0 : decimalsFor(mode);
  const units = swapping && !token ? null : toBaseUnits(amountText, decimals);
  const amountLabel = units ? `${formatUnits(units, decimals)} ${symbol}` : "";
  const { quote, state: quoteState } = useSwapQuote(swapping ? token : null, units);
  const arrives = quote ? `${formatUnits(BigInt(quote.outAmount), USDC_DECIMALS)} USDC` : null;
  // The review card shows the swap that will be signed: the prepared one.
  const shownQuote = prepared?.quote ?? null;
  const shownArrives = shownQuote ? `${formatUnits(BigInt(shownQuote.outAmount), USDC_DECIMALS)} USDC` : null;
  const minimum = shownQuote ? `${formatUnits(BigInt(shownQuote.otherAmountThreshold), USDC_DECIMALS)} USDC` : null;
  const feeLamports = swapping ? prepared?.feeLamports ?? null : BASE_FEE_LAMPORTS;
  const feeUsd = feeLamports !== null && !TEST_TOKENS ? usdHint("SOL", feeLamports, solUsd) : null;
  const hint = swapping
    ? quoteState === "loading" ? "Getting a price…" : quoteState === "none" ? "No swap route for this amount." : arrives ? `≈ ${arrives} arrives` : null
    : TEST_TOKENS ? "Devnet test tokens · no real value" : usdHint(mode, units, solUsd);
  const isCustom = swapping || !PRESETS[mode].includes(amountText);
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

  // Build the swap when the review opens, so the card can show its real minimum and fee.
  const walletAddress = wallet?.address ?? null;
  useEffect(() => {
    setPrepared(null);
    if (step !== "review" || !swapping || !walletAddress || !quote) return;
    let alive = true;
    buildSwapTip({ donor: new PublicKey(walletAddress), quote, note, hideAddress, accounts, existingAccounts })
      .then((built) => alive && setPrepared(built))
      .catch((cause) => alive && setError(swapError(cause)));
    return () => {
      alive = false;
    };
  }, [step, swapping, walletAddress, quote, note, hideAddress, accounts]);

  // Same-signature recovery: look up the saved signature, never ask for a new tip.
  const checkPending = async (tip: PendingTip, fromLoad = false) => {
    setRecheck("checking");
    const result = await recheckTip(supportConnection(), tip);
    if (result.status === "confirmed" && fromLoad && Date.now() - tip.savedAt > STALE_CONFIRMED_MS) {
      // Landed long ago: nothing is uncertain any more, so don't hold the card on it.
      clearPendingTip(tip.signature);
      setPendingTip(null);
      setRecheck("");
      setStep("amount");
    } else if (result.status === "confirmed") {
      setRecheck("");
      setOutcome({ status: "confirmed", signature: tip.signature });
      setStep("done");
      onSent();
    } else if (result.status === "failed" || result.status === "expired") {
      clearPendingTip(tip.signature);
      setRecheck(result.status);
    } else {
      setRecheck("unknown");
    }
  };
  useEffect(() => {
    if (pendingTip && step === "status") void checkPending(pendingTip, true);
    // Only on first load: later checks are the user's "Check again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the ledger lists the tip, nothing is pending any more.
  const doneSignature = step === "done" && outcome?.status === "confirmed" ? outcome.signature : null;
  const onLedger = doneSignature ? indexed(doneSignature) : false;
  useEffect(() => {
    if (doneSignature && onLedger) clearPendingTip(doneSignature);
  }, [doneSignature, onLedger]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    if (next === "OTHER") {
      setToken(null);
      setAmountText("");
    } else {
      setAmountText(PRESETS[next][1]);
    }
  };

  const continueFromAmount = () => {
    if (!units) {
      setError(`Enter an amount, up to ${decimals} decimal places.`);
      return;
    }
    if (swapping && !quote) {
      setError(quoteState === "loading" ? "One moment, getting a price…" : "There's no swap route for this amount. Try a different amount or token.");
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
    if (pendingTip) {
      // There's a tip we never got an answer for. Check that one; don't sign another.
      setStep("status");
      return;
    }
    const owner = new PublicKey(wallet.address);
    try {
      setPending("checking");
      const blockedBy = await ensureReady();
      if (blockedBy) {
        setError(`${blockedBy} Nothing was sent.`);
        return;
      }
      let plan = prepared;
      if (swapping && token && plan && Date.now() - plan.preparedAt > SWAP_FRESH_MS) {
        setPending("quoting");
        const freshQuote = await quoteToUsdc(token.mint, units, USDC_MINT);
        if (!freshQuote) {
          setError("The swap price isn't available right now. Nothing was sent.");
          return;
        }
        const fresh = await buildSwapTip({ donor: owner, quote: freshQuote, note, hideAddress, accounts, existingAccounts });
        const worse = worseThanShown(plan, fresh);
        setPrepared(fresh);
        if (worse) {
          setError(`${worse} Check the new amounts, then press Send again. Nothing was sent.`);
          return;
        }
        plan = fresh;
      }
      if (swapping && !plan) return;
      setPending("checking");
      // A swap's SOL cost is its fee (plus any token-account rent); the token itself is checked by the wallet.
      const problem = await checkBalance(owner, swapping ? "SOL" : mode, swapping ? plan!.feeLamports : units, accounts);
      if (problem) {
        setError(problem);
        return;
      }
      let signed;
      if (swapping && plan) {
        setPending("signing");
        signed = await signVersionedForSupport(wallet, plan, accounts);
      } else {
        setPending("signing");
        signed = await signForSupport(
          wallet,
          contributionInstructions({ donor: owner, asset: mode as SupportAsset, amount: units, note, hideAddress, accounts }),
        );
      }
      // Saved before sending, so a lost answer is re-checked by this same signature.
      const saved: PendingTip = { signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight, asset: swapping ? "USDC" : (mode as SupportAsset), amount: units.toString(), label: amountLabel, savedAt: Date.now() };
      savePendingTip(saved);
      setPendingTip(saved);
      setPending("sending");
      const result = await sendSigned(signed);
      setOutcome(result);
      if (result.status === "confirmed") {
        go("done");
        onSent();
      } else if (result.status === "failed") {
        clearPendingTip(signed.signature);
        setPendingTip(null);
        setError(result.message);
      } else {
        setRecheck("unknown");
        go("status");
      }
    } catch (cause) {
      setError(swapError(cause));
    } finally {
      setPending("");
    }
  };

  const reset = () => {
    if (outcome) clearPendingTip(outcome.signature);
    setPendingTip(null);
    setRecheck("");
    setOutcome(null);
    setNote("");
    setNoteOpen(false);
    go("amount");
  };

  const walletIcon = wallet ? resolveConnectedWalletIcon(wallet.name, wallet.icon) : undefined;
  const sendLabel =
    pending === "checking" ? "Checking…"
      : pending === "quoting" ? "Getting the latest price…"
        : pending === "signing" ? `Confirm in ${wallet?.name ?? "your wallet"}…`
          : pending === "sending" ? "Sending…"
            : `Send ${amountLabel}`;
  const modes: Mode[] = SWAP_ENABLED ? ["SOL", "USDC", "OTHER"] : ["SOL", "USDC"];

  return (
    <section className="tip-card" aria-label="Send a Devnet test tip">
      {step !== "done" && step !== "status" ? (
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
            <div className={`tip-segment${modes.length === 3 ? " is-three" : ""}`} role="group" aria-label="Token">
              {modes.map((option) => (
                <button key={option} type="button" aria-pressed={mode === option} onClick={() => switchMode(option)}>
                  {option === "OTHER" ? "Other" : option}
                </button>
              ))}
            </div>

            {swapping && !token ? (
              <TokenPicker onPick={(picked) => {
                setToken(picked);
                window.setTimeout(() => amountRef.current?.focus(), 0);
              }} />
            ) : (
              <>
                {swapping && token ? (
                  <button type="button" className="token-chip" onClick={() => setToken(null)}>
                    <TokenIcon token={token} size={20} />
                    <span>{token.symbol}</span>
                    <span className="token-chip-change">Change</span>
                  </button>
                ) : null}
                <label className="tip-amount">
                  <span className="sr-only">Amount in {symbol}</span>
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
                  <span className="tip-amount-unit">{symbol}</span>
                </label>
                <p className="tip-usd" aria-live="polite">{hint ?? " "}</p>
                {!swapping ? (
                  <div className="tip-presets" role="group" aria-label="Quick amounts">
                    {PRESETS[mode as SupportAsset].map((preset) => (
                      <button key={preset} type="button" aria-pressed={amountText === preset} onClick={() => setAmountText(preset)}>
                        {mode === "USDC" ? (TEST_TOKENS ? `${preset} USDC` : `$${preset}`) : `${preset} SOL`}
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
                ) : null}

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
            )}
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
              {swapping ? (
                <div><dt>Arrives</dt><dd className="tip-stack">{minimum ? <>{shownArrives}<span className="tip-mono-soft">at least {minimum}</span></> : error ? "—" : "Getting the latest price…"}</dd></div>
              ) : null}
              <div><dt>Network fee</dt><dd className="tip-stack">
                {feeLamports !== null ? <>≈ {formatUnits(feeLamports, SOL_DECIMALS)} SOL{feeUsd ? ` (${feeUsd.replace(/^≈ /, "")})` : ""}</> : error ? "—" : "…"}
                {prepared && prepared.rentLamports > 0n ? (
                  <span className="tip-mono-soft">
                    includes {formatUnits(prepared.rentLamports, SOL_DECIMALS)} SOL to open {prepared.newAccounts === 1 ? "a token account" : `${prepared.newAccounts} token accounts`} in your wallet
                  </span>
                ) : null}
              </dd></div>
              {cleanNote(note) ? <div><dt>Note</dt><dd className="tip-note-value">{cleanNote(note)}</dd></div> : null}
              <div><dt>Shown as</dt><dd>{hideAddress ? "Anonymous supporter" : shortAddress(wallet.address)}</dd></div>
            </dl>
            {swapping ? <p className="tip-hint tip-center">Swapped to USDC by Jupiter in this same transaction ({SLIPPAGE_BPS / 100}% max slippage).</p> : null}
            <div aria-live="polite">
              {error ? <p className="tip-error" role="alert">{error}</p> : null}
            </div>
            <button type="button" className="tip-primary" disabled={busy || pendingTip !== null || (swapping && !prepared)} onClick={() => void send()}>
              {busy ? <span className="tip-spinner" aria-hidden="true" /> : null}
              {sendLabel}
            </button>
          </>
        ) : null}

        {step === "status" && pendingTip ? (
          <div className="tip-status" data-testid="tip-status" data-state={recheck || "checking"}>
            <h2 ref={headingRef} tabIndex={-1} className="tip-title">
              {recheck === "failed" ? "That test tip didn't go through" : recheck === "expired" ? "That test tip never landed" : "Checking your test tip"}
            </h2>
            <p className="tip-review-amount tip-done-amount">{pendingTip.label}</p>
            <p className="tip-usd">Devnet test tokens · no real value</p>
            <div aria-live="polite">
              {recheck === "failed" ? (
                <p className="tip-sub">It failed on-chain. Nothing was taken except the network fee.</p>
              ) : recheck === "expired" ? (
                <p className="tip-sub">It expired before landing. Nothing was sent, so you can try again.</p>
              ) : (
                <p className="tip-sub" role="status">
                  {recheck === "checking" || recheck === "" ? "Looking up the same transaction on Devnet…" : "Not confirmed yet. We're checking the transaction you already signed, so don't send another one. It can take a minute."}
                </p>
              )}
            </div>
            <div className="tip-done-actions">
              <a className="tip-secondary" href={explorerTx(pendingTip.signature)} target="_blank" rel="noreferrer">View on Devnet explorer ↗</a>
              {recheck === "failed" || recheck === "expired" ? (
                <button type="button" className="tip-primary" onClick={reset}>Try again</button>
              ) : (
                <button type="button" className="tip-primary" disabled={recheck === "checking"} onClick={() => void checkPending(pendingTip)}>
                  {recheck === "checking" ? <span className="tip-spinner" aria-hidden="true" /> : null}
                  {recheck === "checking" ? "Checking…" : "Check again"}
                </button>
              )}
            </div>
          </div>
        ) : null}

        {step === "done" && outcome?.status === "confirmed" ? (
          <div className="tip-done" data-testid="tip-done" data-indexed={onLedger ? "yes" : "no"}>
            <img className="tip-done-art" src="/support/thanks-480.webp" srcSet="/support/thanks-480.webp 480w, /support/thanks-960.webp 960w" sizes="160px" width={160} height={160} alt="The ChainPay robot next to a coffee cup with a heart of steam" />
            <h2 ref={headingRef} tabIndex={-1} className="tip-title">{onLedger ? "Thanks. You're on the ledger." : "Thanks. It landed on Devnet."}</h2>
            <p className="tip-review-amount tip-done-amount">{pendingTip?.signature === outcome.signature ? pendingTip.label : amountLabel}</p>
            <p className="tip-usd">Devnet test tokens · no real value</p>
            {onLedger ? null : (
              <p className="tip-sub" role="status">Pending indexing. The public ledger catches up every few minutes. Your tip is already on-chain, so there's nothing more to send.</p>
            )}
            <p className="tip-hint tip-center">A support tip, not a ChainPay payment receipt.</p>
            <div className="tip-done-actions">
              <a className="tip-secondary" href={explorerTx(outcome.signature)} target="_blank" rel="noreferrer">View on Devnet explorer ↗</a>
              {onLedger ? (
                <button type="button" className="tip-primary" onClick={reset}>Send another</button>
              ) : (
                <button type="button" className="tip-primary" onClick={onRefreshLedger}>Refresh ledger</button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
