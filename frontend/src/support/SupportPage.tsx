// /support — council ruling S1–S12: _bmad-output/design-council/support-ruling-2026-10-03.md
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { PublicKey } from "@solana/web3.js";
import { UseCaseChrome } from "../use-cases/UseCaseChrome";
import { WalletPickerDialog, type WalletPickerOption } from "../ui/WalletPickerDialog";
import { connectChainPayWallet, getChainPayWalletOptions, type ChainPayWallet } from "../wallet/connect";
import {
  MAINTAINER_LABELS,
  SUPPORT_CLUSTER,
  SUPPORT_PROGRAM_ID,
  SUPPORT_TRACKER_URL,
  USDC_MINT,
  explorerAddress,
  explorerTx,
  supportReady,
} from "./config";
import {
  NOTE_MAX,
  cleanNote,
  contributionInstructions,
  decimalsFor,
  decodeVault,
  formatUnits,
  payoutInstructions,
  shortAddress,
  supportAccounts,
  toBaseUnits,
  type Side,
  type SupportAsset,
  type VaultView,
} from "./donation";
import { checkBalance, friendlyError, sendSigned, signForSupport, supportConnection, type SendOutcome } from "./send";
import "./support.css";

const PRESETS: Record<SupportAsset, string[]> = { SOL: ["0.05", "0.1", "0.5"], USDC: ["5", "10", "25"] };

export type TrackerContribution = {
  signature: string;
  asset: SupportAsset;
  amount: string;
  donor: string | null;
  note: string | null;
  blockTime: number | null;
};

export type TrackerData = {
  totals: { sol: { contributed: string }; usdc: { contributed: string } };
  contributionCount: number;
  recent: TrackerContribution[];
};

function useTracker(enabled: boolean) {
  const [data, setData] = useState<TrackerData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !SUPPORT_TRACKER_URL) return;
    let alive = true;
    const load = () =>
      fetch(SUPPORT_TRACKER_URL)
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((json: TrackerData) => {
          if (alive) {
            setData(json);
            setFailed(false);
          }
        })
        .catch(() => alive && setFailed(true));
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled]);
  return { data, failed };
}

