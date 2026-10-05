import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import {
  decodeCardCommitment,
  decodeDisclosureFragment,
  deriveCardCommitmentAddress,
  verifyDisclosureBundle,
  type CardCommitment,
  type DisclosureBundle,
  type DisclosureCheck,
} from "@chainpay/sdk";
import { BrandLogo } from "../brand/Brand";
import { CARD_POLICY_PROGRAM_ID } from "../config/public";
import "../receipts/receipt-card.css";
import "../dashboard/cards/cards.css";

export const CARD_VERIFY_COPY = "Integrity check against ChainPay's on-chain commitment, not a zero-knowledge proof.";

export type CardCommitmentReader = (binding: string) => Promise<{ address: string; commitment: CardCommitment | null }>;

async function defaultReader(binding: string) {
  const { publicReceiptClient } = await import("../config/client");
  const address = deriveCardCommitmentAddress(binding, CARD_POLICY_PROGRAM_ID);
  const info = await publicReceiptClient.connection.getAccountInfo(new PublicKey(address), "finalized");
  return { address, commitment: info ? decodeCardCommitment(info.data) : null };
}

let reader: CardCommitmentReader = defaultReader;

/** Harness and tests only. */
export function setCardCommitmentReader(next: CardCommitmentReader | null) {
  reader = next ?? defaultReader;
}

type State =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "loading"; bundle: DisclosureBundle }
  | { kind: "no_commitment"; bundle: DisclosureBundle; address: string }
  | { kind: "rpc_error"; bundle: DisclosureBundle; message: string }
  | { kind: "checked"; bundle: DisclosureBundle; address: string; check: DisclosureCheck };

const HEADLINE: Record<DisclosureCheck["state"], string> = {
  verified: "Every shared field matches the card's public checkpoint.",
  mismatch: "Some shared fields don't match the card's public checkpoint.",
  superseded: "This link is from an older checkpoint, so it can't be checked anymore.",
  wrong_card: "This link doesn't belong to the card it names.",
};

/**
 * The shared fields of a pasted card link: a full link with `#disclose=…`, or
 * the fragment alone. Read locally; the pasted link is never opened or fetched.
 */
export function disclosureFragmentFromInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const hashAt = value.indexOf("#");
  const fragment = hashAt >= 0 ? value.slice(hashAt + 1) : value;
  return /(?:^|&)disclose=[A-Za-z0-9_-]+/.test(fragment) ? fragment : null;
}

function CardLinkEntry({ onFragment }: { onFragment: (fragment: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="verify-entry verify-entry-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const fragment = disclosureFragmentFromInput(value);
        if (!fragment) {
          setError(value.trim() ? "That isn't a shared card link. It should contain #disclose=." : "Paste the card link someone shared with you.");
          return;
        }
        setError("");
        onFragment(fragment);
      }}
    >
      <label className="verify-entry-label" htmlFor="card-verify-link">Shared card link</label>
      <input
        id="card-verify-link"
        className="verify-entry-input mono"
        value={value}
        onChange={(event) => { setValue(event.target.value); if (error) setError(""); }}
        placeholder="https://…/verify/card#disclose=…"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "card-verify-link-error" : undefined}
      />
      <button type="submit" className="button button-primary">Check this link</button>
      {error && <p id="card-verify-link-error" className="verify-entry-error" role="alert">{error}</p>}
    </form>
  );
}

const UNCHECKED_NOTE: Record<Exclude<DisclosureCheck["state"], "verified">, string> = {
  mismatch: "Only the fields above were shared. Some don't match ChainPay's commitment on Solana Devnet, so don't rely on them. Ask whoever shared the link for a fresh one.",
  superseded: "Only the fields above were shared. The card has a newer checkpoint, so these values can't be confirmed. Ask whoever shared the link for a fresh one.",
  wrong_card: "Only the fields above were shared. They belong to a different card than the one named, so don't rely on them.",
};

