import { useEffect, useState } from "react";
import { PROGRAM_ID } from "../config/public";
import { Arrow, MiniChart, Shield, shortAddress } from "../ui/marks";
import connectorRoutingImage from "../assets/connector-routing.png";

type Action = "Send" | "Receive" | "Approve mandate" | "Receipts";
type Range = "1H" | "1D" | "1W" | "1M" | "1Y" | "All";

const actions: { label: Action; icon: string; detail: string }[] = [
  { label: "Send", icon: "↗", detail: "Route a policy-checked payment" },
  { label: "Receive", icon: "↙", detail: "Share a stablecoin destination" },
  { label: "Approve mandate", icon: "✦", detail: "Give an agent limited authority" },
  { label: "Receipts", icon: "▤", detail: "Review durable settlement proof" },
];

const assets = [
  { name: "Devnet USDC", symbol: "USDC", price: "$1.00", change: "+0.01%", className: "blue", icon: "$" },
  { name: "Token-2022", symbol: "USDC-2022", price: "$1.00", change: "+0.02%", className: "violet", icon: "◈" },
  { name: "ChainPay receipt", symbol: "RECEIPT", price: "Verified", change: "On-chain", className: "green", icon: "✓" },
];

const connectorRoadmap = [
  { name: "x402", detail: "HTTP payment requests", logo: "https://x402.org/wp-content/uploads/sites/10/2026/06/favicon.png", href: "https://x402.org/" },
  { name: "Lobster.cash", detail: "Scoped agent wallets", logo: "https://www.lobster.cash/lobster-logo-icon.svg", href: "https://www.lobster.cash/" },
  { name: "Your agent stack", detail: "Custom rail adapters", logo: "", href: "" },
] as const;