function useVault(enabled: boolean) {
  const [vault, setVault] = useState<VaultView | null>(null);
  const accounts = useMemo(() => (enabled ? supportAccounts(SUPPORT_PROGRAM_ID, USDC_MINT) : null), [enabled]);
  const refresh = useCallback(async () => {
    if (!accounts) return;
    try {
      const info = await supportConnection().getAccountInfo(accounts.vault, "confirmed");
      if (info && info.owner.equals(accounts.programId)) setVault(decodeVault(info.data));
    } catch {
      // Leave the last known state; the section says "checking" until it loads.
    }
  }, [accounts]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { vault, accounts, refresh };
}

function useSupportWallet() {
  const [wallet, setWallet] = useState<ChainPayWallet | null>(null);
  const [options, setOptions] = useState<WalletPickerOption[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const refreshOptions = useCallback(() => setOptions(getChainPayWalletOptions(window.solana, window.phantom?.solana)), []);
  const open = useCallback(() => {
    refreshOptions();
    setError("");
    setPickerOpen(true);
  }, [refreshOptions]);
  const select = useCallback(async (optionId: string) => {
    setConnecting(true);
    setError("");
    try {
      setWallet(await connectChainPayWallet(optionId, window.solana, window.phantom?.solana));
      setPickerOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't connect that wallet.");
    } finally {
      setConnecting(false);
    }
  }, []);
  return { wallet, options, pickerOpen, setPickerOpen, connecting, error, open, select, refreshOptions };
}

function timeAgo(seconds: number | null) {
  if (!seconds) return "";
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

function amountLabel(units: string | bigint, asset: SupportAsset) {
  return `${formatUnits(BigInt(units), decimalsFor(asset))} ${asset}`;
}

type SendState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "signing" }
  | { kind: "sending" }
  | { kind: "done"; outcome: SendOutcome; label: string };

function SendCard({ onSent }: { onSent: () => void }) {
  const walletState = useSupportWallet();
  const { wallet } = walletState;
  const [asset, setAsset] = useState<SupportAsset>("SOL");
  const [amountText, setAmountText] = useState("0.1");
  const [note, setNote] = useState("");
  const [hideAddress, setHideAddress] = useState(false);
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [error, setError] = useState("");

  const units = toBaseUnits(amountText, decimalsFor(asset));
  const label = units ? amountLabel(units, asset) : "";
  const busy = state.kind === "checking" || state.kind === "signing" || state.kind === "sending";

  const switchAsset = (next: SupportAsset) => {
    setAsset(next);
    setAmountText(PRESETS[next][1]);
    setError("");
  };

  const send = async () => {
    if (!wallet) {
      walletState.open();
      return;
    }
    if (!units) {
      setError(`Enter an amount, up to ${decimalsFor(asset)} decimal places.`);
      return;
    }
    setError("");
    const accounts = supportAccounts(SUPPORT_PROGRAM_ID, USDC_MINT);
    const owner = new PublicKey(wallet.address);
    try {
      setState({ kind: "checking" });
      const problem = await checkBalance(owner, asset, units, accounts);
      if (problem) {
        setError(problem);
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "signing" });
      const signed = await signForSupport(
        wallet,
        contributionInstructions({ donor: owner, asset, amount: units, note, hideAddress, accounts }),
      );
      setState({ kind: "sending" });
      const outcome = await sendSigned(signed);
      setState({ kind: "done", outcome, label });
      if (outcome.status === "confirmed") onSent();
    } catch (cause) {
      setError(friendlyError(cause));
      setState({ kind: "idle" });
    }
  };

  if (state.kind === "done" && state.outcome.status === "confirmed") {
    return (
      <section className="sp-card sp-send" aria-labelledby="sp-send-title">
        <div className="sp-success" role="status">
          <span className="sp-check" aria-hidden="true">✓</span>
          <h2 id="sp-send-title" className="sp-card-title">Thanks — it's on-chain.</h2>
          <p className="t-body">{state.label}</p>
          <div className="sp-success-actions">
            <a className="sp-link" href={explorerTx(state.outcome.signature)} target="_blank" rel="noreferrer">View transaction</a>
            <Button variant="secondary" label="Send another" isDisabled={false} onClick={() => setState({ kind: "idle" })} />
          </div>
        </div>
      </section>
    );
  }

  const buttonLabel = !wallet
    ? "Connect wallet"
    : state.kind === "checking"
      ? "Checking…"
      : state.kind === "signing"
        ? "Confirm in your wallet…"
        : state.kind === "sending"
          ? "Sending…"
          : label
            ? `Send ${label}`
            : "Send";

  const outcomeProblem = state.kind === "done" ? state.outcome : null;

  return (
    <section className="sp-card sp-send" aria-labelledby="sp-send-title">
      <h2 id="sp-send-title" className="sp-card-title">Send a tip</h2>

      <div className="sp-segment" role="group" aria-label="Asset">
        {(["SOL", "USDC"] as const).map((option) => (
          <button key={option} type="button" className="sp-segment-option" aria-pressed={asset === option} disabled={busy} onClick={() => switchAsset(option)}>
            {option}
          </button>
        ))}
      </div>

      <div className="sp-presets" role="group" aria-label="Amount">
        {PRESETS[asset].map((preset) => (
          <button key={preset} type="button" className="uc-pill sp-pill" aria-pressed={amountText === preset} disabled={busy} onClick={() => setAmountText(preset)}>
            {preset} {asset}
          </button>
        ))}
      </div>

      <label className="sp-field">
        <span className="sp-label">Amount</span>
        <span className="sp-input-wrap">
          <input
            className="sp-input sp-mono"
            inputMode="decimal"
            autoComplete="off"
            value={amountText}
            disabled={busy}
            onChange={(event) => setAmountText(event.target.value)}
            aria-invalid={amountText !== "" && !units}
          />
          <span className="sp-input-suffix">{asset}</span>
        </span>
      </label>

      <label className="sp-field">
        <span className="sp-label-row">
          <span className="sp-label">Public note (optional)</span>
          <span className="sp-counter" aria-live="polite">{cleanNote(note).length}/{NOTE_MAX}</span>
        </span>
        <input
          className="sp-input"
          maxLength={NOTE_MAX}
          value={note}
          disabled={busy}
          placeholder="gm from the MCP crowd"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <label className="sp-check-row">
        <input type="checkbox" checked={hideAddress} disabled={busy} onChange={(event) => setHideAddress(event.target.checked)} />
        <span>
          <span className="sp-check-label">Hide my address on this page</span>
          <span className="sp-hint">Your transaction is still public on-chain.</span>
        </span>
      </label>

      <Button variant="primary" label={buttonLabel} isDisabled={busy} onClick={() => void send()} />
      {wallet ? (
        <p className="sp-hint sp-wallet-line">
          {wallet.icon ? <img src={wallet.icon} alt="" width={16} height={16} /> : null}
          {wallet.name} · <span className="sp-mono">{shortAddress(wallet.address)}</span>
        </p>
      ) : null}

      {error ? <p className="sp-error" role="alert">{error}</p> : null}
      {outcomeProblem?.status === "failed" ? <p className="sp-error" role="alert">{outcomeProblem.message}</p> : null}
      {outcomeProblem?.status === "unknown" ? (
        <p className="sp-error" role="alert">
          We couldn't confirm it yet. Check the{" "}
          <a className="sp-link" href={explorerTx(outcomeProblem.signature)} target="_blank" rel="noreferrer">transaction</a>{" "}
          before trying again.
        </p>
      ) : null}

      <p className="sp-hint">Goes to a locked program that splits it 50/50 between the two maintainers.</p>

      <WalletPickerDialog
        isOpen={walletState.pickerOpen}
        wallets={walletState.options}
        connecting={walletState.connecting}
        error={walletState.error}
        onSelect={(id) => void walletState.select(id)}
        onOpenChange={walletState.setPickerOpen}
        onRefresh={walletState.refreshOptions}
      />
    </section>
  );
}

function RaisedPanel({ data, failed }: { data: TrackerData | null; failed: boolean }) {
  return (
    <section className="sp-raised" aria-labelledby="sp-raised-title">
      <h2 id="sp-raised-title" className="sp-eyebrow">Raised so far</h2>
      {data ? (
        <>
          <div className="sp-totals">
            <p className="sp-total sp-mono">{amountLabel(data.totals.sol.contributed, "SOL")}</p>
            <p className="sp-total sp-mono">{amountLabel(data.totals.usdc.contributed, "USDC")}</p>
          </div>
          <p className="t-body">
            {data.contributionCount === 0
              ? "No contributions yet."
              : `${data.contributionCount.toLocaleString("en-US")} ${data.contributionCount === 1 ? "contribution" : "contributions"} · split 50/50 on-chain`}
          </p>
        </>
      ) : (
        <p className="t-body">{failed ? "Totals are taking a moment. The vault is always on-chain if you want to check." : "Loading…"}</p>
      )}
    </section>
  );
}

function RecentList({ data }: { data: TrackerData | null }) {
  if (!data) return null;
  return (
    <section className="sp-recent" aria-labelledby="sp-recent-title">
      <h2 id="sp-recent-title" className="sp-section-title">Recent</h2>
      {data.recent.length === 0 ? (
        <p className="t-body sp-empty">Be the first. It shows up here a few minutes after it lands.</p>
      ) : (
        <ul className="sp-list">
          {data.recent.slice(0, 25).map((item) => (
            <li key={item.signature} className="sp-row">
              <div className="sp-row-main">
                <span className={item.donor ? "sp-mono" : "sp-hidden-address"}>{item.donor ? shortAddress(item.donor) : "Address hidden"}</span>
                <span className="sp-mono sp-row-amount">{amountLabel(item.amount, item.asset)}</span>
              </div>
              {item.note ? <p className="sp-row-note">{item.note}</p> : null}
              <a className="sp-row-time" href={explorerTx(item.signature)} target="_blank" rel="noreferrer" aria-label={`View transaction, ${timeAgo(item.blockTime)}`}>
                {timeAgo(item.blockTime)} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SplitSection({ live, vaultState }: { live: boolean; vaultState: ReturnType<typeof useVault> }) {
  const { vault, accounts, refresh } = vaultState;
  const walletState = useSupportWallet();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string>("");

  const payOut = async (side: Side) => {
    if (!vault || !accounts) return;
    if (!walletState.wallet) {
      walletState.open();
      return;
    }
    setMessage("");
    const payer = new PublicKey(walletState.wallet.address);
    const recipient = new PublicKey(vault.recipients[side]);
    const assets = (["SOL", "USDC"] as const).filter((asset) => (asset === "SOL" ? vault.sol : vault.usdc).owed[side] > 0n);
    if (assets.length === 0) {
      setMessage("Nothing owed to that side right now.");
      return;
    }
    setBusy(String(side));
    try {
      const signed = await signForSupport(
        walletState.wallet,
        assets.flatMap((asset) => payoutInstructions({ asset, side, recipient, payer, accounts })),
      );
      const outcome = await sendSigned(signed);
      setMessage(
        outcome.status === "confirmed"
          ? `Paid out to ${MAINTAINER_LABELS[side]}.`
          : outcome.status === "failed"
            ? `${outcome.message} The other side isn't affected.`
            : "We couldn't confirm it yet. Check the transaction before trying again.",
      );
      await refresh();
    } catch (cause) {
      setMessage(friendlyError(cause));
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="sp-split page-width" aria-labelledby="sp-split-title">
      <h2 id="sp-split-title" className="sp-section-title">Where it goes</h2>
      <ol className="sp-steps">
        <li><span className="sp-step-n">1</span>You send SOL or USDC to the vault.</li>
        <li><span className="sp-step-n">2</span>A locked program splits it 50/50.</li>
        <li><span className="sp-step-n">3</span>Each maintainer gets paid out separately.</li>
      </ol>
      {live && accounts ? (
        <div className="sp-details">
          <dl className="sp-kv">
            <div>
              <dt>Program</dt>
              <dd><a className="sp-link sp-mono" href={explorerAddress(accounts.programId.toBase58())} target="_blank" rel="noreferrer">{shortAddress(accounts.programId.toBase58())}</a></dd>
            </div>
            <div>
              <dt>Vault</dt>
              <dd><a className="sp-link sp-mono" href={explorerAddress(accounts.vault.toBase58())} target="_blank" rel="noreferrer">{shortAddress(accounts.vault.toBase58())}</a></dd>
            </div>
            {([0, 1] as const).map((side) => (
              <div key={side} className="sp-kv-side">
                <dt>{MAINTAINER_LABELS[side]}</dt>
                <dd>
                  {vault ? (
                    <>
                      <a className="sp-link sp-mono" href={explorerAddress(vault.recipients[side])} target="_blank" rel="noreferrer">{shortAddress(vault.recipients[side])}</a>
                      <span className="sp-owed sp-mono">
                        Owed {amountLabel(vault.sol.owed[side], "SOL")} · {amountLabel(vault.usdc.owed[side], "USDC")}
                      </span>
                      <Button variant="secondary" size="sm" label={busy === String(side) ? "Paying out…" : "Pay out"} isDisabled={busy !== ""} onClick={() => void payOut(side)} />
                    </>
                  ) : (
                    <span className="sp-hint">Checking…</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {message ? <p className="sp-hint" role="status">{message}</p> : null}
          <p className="sp-hint">Nobody can move the vault's money anywhere else, including us. Anyone can press Pay out; the money only ever goes to that maintainer.</p>
          <WalletPickerDialog
            isOpen={walletState.pickerOpen}
            wallets={walletState.options}
            connecting={walletState.connecting}
            error={walletState.error}
            onSelect={(id) => void walletState.select(id)}
            onOpenChange={walletState.setPickerOpen}
            onRefresh={walletState.refreshOptions}
          />
        </div>
      ) : null}
    </section>
  );
}

export default function SupportPage() {
  const live = supportReady();
  const tracker = useTracker(live);
  const vaultState = useVault(live);

  return (
    <UseCaseChrome title="Support · ChainPay">
      <div className="support">
        <header className="sp-hero page-width">
          <p className="sp-eyebrow">Support</p>
          <h1 className="t-mega">Like what we're building? Chip in.</h1>
          <p className="t-body sp-hero-text">
            ChainPay is free and open source. If it saved you time, a tip helps cover hosting and keeps us shipping.
          </p>
        </header>

        <div className="sp-layout page-width">
          <div className="sp-side">
            {live ? (
              <SendCard onSent={() => void vaultState.refresh()} />
            ) : (
              <section className="sp-card sp-send" aria-labelledby="sp-soon-title">
                <h2 id="sp-soon-title" className="sp-card-title">Opening soon</h2>
                <p className="t-body">We're finishing the checks on the payout program first.</p>
              </section>
            )}
          </div>
          {live ? (
            <div className="sp-main">
              <RaisedPanel data={tracker.data} failed={tracker.failed} />
              <RecentList data={tracker.data} />
            </div>
          ) : null}
        </div>

        <SplitSection live={live} vaultState={vaultState} />
        {SUPPORT_CLUSTER === "devnet" && live ? (
          <div className="page-width sp-devnet">
            <p className="sp-hint">Devnet rehearsal: test tokens only.</p>
          </div>
        ) : null}
      </div>
    </UseCaseChrome>
  );
}