export function CardVerifyPage() {
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  const [state, setState] = useState<State>({ kind: "empty" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!hash.includes("disclose=")) { setState({ kind: "empty" }); return; }
    let bundle: DisclosureBundle;
    try {
      bundle = decodeDisclosureFragment(hash);
    } catch (error) {
      setState({ kind: "invalid", message: error instanceof Error ? error.message : "This link can't be read" });
      return;
    }
    let active = true;
    setState({ kind: "loading", bundle });
    reader(bundle.binding).then(
      async ({ address, commitment }) => {
        if (!active) return;
        if (!commitment) { setState({ kind: "no_commitment", bundle, address }); return; }
        const check = await verifyDisclosureBundle(bundle, commitment);
        if (active) setState({ kind: "checked", bundle, address, check });
      },
      () => { if (active) setState({ kind: "rpc_error", bundle, message: "Solana Devnet didn't answer. Try again in a moment." }); },
    );
    return () => { active = false; };
  }, [hash, attempt]);

  // The fragment stays in this tab's URL. Browsers never send it to a server.
  const openFragment = (fragment: string) => {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${fragment}`);
    setHash(`#${fragment}`);
  };
  const retry = <button type="button" className="button button-primary" style={{ marginTop: 16 }} onClick={() => setAttempt((n) => n + 1)}>Try again</button>;

  return (
    <main className="site-shell cp-app verify-page cp-card-verify">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home"><BrandLogo /></a>
        <a className="login-link" href="/">Back to ChainPay</a>
      </header>
      <section className="page-width" style={{ padding: "48px 0 80px" }}>
        <span className="section-kicker">SHARED CARD RECORD</span>
        <h1 className="t-xl">Card record check</h1>
        <p className="cp-verify-copy" data-testid="card-verify-copy">{CARD_VERIFY_COPY}</p>
        {state.kind === "empty" && <><p className="t-body">Paste a card link someone shared with you. The shared fields live in the link itself and never reach a server.</p><CardLinkEntry onFragment={openFragment} /></>}
        {state.kind === "invalid" && <><div className="receipt-page-state" role="alert" data-kind="invalid"><h2 className="t-xl">This link can't be checked.</h2><p className="t-body">{state.message}</p></div><CardLinkEntry onFragment={openFragment} /></>}
        {state.kind === "loading" && <p className="t-body" aria-busy="true">Reading the card's public checkpoint…</p>}
        {state.kind === "rpc_error" && <div className="receipt-page-state" role="alert" data-kind="rpc_error"><h2 className="t-xl">Checking is unavailable.</h2><p className="t-body">{state.message}</p>{retry}</div>}
        {state.kind === "no_commitment" && <div className="receipt-page-state" role="alert" data-kind="no_commitment"><h2 className="t-xl">No public checkpoint for this card.</h2><p className="t-body">Nothing was found at <span className="mono">{state.address}</span> on Solana Devnet. A new card's checkpoint can take a moment to appear.</p>{retry}</div>}
        {state.kind === "checked" && (
          <article className="receipt-card cp-card-verify-result" data-check={state.check.state} data-testid="card-verify-result">
            <div className="cp-verify-headline" data-tone={state.check.state === "verified" ? "yes" : "no"}>
              {state.check.state === "verified" ? <CircleCheck size={22} aria-hidden="true" /> : state.check.state === "superseded" ? <TriangleAlert size={22} aria-hidden="true" /> : <CircleX size={22} aria-hidden="true" />}
              <h2>{HEADLINE[state.check.state]}</h2>
            </div>
            <ul className="cp-verify-fields">
              {state.check.leaves.map((leaf) => (
                <li key={leaf.i} data-ok={state.check.state === "verified" || state.check.state === "mismatch" ? (leaf.ok ? "yes" : "no") : "unchecked"}>
                  <span aria-hidden="true">{state.check.state === "verified" || state.check.state === "mismatch" ? (leaf.ok ? "✓" : "×") : "·"}</span>
                  <div><b>{leaf.field.label}</b><strong>{leaf.field.value}</strong>{leaf.field.detail && <small>{leaf.field.detail}</small>}</div>
                </li>
              ))}
            </ul>
            <dl className="receipt-summary">
              <dt>Card</dt><dd>{state.bundle.binding}</dd>
              <dt>Checkpoint</dt><dd>{state.check.state === "superseded" ? `#${state.check.bundleSeq} in this link · #${state.check.chainSeq} on Solana now` : `#${state.bundle.commitmentSeq}`}</dd>
              {(state.check.state === "verified" || state.check.state === "mismatch") && <><dt>Written at slot</dt><dd>{state.check.writtenSlot}</dd><dt>Public commitment</dt><dd>{state.check.root}</dd></>}
              <dt>Read from</dt><dd>{state.address}</dd>
            </dl>
            {state.check.state === "verified" ? (
              <p className="receipt-identifier-note" data-testid="card-verify-note">Only the fields above were shared; the card's other fields aren't in this link. The card's public account (above) shows the owner's wallet address. The values are shown in the clear; the check proves they match what ChainPay committed on Solana Devnet.</p>
            ) : (
              <p className="receipt-identifier-note" data-testid="card-verify-note">{UNCHECKED_NOTE[state.check.state]}</p>
            )}
          </article>
        )}
      </section>
    </main>
  );
}

export default CardVerifyPage;