const useCases = [
  {
    slug: "treasury-approvals",
    number: "01",
    title: "Treasury approvals",
    quote: "Set a capped transfer policy.",
    detail: "Agents can request payments without receiving unrestricted wallet access.",
    headline: "Treasury decisions,",
    accent: "without treasury bottlenecks.",
    summary: "Give a treasury agent a defined stablecoin budget and let ChainPay return a clear approval path for every vendor request.",
    agent: "treasury-agent",
    request: "Release the monthly cloud vendor invoice for 4,500 USDC.",
    requestMeta: "Invoice #CLD-248 · signed merchant request",
    policy: "Operations · USDC spend mandate",
    amount: "4,500 USDC",
    limit: "10,000 USDC",
    outcome: "The agent can request the payment, but the wallet still approves the final transaction.",
    feedback: "The invoice is inside the mandate limit. I prepared the transfer and need your wallet approval to continue.",
    metrics: [
      ["10,000 USDC", "Max per payment"],
      ["30,000 USDC", "Monthly limit"],
      ["3 checks", "Before approval"],
    ],
    flow: [
      ["Request", "Agent attaches the signed vendor invoice."],
      ["Policy", "ChainPay checks the treasury mandate and limits."],
      ["Approval", "The owner wallet reviews and signs once."],
    ],
  },
  {
    slug: "merchant-settlement",
    number: "02",
    title: "Merchant settlement",
    quote: "Route every invoice through one policy.",
    detail: "Preflight the recipient, mint, amount, and mandate before signing.",
    headline: "A better checkout",
    accent: "for agent-run commerce.",
    summary: "Let an agent bring a merchant-signed invoice into one policy-controlled payment path instead of inventing settlement logic for every checkout.",
    agent: "checkout-agent",
    request: "Settle a verified 1.00 PYUSD API-credit invoice.",
    requestMeta: "Invoice #API-2048 · merchant signature verified",
    policy: "API credits · Token-2022 mandate",
    amount: "1.00 PYUSD",
    limit: "10 PYUSD",
    outcome: "The agent can explain the invoice and its checks before it ever asks the wallet to sign.",
    feedback: "Merchant signature, PYUSD mint, recipient, amount, and expiry all passed. The payment is ready for approval.",
    metrics: [
      ["1.00 PYUSD", "Invoice amount"],
      ["5 checks", "Before preparation"],
      ["1 receipt", "Per settlement"],
    ],
    flow: [
      ["Receive", "The agent captures a signed merchant request."],
      ["Verify", "ChainPay derives the payment references and policy quote."],
      ["Settle", "The wallet signs the prepared transaction and receives a receipt."],
    ],
  },
  {
    slug: "programmatic-payouts",
    number: "03",
    title: "Programmatic payouts",
    quote: "Keep recipients and limits explicit.",
    detail: "The protocol records the request and returns a durable receipt.",
    headline: "Payouts your agent can run,",
    accent: "inside the limits you set.",
    summary: "Route routine disbursements through a mandate that defines the asset, spend ceiling, agent authority, and recipient checks up front.",
    agent: "payout-agent",
    request: "Prepare the contractor payout for 250 USDC.",
    requestMeta: "Batch #WEEK-32 · recipient account resolved",
    policy: "Contractor payouts · USDC mandate",
    amount: "250 USDC",
    limit: "2,000 USDC",
    outcome: "Every request remains specific: one amount, one recipient, one policy, and one receipt.",
    feedback: "The recipient account and mandate allowance match this payout. I prepared the transaction for your review.",
    metrics: [
      ["250 USDC", "Payout request"],
      ["2,000 USDC", "Available policy spend"],
      ["1 recipient", "Per payment"],
    ],
    flow: [
      ["Build", "The agent composes an amount and recipient for the payout."],
      ["Check", "ChainPay enforces the mandate, allowance, and token program."],
      ["Record", "A confirmed settlement creates a receipt for the payout."],
    ],
  },
  {
    slug: "reconciliation",
    number: "04",
    title: "Reconciliation",
    quote: "Verify the settlement later.",
    detail: "Look up the receipt PDA and transaction signature from MCP.",
    headline: "Every agent payment leaves",
    accent: "a record you can verify.",
    summary: "Move from agent activity to an auditable payment trail with receipts, deterministic identifiers, and confirmation state available through the same interface.",
    agent: "ops-agent",
    request: "Verify the receipt for invoice #MRCH-1903.",
    requestMeta: "Receipt PDA located · confirmation available",
    policy: "Settlement archive · receipt lookup",
    amount: "4.50 USDC",
    limit: "Confirmed",
    outcome: "Operations can match an invoice to its policy, receipt, and on-chain confirmation without asking the agent to remember what happened.",
    feedback: "The payment receipt is confirmed. I matched the invoice hash, mandate, amount, and settlement reference.",
    metrics: [
      ["1 receipt", "Per settlement"],
      ["On-chain", "Confirmation state"],
      ["Any time", "Receipt lookup"],
    ],
    flow: [
      ["Locate", "Look up the receipt by address or invoice hash."],
      ["Match", "Compare the invoice, mandate, amount, and payment ID."],
      ["Reconcile", "Share a verified settlement reference with operations."],
    ],
  },
] as const;

const verifiedDevnetActivity = [
  ["USDC payment", "6Uut…vgZ", "0.01 USDC", "Finalized", "Slot 484791192", "settled", "6vvJgRXdneFkrqxgvedbkCCGqw4SUqTLvYcEgHsKnbzfZX28uWmQrt3U6ToJGmByf7AxK224Uxz8jSczAVi8x7D"],
  ["PYUSD payment", "6Uut…vgZ", "0.01 PYUSD", "Finalized", "Slot 484803984", "settled", "3yRhnwna13r5SDUsBf2LJdgqGRro7XAGZtaPHbAARfMLbCmQyFS8BWXdyK6qdtpZ48mpc2srvt2UU7LZ63vBLc7"],
] as const;

