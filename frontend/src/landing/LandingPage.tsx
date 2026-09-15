import { BrandLogo } from "../brand/Brand";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { PROGRAM_ID } from "../config/public";
import { PaymentStory, PermissionExample } from "./PaymentStory";
import { SupportedAssets } from "./SupportedAssets";
import { useLandingMotion } from "./useLandingMotion";
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

export function LandingPage({ wallet, connecting, onConnect, onOpenDashboard }: LandingPageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLandingMotion(rootRef);
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
    <div ref={rootRef} className="site-shell cp-app landing">
      <a className="landing-skip" href="#top">Skip to content</a>
      <header className="topbar page-width">
        <a className="brand" href="#top" aria-label="ChainPay home">
          <BrandLogo />
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

      <main id="top" tabIndex={-1}>
        <section className="landing-hero page-width" aria-labelledby="landing-hero-heading">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">Policy payments · Solana Devnet</p>
            <h1 id="landing-hero-heading" className="t-mega">Give agents limits. <em>Not your keys.</em></h1>
            <p className="t-body landing-hero-text">Let agents get work done with a spending permission you define—and a receipt you can verify.</p>
            <div className="landing-hero-actions">
              <Button type="button" variant="primary" size="lg" label="Open dashboard" isDisabled={false} onClick={onOpenDashboard} />
              <Button variant="secondary" size="lg" label="See a receipt" isDisabled={false} href="/verify" />
            </div>
            <p className="t-body-sm landing-hero-note">Your funds stay in your wallet. The mandate defines what the approved agent can spend.</p>
          </div>
          <div className="landing-hero-visual">
            <div className="hero-product-label"><span>YOUR AGENT’S NEXT PAYMENT</span><span>Illustrative example</span></div>
            <PermissionExample />
            <div className="hero-payment-slip"><span className="hero-slip-symbol" aria-hidden="true">↗</span><div><span>Research agent requests</span><strong>4.50 USDC</strong></div><span className="story-tag">For your review</span></div>
            <p className="hero-product-caption">A little autonomy. A clear boundary.</p>
          </div>
        </section>

        <SupportedAssets />
        <PaymentStory onOpenDashboard={onOpenDashboard} />

        <section className="landing-section page-width" id="developers" aria-labelledby="landing-dev-heading">
          <p className="section-kicker">DEVELOPERS</p>
          <h2 id="landing-dev-heading" className="t-xl">Fits the agent workflow you already have.</h2>
          <p className="t-body landing-dev-intro">
            Connect through the TypeScript SDK or Model Context Protocol (MCP), which gives agents tools to prepare payments and inspect results. ChainPay keeps the spending rules on-chain.
          </p>
          <div className="landing-dev-links">
            <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer">MCP docs</a>
            <a href={MCP_TOOLS_URL} target="_blank" rel="noreferrer">MCP tools</a>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub repository</a>
          </div>
          <details className="landing-integration-details"><summary>Integration availability on Devnet</summary><div className="landing-status-grid">
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
          </div></details>
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
          <div className="landing-cta-scroll"><div className="landing-cta">
            <div className="landing-cta-copy">
            <p className="section-kicker">YOUR RULES. THEIR NEXT MOVE.</p>
            <h2 className="t-lg">Put your first agent on a budget.</h2>
            <p>Start on Solana Devnet. Connecting your wallet does not authorize spending.</p>
            <Button type="button" variant="secondary" size="lg" label="Open dashboard" isDisabled={false} onClick={onOpenDashboard} />
            </div>
            <div className="landing-cta-boundaries" aria-hidden="true"><span /><span /><span /></div>
          </div></div>
        </section>
      </main>

      <footer className="landing-footer page-width">
        <a className="brand" href="#top" aria-label="ChainPay home">
          <BrandLogo />
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
