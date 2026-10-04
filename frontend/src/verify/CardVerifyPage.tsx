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

export function CardVerifyPage() {
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  const [state, setState] = useState<State>({ kind: "empty" });

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
  }, [hash]);

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
        {state.kind === "empty" && <p className="t-body">Open a card link that someone shared with you. The shared fields live in the link itself and never reach a server.</p>}
        {state.kind === "invalid" && <div className="receipt-page-state" role="alert" data-kind="invalid"><h2 className="t-xl">This link can't be checked.</h2><p className="t-body">{state.message}</p></div>}
        {state.kind === "loading" && <p className="t-body" aria-busy="true">Reading the card's public checkpoint…</p>}
        {state.kind === "rpc_error" && <div className="receipt-page-state" role="alert" data-kind="rpc_error"><h2 className="t-xl">Checking is unavailable.</h2><p className="t-body">{state.message}</p></div>}
        {state.kind === "no_commitment" && <div className="receipt-page-state" role="alert" data-kind="no_commitment"><h2 className="t-xl">No public checkpoint for this card.</h2><p className="t-body">Nothing was found at <span className="mono">{state.address}</span> on Solana Devnet.</p></div>}
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
            <p className="receipt-identifier-note">Only the fields above were shared. Every other field on this card stays private. The values are shown in the clear; the check proves they match what ChainPay committed on Solana Devnet.</p>
          </article>
        )}
      </section>
    </main>
  );
}

export default CardVerifyPage;