const agentFeedback = [
  {
    id: "request",
    index: "01",
    label: "Request",
    title: "Signed invoice received",
    detail: "The merchant request, token, recipient, and expiry are captured before any policy check.",
    status: "Signed request",
    tone: "request",
  },
  {
    id: "policy",
    index: "02",
    label: "Policy",
    title: "Five checks passed",
    detail: "ChainPay verified the mint, recipient, limit, expiry, and mandate rules for this payment.",
    status: "Prepared",
    tone: "policy",
  },
  {
    id: "wallet",
    index: "03",
    label: "Wallet",
    title: "Waiting for approval",
    detail: "The transaction is ready, but the wallet still controls the final signature and submission.",
    status: "Awaiting wallet",
    tone: "wallet",
  },
  {
    id: "receipt",
    index: "04",
    label: "Receipt",
    title: "Receipt ready to verify",
    detail: "Once confirmed, ChainPay returns the payment receipt and on-chain reference for reconciliation.",
    status: "Confirmed",
    tone: "receipt",
  },
] as const;

type AgentFeedbackId = (typeof agentFeedback)[number]["id"];

type LandingPageProps = {
  wallet: string;
  connecting: boolean;
  onConnect: () => void;
  onOpenDashboard: () => void;
};

export function LandingPage({ wallet, connecting, onConnect, onOpenDashboard }: LandingPageProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<Action>("Send");
  const [range, setRange] = useState<Range>("1D");
  const [heroMessage, setHeroMessage] = useState<"rail" | "sign">("rail");
  const [activeAgentFeedback, setActiveAgentFeedback] = useState<AgentFeedbackId>("policy");
  const selectedAgentFeedback = agentFeedback.find((item) => item.id === activeAgentFeedback) ?? agentFeedback[0];
  const onPrimary = wallet ? onOpenDashboard : onConnect;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(() => {
      setHeroMessage((current) => current === "rail" ? "sign" : "rail");
    }, 3000);
    return () => window.clearInterval(interval);
  }, []);

  function selectAction(action: Action) {
    setSelectedAction(action);
    document.querySelector("#mandates")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div className="site-shell cp-app">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar page-width">
        <a className="brand" href="#top" aria-label="ChainPay home">
          <span className="brand-mark"><span /></span>
          <span>chain<span>pay</span></span>
        </a>
        <nav className={`main-nav ${menuOpen ? "open" : ""}`}>
          <a href="#products">Products</a>
          <a href="#connectors">Connectors</a>
          <a href="#use-cases">Use cases</a>
          <a href="#/aifi">AiFi</a>
          <a href="#agent-feedback">Agents</a>
          <a href="#how-it-works">How it works</a>
          <a href="#activity">Activity</a>
          <a href="#support">Support</a>
        </nav>
        <div className="top-actions">
          <button className="button button-small button-dark" onClick={onPrimary}>
            {wallet ? shortAddress(wallet) : "Connect"}
          </button>
          <button className="mobile-menu" onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation">☰</button>
        </div>
      </header>

      <main id="top">
        <section className="hero page-width">
          <div className="hero-copy">
            <div className="eyebrow"><span className="pulse-dot" /> Solana Devnet · MCP connected</div>
            <h1 className="hero-headline" aria-live="polite"><span key={heroMessage} className="hero-headline-transition">{heroMessage === "rail" ? <>The universal payment rail for <em>AI agents.</em></> : <>Give agents limits.<br /><em>Not your keys.</em></>}</span></h1>
            <p className="hero-text">One MCP endpoint for policy enforcement, wallet authorization, routing, stablecoin settlement, and receipts. Solana is the first settlement layer.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={onPrimary}>
                {connecting ? "Connecting…" : wallet ? "Open dashboard" : "Connect wallet"} <Arrow />
              </button>
              <a className="text-link" href="#how-it-works">See how it works <Arrow /></a>
            </div>
            <ol className="hero-steps" aria-label="How ChainPay handles an agent payment">
              <li><span>01</span><b>Set a policy</b><small>Limit token, spend, and expiry.</small></li>
              <li><span>02</span><b>Approve in wallet</b><small>Your signing key stays with you.</small></li>
              <li><span>03</span><b>Verify the receipt</b><small>Every settlement leaves proof.</small></li>
            </ol>
          </div>

          <div className="hero-visual" aria-label="ChainPay payment mandate preview">
            <div className="solana-field" aria-hidden="true">
              <span className="solana-ring solana-ring-a"><i /></span>
              <span className="solana-ring solana-ring-b"><i /></span>
              <span className="solana-ring solana-ring-c"><i /></span>
              <span className="solana-core"><b>SOL</b><small>DEVNET</small></span>
            </div>
            <div className="visual-card mandate-card">
              <div className="card-topline"><span className="soft-label">EXAMPLE MANDATE</span><span className="status-pill"><i /> Active</span></div>
              <div className="mandate-balance">$2,000<span>.00</span></div>
              <div className="muted-small">Available agent spend</div>
              <div className="mandate-rule"><span>Max per payment</span><strong>10 USDC</strong></div>
              <div className="mandate-rule"><span>Payment destination</span><strong className="mono">Chosen per payment</strong></div>
              <div className="mandate-rule"><span>Expires</span><strong>7 days</strong></div>
              <div className="spend-track"><span /></div>
              <div className="track-caption"><span>Amount spent</span><strong>20.5 USDC <b>/ 100 USDC</b></strong></div>
              <div className="mandate-card-footer"><span>Payment checks</span><strong><i /> Ready for wallet approval</strong></div>
            </div>
            <div className="floating-receipt receipt-top"><span className="receipt-icon">✓</span><span><b>USDC baseline finalized</b><small>Devnet slot 484791192</small></span><strong>0.01</strong></div>
            <div className="floating-receipt receipt-bottom"><span className="spark-icon">✦</span><span><b>Agent authority</b><small>Limited by ChainPay</small></span></div>
          </div>
        </section>

        <section className="command-section page-width" id="products">
          <div className="section-heading compact-heading"><div><span className="section-kicker">CONTROL CENTER</span><h2>Move money with confidence.</h2></div><span className="network-chip"><i /> Program live on Devnet</span></div>
          <div className="command-grid">
            <div className="command-panel">
              <div className="command-balance"><div><span className="soft-label">EXAMPLE POLICY</span><h3>$2,000<span>.00</span></h3><p>Illustrative Devnet flow</p></div><div className="balance-orb"><Shield /></div></div>
              <div className="range-row">{(["1H", "1D", "1W", "1M", "1Y", "All"] as Range[]).map((item) => <button className={range === item ? "selected" : ""} key={item} onClick={() => setRange(item)}>{item}</button>)}</div>
              <div className="large-chart"><div className="chart-gridline one" /><div className="chart-gridline two" /><div className="chart-gridline three" /><svg viewBox="0 0 650 220" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="main-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#6d7cff" stopOpacity=".3" /><stop offset="1" stopColor="#6d7cff" stopOpacity="0" /></linearGradient></defs><path fill="url(#main-fill)" d="M0 186C37 178 46 173 75 177S102 160 130 168S160 147 190 157S216 125 244 145S273 131 298 137S328 114 357 126S386 104 411 119S447 90 475 105S502 69 529 85S559 63 582 71S615 37 650 20V220H0Z" /><path className="main-line" d="M0 186C37 178 46 173 75 177S102 160 130 168S160 147 190 157S216 125 244 145S273 131 298 137S328 114 357 126S386 104 411 119S447 90 475 105S502 69 529 85S559 63 582 71S615 37 650 20" /></svg><span className="chart-tooltip">$2,000.00</span></div>
            </div>
            <div className="action-panel" id="mandates"><div className="panel-title"><div><span className="soft-label">QUICK ACTIONS</span><h3>What do you need?</h3></div><span className="mcp-badge"><span /> MCP</span></div><div className="action-list">{actions.map((action) => <button className={`action-row ${selectedAction === action.label ? "active" : ""}`} key={action.label} onClick={() => selectAction(action.label)}><span className="action-icon">{action.icon}</span><span><b>{action.label}</b><small>{action.detail}</small></span><Arrow /></button>)}</div><div className="action-note"><Shield /><span>{selectedAction} selected</span><small>{actions.find((action) => action.label === selectedAction)?.detail}</small></div></div>
          </div>
        </section>

        <section className="agentic-section page-width" id="agent-feedback">
          <div className="section-heading">
            <div>
              <span className="section-kicker">AGENT FEEDBACK LOOP</span>
              <h2>Every request answers back.</h2>
              <p>Give your agent a clear payment path and a clear explanation of what happened at each checkpoint.</p>
            </div>
            <a className="agentic-live-label" href="#/aifi"><i /> AiFi · policy-aware finance <Arrow /></a>
          </div>

          <div className="agentic-grid">
            <article className="agent-inbox-preview">
              <div className="agentic-card-topline">
                <div><span className="soft-label">AGENT INBOX</span><strong>Incoming payment request</strong></div>
                <span className="agentic-chip"><i /> Signed</span>
              </div>

              <div className="agent-message-bubble">
                <span className="agent-message-avatar">AP</span>
                <div>
                  <span className="agent-message-meta">procure-agent · just now</span>
                  <p>“I found a 1.00 PYUSD merchant invoice. I verified the signature and matched it to your mandate.”</p>
                </div>
              </div>

              <div className="agent-request-grid">
                <div><span>Merchant</span><strong className="mono">cloud-api…4f2a</strong></div>
                <div><span>Token</span><strong>PYUSD · Token-2022</strong></div>
                <div><span>Amount</span><strong className="agentic-amount">1.00 PYUSD</strong></div>
                <div><span>Expiry</span><strong>Devnet slot + 4,820</strong></div>
              </div>

              <div className="agent-check-list" aria-label="Payment checks">
                <span><i>✓</i> Merchant signature</span>
                <span><i>✓</i> Mandate limit</span>
                <span><i>✓</i> Recipient check</span>
                <span><i>✓</i> Token program</span>
              </div>
            </article>

            <article className="agent-feedback-card">
              <div className="agentic-card-topline">
                <div><span className="soft-label">CHAINPAY RESPONSE</span><strong>What the agent can report</strong></div>
                <span className={`agent-response-status ${selectedAgentFeedback.tone}`}>{selectedAgentFeedback.status}</span>
              </div>

              <div className="agent-feedback-copy">
                <span className="agent-feedback-index">{selectedAgentFeedback.index}</span>
                <div>
                  <h3>{selectedAgentFeedback.title}</h3>
                  <p>{selectedAgentFeedback.detail}</p>
                </div>
              </div>

              <div className="agent-stage-list" role="tablist" aria-label="Agent payment stages">
                {agentFeedback.map((item) => (
                  <button
                    className={activeAgentFeedback === item.id ? "active" : ""}
                    key={item.id}
                    role="tab"
                    aria-selected={activeAgentFeedback === item.id}
                    onClick={() => setActiveAgentFeedback(item.id)}
                  >
                    <span>{item.index}</span>{item.label}
                  </button>
                ))}
              </div>

              <div className="agent-payment-feed">
                <div><span className="agent-feed-icon prepared">◇</span><span><b>Invoice #CP-2048</b><small>Policy checked for 1.00 PYUSD</small></span><em>Prepared</em></div>
                <div><span className="agent-feed-icon wallet">✦</span><span><b>Wallet approval</b><small>Owner signature is still required</small></span><em>Pending</em></div>
                <div><span className="agent-feed-icon receipt">◇</span><span><b>Receipt PDA</b><small>Created only after real settlement</small></span><em>Waiting</em></div>
              </div>
            </article>
          </div>
        </section>

        <section className="assets-section page-width">
          <div className="section-heading"><div><span className="section-kicker">SUPPORTED RAILS</span><h2>Built for stablecoin settlement.</h2><p>Connect the assets your agents already use. ChainPay handles the policy; Solana handles settlement.</p></div><a className="text-link" href="#support">View all assets <Arrow /></a></div>
          <div className="asset-grid">{assets.map((asset) => <article className="asset-card" key={asset.symbol}><div className="asset-card-top"><span className={`asset-logo ${asset.className}`}>{asset.icon}</span><span className="asset-more">···</span></div><h3>{asset.name}</h3><div className="asset-pair">{asset.symbol} <span>/ DEVNET</span></div><div className="asset-price">{asset.price}</div><div className={`asset-change ${asset.change.startsWith("+") ? "positive" : "neutral"}`}>{asset.change}</div><MiniChart color={asset.className} /><button className="asset-button" onClick={() => selectAction(asset.symbol === "RECEIPT" ? "Receipts" : "Send")}>{asset.symbol === "RECEIPT" ? "View receipts" : "Route payment"} <Arrow /></button></article>)}</div>
        </section>

        <section className="connector-section page-width" id="connectors">
          <div className="connector-copy">
            <span className="section-kicker">FUTURE CONNECTOR ROADMAP</span>
            <h2>More payment paths.<br /><em>One policy layer.</em></h2>
            <p>Stablecoin transfers on Solana Devnet are live today. Next, ChainPay will route approved payment requests through agent-native payment networks without weakening the policy controls you set.</p>
            <div className="connector-live-note"><span className="connector-live-icon">◈</span><span><b>Live today</b><small>Policy-checked stablecoin transfers on Solana Devnet</small></span></div>
            <a className="text-link" href="#products">Route a stablecoin payment <Arrow /></a>
          </div>
          <div className="connector-stage" aria-label="Connector roadmap preview">
            <img className="connector-route-art" src={connectorRoutingImage} alt="Abstract payment routes branching from a policy layer" loading="lazy" />
            <div className="connector-stage-overlay" aria-hidden="true" />
            <div className="connector-anchor-card"><span className="soft-label">CHAINPAY</span><strong>Policy layer</strong><small>Limits, approval, and receipts stay in one place.</small></div>
            <div className="connector-stack">
              {connectorRoadmap.map((connector, index) => <article className={`connector-card connector-card-${index + 1}`} key={connector.name}>
                <span className="connector-logo">{connector.logo ? <img src={connector.logo} alt="" loading="lazy" /> : "＋"}</span>
                <span><strong>{connector.name}</strong><small>{connector.detail}</small></span>
                {connector.href ? <a href={connector.href} target="_blank" rel="noreferrer" aria-label={`Learn about ${connector.name}`}>↗</a> : <span className="connector-more">+</span>}
              </article>)}
            </div>
            <span className="connector-coming-soon">Coming soon</span>
          </div>
        </section>

        <section className="use-cases-section page-width" id="use-cases">
          <div className="section-heading"><div><span className="section-kicker">USE CASES</span><h2>One interface. Every agent payment.</h2><p>If an agent needs to move money, it calls ChainPay. The agent does not need to understand the underlying wallet, connector, or settlement rail.</p></div><a className="text-link" href="#how-it-works">See the flow <Arrow /></a></div>
          <div className="use-case-grid">{useCases.map((useCase) => <a className="use-case-card" href={`#/use-cases/${useCase.slug}`} key={useCase.title}><span className="use-case-number">{useCase.number}</span><h3>{useCase.title}</h3><p className="use-case-quote">{useCase.quote}</p><p>{useCase.detail}</p><span className="use-case-link">Explore this flow <Arrow /></span></a>)}</div>
        </section>

        <section className="market-section page-width" id="activity">
          <div className="section-heading"><div><span className="section-kicker">VERIFIED DEVNET ACTIVITY</span><h2>Inspect the proof.</h2></div><span className="live-label"><i /> Finalized on-chain</span></div>
          <div className="market-table"><div className="table-head"><span>#</span><span>Activity</span><span>Amount</span><span>Status</span><span>Slot</span><span /></div>{verifiedDevnetActivity.map((item, index) => <div className="table-row" key={item[6]}><span className="row-number">0{index + 1}</span><span className="activity-cell"><span className={`activity-avatar ${item[5]}`}>↗</span><span><b>{item[0]}</b><small>{item[1]}</small></span></span><strong>{item[2]}</strong><span className={`table-status ${item[5]}`}><i />{item[3]}</span><span className="row-time">{item[4]}</span><a className="row-arrow" href={`https://explorer.solana.com/tx/${item[6]}?cluster=devnet`} target="_blank" rel="noreferrer" aria-label={`Open ${item[0]} on Solana Explorer`}>→</a></div>)}</div>
        </section>

        <section className="proof-section page-width"><div className="proof-copy"><span className="section-kicker">WHY CHAINPAY</span><h2>Your money.<br /><em>Your rules.</em></h2><p>Give an agent a mandate with a clear token, limit, and expiry. Each payment names its own destination, and you keep the signing key.</p><a className="text-link" href="#how-it-works">Learn about mandates <Arrow /></a></div><div className="proof-stats"><div className="proof-stat"><strong>On-chain</strong><span>Policy enforcement</span></div><div className="proof-stat"><strong>Wallet</strong><span>Always approves signing</span></div><div className="proof-stat"><strong>One</strong><span>Receipt per settlement</span></div><div className="proof-stat"><strong>Devnet</strong><span>Start with a safe demo</span></div></div></section>

        <section className="steps-section page-width" id="how-it-works"><div className="section-heading centered"><span className="section-kicker">SIMPLE STEPS</span><h2>Start routing in minutes.</h2><p>From wallet connection to verified settlement, ChainPay keeps every step visible.</p></div><div className="steps-grid"><div className="step-card"><span className="step-number">01.</span><span className="step-icon">◈</span><h3>Connect wallet</h3><p>Connect your Solana wallet on Devnet. Your private key stays with you.</p></div><div className="step-card"><span className="step-number">02.</span><span className="step-icon">◇</span><h3>Create a mandate</h3><p>Choose a token, spend limit, and expiration for your agent.</p></div><div className="step-card"><span className="step-number">03.</span><span className="step-icon">✦</span><h3>Let agents request</h3><p>Agents supply one destination with each payment. ChainPay checks every request on-chain.</p></div><div className="step-card"><span className="step-number">04.</span><span className="step-icon">▤</span><h3>Verify settlement</h3><p>Successful payments create durable receipts for everyone to reconcile.</p></div></div></section>

        <section className="cta-section page-width" id="support"><span className="section-kicker">READY WHEN YOU ARE</span><h2>Give agents one payment interface.<br /><em>Keep the control.</em></h2><p>Create your first policy and connect a settlement rail on Solana Devnet.</p><button className="button button-light" onClick={onPrimary}>{wallet ? "Open mandate dashboard" : "Get started"} <Arrow /></button></section>
      </main>

      <footer className="footer page-width"><div className="footer-main"><div className="footer-brand"><a className="brand" href="#top"><span className="brand-mark"><span /></span><span>chain<span>pay</span></span></a><p>Solana Summer School bootcamp project building a policy-controlled payment rail for AI agents.</p><div className="footer-status"><i /> Solana Devnet</div></div><div className="footer-links"><div><b>PRODUCTS</b><a href="#products">Mandates</a><a href="#products">Payments</a><a href="#use-cases">Use cases</a><a href="#activity">Receipts</a></div><div><b>BUILD</b><a href="#how-it-works">How it works</a><a href="https://chainpay-mcp.onrender.com/docs" target="_blank" rel="noreferrer">MCP docs</a><a href="https://chainpay-mcp.onrender.com/tools" target="_blank" rel="noreferrer">MCP tools</a><a href="https://github.com/stawuah/chainpay-mcp-sdk" target="_blank" rel="noreferrer">GitHub repository</a></div><div><b>SOLANA</b><a href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noreferrer">Program on Explorer</a><a href="https://api.devnet.solana.com" target="_blank" rel="noreferrer">Devnet RPC</a><a href="https://chainpay-mcp.onrender.com/healthz" target="_blank" rel="noreferrer">MCP status</a></div></div><div className="newsletter"><b>Stay in the loop</b><p>Product updates, protocol news, and Devnet drops.</p><div className="email-box"><input placeholder="Your email" aria-label="Your email" /><button aria-label="Subscribe">→</button></div></div></div><div className="footer-bottom"><span>© 2026 ChainPay. Built on Solana.</span><span>Program <button className="copy-id" onClick={() => navigator.clipboard?.writeText(PROGRAM_ID)}><span className="mono">{shortAddress(PROGRAM_ID)}</span> ⧉</button></span></div></footer>
    </div>
  );
}

export default LandingPage;
