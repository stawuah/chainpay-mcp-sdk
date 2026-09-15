import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { PROGRAM_ID } from "../config/public";
import "./landing.css";

const MCP_DOCS_URL = "https://chainpay-mcp.onrender.com/docs";
const MCP_TOOLS_URL = "https://chainpay-mcp.onrender.com/tools";
const REPOSITORY_URL = "https://github.com/stawuah/chainpay-mcp-sdk";
const PROGRAM_EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`;

const NAV_LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#spend-limits", label: "Spend limits" },
  { href: "#receipts", label: "Receipts" },
  { href: "#developers", label: "Developers" },
] as const;

const FLOW_STEPS = [
  {
    index: "1",
    title: "Approve a mandate",
    body: "Choose the agent, token, limits and expiry, then approve in your wallet.",
  },
  {
    index: "2",
    title: "Pay within the limit",
    body: "The program checks each payment against the mandate.",
  },
  {
    index: "3",
    title: "Verify the result",
    body: "Share the settled receipt with someone who never connected a wallet.",
  },
] as const;

const LIMIT_CONTROLS = [
  ["Approved agent", "The only key that may execute inside this mandate."],
  ["Token / source account", "The mint and source token account payments can leave."],
  ["Maximum per payment", "A single payment cannot exceed this amount."],
  ["Total allowance", "All payments together cannot exceed this amount."],
  ["Count", "Optional cap on how many payments may settle."],
  ["Cooldown", "Optional wait between payments."],
  ["Expiry", "The mandate stops new payments after this slot."],
  ["Pause / revoke", "A wallet-approved action that stops future payments."],
] as const;

const FAQ_ITEMS = [
  {
    question: "Who holds the funds?",
    answer: "The owner wallet; the program enforces the approved mandate.",
  },
  {
    question: "Can I stop future payments?",
    answer: "Pause or revoke the mandate through a wallet-approved action.",
  },
  {
    question: "Does a receipt prove delivery?",
    answer: "It proves settlement. Seller response-served statements are separate evidence.",
  },
  {
    question: "Is this Mainnet?",
    answer: "This build uses Solana Devnet.",
  },
] as const;

type LandingPageProps = {
  wallet: string;
  connecting: boolean;
  onConnect: () => void;
  onOpenDashboard: () => void;
};

function shortAddress(value: string) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function IllustrativeReceiptCard({ compact = false }: { compact?: boolean }) {
  return (
    <article className={`landing-receipt${compact ? " is-compact" : ""}`} aria-label="Illustrative receipt">
      <p className="landing-receipt-label">Illustrative receipt · no payment made</p>
      <h3 className="landing-receipt-amount t-num">4.50 USDC</h3>
      <p className="landing-receipt-lede">Payment receipt for an example mandate-checked transfer.</p>
      <dl className="landing-receipt-evidence">
        <div>
          <dt>Allowed</dt>
          <dd>The program accepted this payment under the mandate.</dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd>Settlement verified from the receipt on Solana.</dd>
        </div>
        <div>
          <dt>Seller attestation</dt>
          <dd>Missing. A seller can sign a statement that it served a specific response. It does not prove the buyer received or accepted the work.</dd>
        </div>
      </dl>
      <details className="landing-receipt-mandate">
        <summary>Current mandate</summary>
        <dl>
          <div>
            <dt>Max per payment</dt>
            <dd className="t-num">10 USDC</dd>
          </div>
          <div>
            <dt>Total allowance</dt>
            <dd className="t-num">100 USDC</dd>
          </div>
          <div>
            <dt>Seller attestation</dt>
            <dd>Missing</dd>
          </div>
        </dl>
        <p>These limits are the current mandate shape, not a historical snapshot of a live payment.</p>
      </details>
    </article>
  );
}

export function LandingPage({ wallet, connecting, onConnect, onOpenDashboard }: LandingPageProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <div className="site-shell cp-app landing">
      <header className="topbar page-width">
        <a className="brand" href="#top" aria-label="ChainPay home">
          <span className="brand-mark"><span /></span>
          <span>chain<span>pay</span></span>
        </a>
        <nav id={navId} className={`main-nav${menuOpen ? " open" : ""}`} aria-label="Landing">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} onClick={closeMenu}>{link.label}</a>
          ))}
          {!wallet && (
            <button type="button" className="landing-nav-connect" onClick={() => { closeMenu(); onConnect(); }} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </nav>
        <div className="top-actions">
          {wallet ? <span className="landing-wallet t-num">{shortAddress(wallet)}</span> : null}
          <Button type="button" variant="primary" size="sm" label="Open dashboard" isDisabled={false} onClick={onOpenDashboard} />
          <button
            ref={menuButtonRef}
            className="mobile-menu"
            type="button"
            aria-expanded={menuOpen}
            aria-controls={navId}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>
      </header>

      <main id="top">
        <section className="landing-hero page-width" aria-labelledby="landing-hero-heading">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">Policy payments · Solana Devnet</p>
            <h1 id="landing-hero-heading" className="t-mega">Give agents limits. <em>Not your keys.</em></h1>
            <p className="t-body landing-hero-text">Approve a mandate. Let your agent pay within it. Open the receipt when you need proof.</p>
            <div className="landing-hero-actions">
              <Button type="button" variant="primary" size="lg" label="Open dashboard" isDisabled={false} onClick={onOpenDashboard} />
              <Button variant="secondary" size="lg" label="See a receipt" isDisabled={false} href="#receipts" />
            </div>
            <p className="t-body-sm landing-hero-note">Your funds stay in your wallet. The mandate defines what the approved agent can spend.</p>
          </div>
          <div className="landing-hero-visual">
            <IllustrativeReceiptCard compact />
          </div>
        </section>

        <section className="landing-section page-width" id="how-it-works" aria-labelledby="landing-flow-heading">
          <p className="section-kicker">ONE EXAMPLE</p>
          <h2 id="landing-flow-heading" className="t-xl">From a spend limit to a receipt.</h2>
          <ol className="landing-flow">
            {FLOW_STEPS.map((step) => (
              <li key={step.index}>
                <span className="landing-flow-index t-num">{step.index}</span>
                <h3 className="t-title">{step.title}</h3>
                <p className="t-body">{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="t-body-sm landing-flow-example">
            Example: a <span className="t-num">4.50 USDC</span> payment inside a mandate of{" "}
            <span className="t-num">10 USDC</span> per payment and <span className="t-num">100 USDC</span> total.
            Seller attestation is missing. Category or purpose is not an enforced policy field.
          </p>
        </section>

        <section className="landing-section landing-section-soft" id="spend-limits" aria-labelledby="landing-limits-heading">
          <div className="page-width">
            <p className="section-kicker">SPEND LIMITS</p>
            <h2 id="landing-limits-heading" className="t-xl">Set the boundary before the first payment.</h2>
            <ul className="landing-limits">
              {LIMIT_CONTROLS.map(([title, detail]) => (
                <li key={title}>
                  <strong>{title}</strong>
                  <p className="t-body-sm">{detail}</p>
                </li>
              ))}
            </ul>
            <p className="t-body landing-limits-note">
              New payments must satisfy the on-chain mandate. Revoking a mandate does not undo a settled payment.
              Delegated execution uses the approved agent&apos;s signature within the mandate; not every payment needs a new owner signature.
            </p>
          </div>
        </section>

        <section className="landing-proof" id="receipts" aria-labelledby="landing-proof-heading">
          <div className="page-width landing-proof-grid">
            <div className="landing-proof-copy">
              <p className="landing-kicker-light">PROOF</p>
              <h2 id="landing-proof-heading" className="t-xl">A receipt someone else can understand.</h2>
              <p className="landing-proof-lede">
                The public reader needs amount, mint, recipient, settlement state and evidence before addresses and instruction names.
              </p>
              <ul className="landing-proof-points">
                <li><strong>Allowed.</strong> The program accepted this payment under the mandate.</li>
                <li><strong>Paid.</strong> Settlement verified from the receipt on Solana.</li>
                <li><strong>Seller attestation.</strong> A seller can sign a statement that it served a specific response. It does not prove the buyer received or accepted the work.</li>
              </ul>
            </div>
            <IllustrativeReceiptCard />
          </div>
        </section>

        <section className="landing-section page-width" id="developers" aria-labelledby="landing-dev-heading">
          <p className="section-kicker">DEVELOPERS</p>
          <h2 id="landing-dev-heading" className="t-xl">Fits the agent workflow you already have.</h2>
          <p className="t-body landing-dev-intro">
            MCP and the TypeScript SDK are the integration surfaces. Protocol compatibility is not live acceptance.
          </p>
          <div className="landing-dev-links">
            <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer">MCP docs</a>
            <a href={MCP_TOOLS_URL} target="_blank" rel="noreferrer">MCP tools</a>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub repository</a>
          </div>
          <div className="landing-status-grid">
            <article>
              <h3 className="t-title">Custom x402/1.0</h3>
              <p className="t-body-sm">A custom receipt-proof adapter exists. Proof is a signature plus receipt PDA, not a sponsored transaction.</p>
            </article>
            <article>
              <h3 className="t-title">Standard x402 v2</h3>
              <p className="t-body-sm">Recognized and returned as unsupported-sponsor before wallet, signing, or settlement. Not live facilitator acceptance.</p>
            </article>
            <article>
              <h3 className="t-title">Managed signing</h3>
              <p className="t-body-sm">Optional delegated approved-agent setup in the dashboard. The owner still approves the mandate. This is not hosted key custody for visitors.</p>
            </article>
          </div>
        </section>

        <section className="landing-section landing-close page-width" id="faq" aria-labelledby="landing-faq-heading">
          <p className="section-kicker">FAQ</p>
          <h2 id="landing-faq-heading" className="t-xl">Questions before you approve a mandate.</h2>
          <div className="landing-faq">
            {FAQ_ITEMS.map((item) => (
              <details key={item.question}>
                <summary>{item.question}</summary>
                <p className="t-body">{item.answer}</p>
              </details>
            ))}
          </div>
          <div className="landing-cta">
            <h2 className="t-lg">Create your first mandate.</h2>
            <Button type="button" variant="primary" size="lg" label="Open dashboard" isDisabled={false} onClick={onOpenDashboard} />
          </div>
        </section>
      </main>

      <footer className="landing-footer page-width">
        <a className="brand" href="#top" aria-label="ChainPay home">
          <span className="brand-mark"><span /></span>
          <span>chain<span>pay</span></span>
        </a>
        <p className="t-body-sm">Policy-controlled agent payments on Solana Devnet. The owner wallet holds the funds.</p>
        <div className="landing-footer-links">
          <a href={PROGRAM_EXPLORER_URL} target="_blank" rel="noreferrer">Program on Explorer</a>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub</a>
          <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer">MCP docs</a>
        </div>
      </footer>
    </div>
  );
}

export default LandingPage;
