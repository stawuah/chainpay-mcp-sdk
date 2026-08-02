import { useEffect, useState } from "react";
import { Buffer } from "buffer";
import { ChainPayClient, buildCreateAssociatedTokenAccountInstruction, bytesToHex, deriveAssociatedTokenAddress, deriveMandateAddress, toWeb3Transaction } from "@chainpay/sdk";
import type { Mandate, PreparedMandate, PreparedPayment, PreparedTransaction, SimulationResult, TokenProgram } from "@chainpay/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

type Action = "Send" | "Receive" | "Approve mandate" | "Receipts";
type Range = "1H" | "1D" | "1W" | "1M" | "1Y" | "All";

type SolanaProvider = {
  publicKey?: { toString(): string };
  connect?: () => Promise<{ publicKey: { toString(): string } }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
};

type SpeechRecognitionResult = { 0: { transcript: string } };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: { 0: SpeechRecognitionResult } }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    solana?: SolanaProvider;
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const PROGRAM_ID = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const BACKEND_URL = import.meta.env.VITE_CHAINPAY_BACKEND_URL ?? (import.meta.env.DEV ? "/api" : "");
const RPC_URL = import.meta.env.VITE_CHAINPAY_RPC_URL ?? (import.meta.env.DEV ? "/rpc" : "https://api.devnet.solana.com");
const MCP_URL = import.meta.env.VITE_CHAINPAY_MCP_URL ?? "https://chainpay-mcp.onrender.com/mcp";
const chainpayClient = new ChainPayClient({ rpcUrl: RPC_URL, programId: PROGRAM_ID });

type McpTool = { name: string; description?: string };
type McpToolResponse = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };

async function mcpRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `MCP request failed (${response.status})`);
  return payload.result as T;
}

async function callMcpTool(name: string, args: Record<string, unknown>) {
  return mcpRequest<McpToolResponse>("tools/call", { name, arguments: args });
}

async function submitSignedTransaction(idempotencyKey: string, signedTransaction: Uint8Array) {
  if (!BACKEND_URL) throw new Error("VITE_CHAINPAY_BACKEND_URL is not configured.");
  const response = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/v1/transactions/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      signed_transaction: Buffer.from(signedTransaction).toString("base64"),
    }),
  });
  const payload = await response.json() as {
    status?: string;
    signature?: string;
    error?: string;
  };
  if (!response.ok || payload.status === "failed") {
    throw new Error(payload.error ?? `Backend transaction submission failed (${response.status})`);
  }
  return payload;
}

function toolText(result: McpToolResponse | null) {
  return result?.content?.map((part) => part.text ?? "").join("\n") ?? "No tool response returned.";
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

const activity = [
  ["Mandate created", "@agent_aurora", "10 USDC", "Active", "2m ago", "created"],
  ["Payment settled", "@merchant_one", "4.50 USDC", "Settled", "18m ago", "settled"],
  ["Receipt verified", "@procure_bot", "32 USDC", "Verified", "1h ago", "verified"],
  ["Policy updated", "@chainpay", "Devnet", "Updated", "3h ago", "policy"],
] as const;

function shortAddress(value: string) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

function Shield() {
  return <span className="shield-icon" aria-hidden="true">◇</span>;
}

function MiniChart({ color }: { color: string }) {
  return (
    <svg className={`mini-chart ${color}`} viewBox="0 0 180 56" aria-hidden="true">
      <path className="chart-fill" d="M2 43 C15 38 22 42 33 33S53 39 63 29S82 35 92 24S113 27 124 18S145 22 158 12S172 13 178 5V56H2Z" />
      <path className="chart-line" d="M2 43 C15 38 22 42 33 33S53 39 63 29S82 35 92 24S113 27 124 18S145 22 158 12S172 13 178 5" />
    </svg>
  );
}

function App() {
  const [wallet, setWallet] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<Action>("Send");
  const [range, setRange] = useState<Range>("1D");
  const [mandateAddress, setMandateAddress] = useState("");
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [mcpResult, setMcpResult] = useState<McpToolResponse | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [integrationError, setIntegrationError] = useState("");

  async function loadWalletState(owner: string) {
    const address = deriveMandateAddress(owner, PROGRAM_ID);
    setMandateAddress(address);
    setIntegrationStatus("loading");
    setIntegrationError("");

    const [sdkState, mcpState] = await Promise.allSettled([
      chainpayClient.getMandate(address),
      Promise.all([
        mcpRequest<{ tools: McpTool[] }>("tools/list"),
        callMcpTool("get_mandate", { address }),
      ]),
    ]);

    if (sdkState.status === "fulfilled") setMandate(sdkState.value);
    if (mcpState.status === "fulfilled") {
      setMcpTools(mcpState.value[0].tools ?? []);
      setMcpResult(mcpState.value[1]);
    }

    const errors = [sdkState, mcpState]
      .filter((state): state is PromiseRejectedResult => state.status === "rejected")
      .map((state) => state.reason instanceof Error ? state.reason.message : String(state.reason));
    if (errors.length > 0) {
      setIntegrationStatus("error");
      setIntegrationError(errors.join(" · "));
    } else {
      setIntegrationStatus("ready");
    }
  }

  async function refreshMandate() {
    if (wallet) await loadWalletState(wallet);
  }

  async function connectWallet() {
    if (wallet || connecting) return;
    setConnecting(true);
    try {
      if (!window.solana?.connect) {
        window.alert("Install Phantom, Backpack, or Solflare to connect a Solana wallet on Devnet.");
        return;
      }
      const result = await window.solana.connect();
      const address = result.publicKey.toString();
      setWallet(address);
      void loadWalletState(address);
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    const existing = window.solana?.publicKey?.toString();
    if (existing) {
      setWallet(existing);
      void loadWalletState(existing);
    }
  }, []);

  function selectAction(action: Action) {
    setSelectedAction(action);
    document.querySelector("#mandates")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (wallet) {
    return (
      <Dashboard
        wallet={wallet}
        mandateAddress={mandateAddress}
        mandate={mandate}
        mcpTools={mcpTools}
        mcpResult={mcpResult}
        integrationStatus={integrationStatus}
        integrationError={integrationError}
        onRefresh={refreshMandate}
        onCallMcp={async (name, args) => {
          const result = await callMcpTool(name, args);
          setMcpResult(result);
          return result;
        }}
      />
    );
  }

  return (
    <div className="site-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar page-width">
        <a className="brand" href="#top" aria-label="ChainPay home">
          <span className="brand-mark"><span /></span>
          <span>chain<span>pay</span></span>
        </a>
        <nav className={`main-nav ${menuOpen ? "open" : ""}`}>
          <a href="#products">Products</a>
          <a href="#how-it-works">How it works</a>
          <a href="#activity">Activity</a>
          <a href="#support">Support</a>
        </nav>
        <div className="top-actions">
          <a className="login-link" href="#support">Log in</a>
          <button className="button button-small button-dark" onClick={connectWallet}>
            {wallet ? shortAddress(wallet) : "Sign up"}
          </button>
          <button className="mobile-menu" onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation">☰</button>
        </div>
      </header>

      <main id="top">
        <section className="hero page-width">
          <div className="hero-copy">
            <div className="eyebrow"><span className="pulse-dot" /> Solana Devnet · MCP connected</div>
            <h1>Fast, safe payments for <em>AI agents.</em></h1>
            <p className="hero-text">ChainPay lets agents route stablecoin payments through on-chain mandates. Set the rules once, and let Solana enforce every payment.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={connectWallet}>
                {connecting ? "Connecting…" : wallet ? `Connected ${shortAddress(wallet)}` : "Connect wallet"} <Arrow />
              </button>
              <a className="text-link" href="#how-it-works">See how it works <Arrow /></a>
            </div>
            <div className="hero-trust"><Shield /> No private keys shared with agents <span /> ✓ Every settlement gets a receipt</div>
          </div>

          <div className="hero-visual" aria-label="ChainPay payment mandate preview">
            <div className="orbit orbit-a" /><div className="orbit orbit-b" />
            <div className="visual-card mandate-card">
              <div className="card-topline"><span className="soft-label">PAYMENT MANDATE</span><span className="status-pill"><i /> Active</span></div>
              <div className="mandate-balance">$2,000<span>.00</span></div>
              <div className="muted-small">Available agent spend</div>
              <div className="mandate-rule"><span>Max per payment</span><strong>10 USDC</strong></div>
              <div className="mandate-rule"><span>Approved recipient</span><strong className="mono">Merchant…a4f2</strong></div>
              <div className="mandate-rule"><span>Expires</span><strong>7 days</strong></div>
              <div className="spend-track"><span /></div>
              <div className="track-caption"><span>Amount spent</span><strong>20.5 USDC <b>/ 100 USDC</b></strong></div>
            </div>
            <div className="floating-receipt receipt-top"><span className="receipt-icon">✓</span><span><b>Payment settled</b><small>Receipt verified on-chain</small></span><strong>+4.50</strong></div>
            <div className="floating-receipt receipt-bottom"><span className="spark-icon">✦</span><span><b>Agent authority</b><small>Limited by ChainPay</small></span></div>
          </div>
        </section>

        <section className="command-section page-width" id="products">
          <div className="section-heading compact-heading"><div><span className="section-kicker">CONTROL CENTER</span><h2>Move money with confidence.</h2></div><span className="network-chip"><i /> Program live on Devnet</span></div>
          <div className="command-grid">
            <div className="command-panel">
              <div className="command-balance"><div><span className="soft-label">PROTECTED BALANCE</span><h3>$2,000<span>.00</span></h3><p><span className="positive">+0.23%</span> this month</p></div><div className="balance-orb"><Shield /></div></div>
              <div className="range-row">{(["1H", "1D", "1W", "1M", "1Y", "All"] as Range[]).map((item) => <button className={range === item ? "selected" : ""} key={item} onClick={() => setRange(item)}>{item}</button>)}</div>
              <div className="large-chart"><div className="chart-gridline one" /><div className="chart-gridline two" /><div className="chart-gridline three" /><svg viewBox="0 0 650 220" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="main-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#6d7cff" stopOpacity=".3" /><stop offset="1" stopColor="#6d7cff" stopOpacity="0" /></linearGradient></defs><path fill="url(#main-fill)" d="M0 186C37 178 46 173 75 177S102 160 130 168S160 147 190 157S216 125 244 145S273 131 298 137S328 114 357 126S386 104 411 119S447 90 475 105S502 69 529 85S559 63 582 71S615 37 650 20V220H0Z" /><path className="main-line" d="M0 186C37 178 46 173 75 177S102 160 130 168S160 147 190 157S216 125 244 145S273 131 298 137S328 114 357 126S386 104 411 119S447 90 475 105S502 69 529 85S559 63 582 71S615 37 650 20" /></svg><span className="chart-tooltip">$2,000.00</span></div>
            </div>
            <div className="action-panel" id="mandates"><div className="panel-title"><div><span className="soft-label">QUICK ACTIONS</span><h3>What do you need?</h3></div><span className="mcp-badge"><span /> MCP</span></div><div className="action-list">{actions.map((action) => <button className={`action-row ${selectedAction === action.label ? "active" : ""}`} key={action.label} onClick={() => selectAction(action.label)}><span className="action-icon">{action.icon}</span><span><b>{action.label}</b><small>{action.detail}</small></span><Arrow /></button>)}</div><div className="action-note"><Shield /><span>{selectedAction} selected</span><small>{actions.find((action) => action.label === selectedAction)?.detail}</small></div></div>
          </div>
        </section>

        <section className="assets-section page-width">
          <div className="section-heading"><div><span className="section-kicker">SUPPORTED RAILS</span><h2>Built for stablecoin settlement.</h2><p>Connect the assets your agents already use. ChainPay handles the policy; Solana handles settlement.</p></div><a className="text-link" href="#support">View all assets <Arrow /></a></div>
          <div className="asset-grid">{assets.map((asset) => <article className="asset-card" key={asset.symbol}><div className="asset-card-top"><span className={`asset-logo ${asset.className}`}>{asset.icon}</span><span className="asset-more">···</span></div><h3>{asset.name}</h3><div className="asset-pair">{asset.symbol} <span>/ DEVNET</span></div><div className="asset-price">{asset.price}</div><div className={`asset-change ${asset.change.startsWith("+") ? "positive" : "neutral"}`}>{asset.change}</div><MiniChart color={asset.className} /><button className="asset-button" onClick={() => selectAction(asset.symbol === "RECEIPT" ? "Receipts" : "Send")}>{asset.symbol === "RECEIPT" ? "View receipts" : "Route payment"} <Arrow /></button></article>)}</div>
        </section>

        <section className="market-section page-width" id="activity">
          <div className="section-heading"><div><span className="section-kicker">MANDATE ACTIVITY</span><h2>Stay in control.</h2></div><span className="live-label"><i /> Live on-chain feed</span></div>
          <div className="market-table"><div className="table-head"><span>#</span><span>Activity</span><span>Amount</span><span>Status</span><span>Time</span><span /></div>{activity.map((item, index) => <div className="table-row" key={`${item[1]}-${item[4]}`}><span className="row-number">0{index + 1}</span><span className="activity-cell"><span className={`activity-avatar ${item[5]}`}>{item[5] === "settled" ? "↗" : item[5] === "verified" ? "✓" : item[5] === "policy" ? "✦" : "◆"}</span><span><b>{item[0]}</b><small>{item[1]}</small></span></span><strong>{item[2]}</strong><span className={`table-status ${item[5]}`}><i />{item[3]}</span><span className="row-time">{item[4]}</span><button className="row-arrow" aria-label={`Open ${item[0]}`}>→</button></div>)}</div>
          <div className="insurance-note"><Shield /> ChainPay policies are enforced by the Solana program. Agents never receive your private key or unrestricted wallet access.</div>
        </section>

        <section className="proof-section page-width"><div className="proof-copy"><span className="section-kicker">WHY CHAINPAY</span><h2>Your money.<br /><em>Your rules.</em></h2><p>Traditional wallets give agents too much power. ChainPay gives them a mandate—limited, transparent authority that can be revoked at any time.</p><a className="text-link" href="#how-it-works">Learn about mandates <Arrow /></a></div><div className="proof-stats"><div className="proof-stat"><strong>100%</strong><span>On-chain policy enforcement</span></div><div className="proof-stat"><strong>1-click</strong><span>Pause or revoke authority</span></div><div className="proof-stat"><strong>24/7</strong><span>Receipt verification</span></div><div className="proof-stat"><strong>0 keys</strong><span>Shared with your agents</span></div></div></section>

        <section className="steps-section page-width" id="how-it-works"><div className="section-heading centered"><span className="section-kicker">SIMPLE STEPS</span><h2>Start routing in minutes.</h2><p>From wallet connection to verified settlement, ChainPay keeps every step visible.</p></div><div className="steps-grid"><div className="step-card"><span className="step-number">01.</span><span className="step-icon">◈</span><h3>Connect wallet</h3><p>Connect your Solana wallet on Devnet. Your private key stays with you.</p></div><div className="step-card"><span className="step-number">02.</span><span className="step-icon">◇</span><h3>Create a mandate</h3><p>Choose a token, recipient, spend limit, and expiration for your agent.</p></div><div className="step-card"><span className="step-number">03.</span><span className="step-icon">✦</span><h3>Let agents request</h3><p>Agents use MCP or the SDK. ChainPay checks every request on-chain.</p></div><div className="step-card"><span className="step-number">04.</span><span className="step-icon">▤</span><h3>Verify settlement</h3><p>Successful payments create durable receipts for everyone to reconcile.</p></div></div></section>

        <section className="cta-section page-width" id="support"><div className="cta-orb orb-left" /><div className="cta-orb orb-right" /><span className="section-kicker">READY WHEN YOU ARE</span><h2>Let your agents act.<br /><em>Keep the control.</em></h2><p>Create your first payment mandate on Solana Devnet.</p><button className="button button-light" onClick={connectWallet}>{wallet ? "Open mandate dashboard" : "Get started"} <Arrow /></button></section>
      </main>

      <footer className="footer page-width"><div className="footer-main"><div className="footer-brand"><a className="brand" href="#top"><span className="brand-mark"><span /></span><span>chain<span>pay</span></span></a><p>Safe stablecoin payments for the agent economy.</p><div className="footer-status"><i /> Program active · Devnet</div></div><div className="footer-links"><div><b>PRODUCTS</b><a href="#products">Mandates</a><a href="#products">Payments</a><a href="#activity">Receipts</a><a href="#how-it-works">MCP tools</a></div><div><b>LEARN</b><a href="#how-it-works">How it works</a><a href="#support">Documentation</a><a href="#support">Security</a><a href="#support">Status</a></div><div><b>LEGAL</b><a href="#support">Privacy Policy</a><a href="#support">Terms of Service</a><a href="#support">Risk disclosure</a></div></div><div className="newsletter"><b>Stay in the loop</b><p>Product updates, protocol news, and Devnet drops.</p><div className="email-box"><input placeholder="Your email" aria-label="Your email" /><button aria-label="Subscribe">→</button></div></div></div><div className="footer-bottom"><span>© 2026 ChainPay. Built on Solana.</span><span>Program <button className="copy-id" onClick={() => navigator.clipboard?.writeText(PROGRAM_ID)}><span className="mono">{shortAddress(PROGRAM_ID)}</span> ⧉</button></span></div></footer>
    </div>
  );
}

type DashboardProps = {
  wallet: string;
  mandateAddress: string;
  mandate: Mandate | null;
  mcpTools: McpTool[];
  mcpResult: McpToolResponse | null;
  integrationStatus: "idle" | "loading" | "ready" | "error";
  integrationError: string;
  onRefresh: () => Promise<void>;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
};

function Dashboard({
  wallet,
  mandateAddress,
  mandate,
  mcpTools,
  mcpResult,
  integrationStatus,
  integrationError,
  onRefresh,
  onCallMcp,
}: DashboardProps) {
  const [tab, setTab] = useState<"overview" | "mandates" | "payments" | "receipts" | "assistant">("overview");
  const [prompt, setPrompt] = useState("Inspect my active mandate");
  const [reply, setReply] = useState("Ask ChainPay about your active mandate, receipt, or agent permissions.");
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);

  const mandateStatus = mandate?.status ?? "not created";
  const tokenLimit = mandate ? mandate.totalLimit.toString() : "—";
  const spent = mandate ? mandate.amountSpent.toString() : "—";

  async function askChainPay(input = prompt) {
    if (!mandateAddress) return;
    setThinking(true);
    setReply(`Checking ${shortAddress(mandateAddress)} through ChainPay MCP…`);
    try {
      const result = await onCallMcp("get_mandate", { address: mandateAddress });
      setReply(toolText(result));
    } catch (error) {
      setReply(error instanceof Error ? error.message : "The MCP request failed.");
    } finally {
      setThinking(false);
    }
    void input;
  }

  function startVoice() {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setReply("Voice capture is not available in this browser. Type a request below instead.");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setPrompt(transcript);
      void askChainPay(transcript);
    };
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  return (
    <div className="dashboard-app">
      <header className="dashboard-topbar">
        <a className="brand" href="#dashboard"><span className="brand-mark"><span /></span><span>chain<span>pay</span></span></a>
        <div className="dashboard-top-actions"><span className="dashboard-network"><i /> Solana Devnet</span><span className="wallet-chip"><span className="wallet-avatar">{wallet.slice(0, 2)}</span>{shortAddress(wallet)}</span></div>
      </header>
      <div className="dashboard-layout">
        <aside className="dashboard-sidebar">
          <div className="sidebar-label">WORKSPACE</div>
          <button className={tab === "overview" ? "side-link active" : "side-link"} onClick={() => setTab("overview")}><span>⌂</span> Overview</button>
          <button className={tab === "mandates" ? "side-link active" : "side-link"} onClick={() => setTab("mandates")}><span>◇</span> Mandates</button>
          <button className={tab === "payments" ? "side-link active" : "side-link"} onClick={() => setTab("payments")}><span>↗</span> Payments</button>
          <button className={tab === "receipts" ? "side-link active" : "side-link"} onClick={() => setTab("receipts")}><span>▤</span> Receipts</button>
          <div className="sidebar-separator" />
          <div className="sidebar-label">AGENT TOOLS</div>
          <button className={tab === "assistant" ? "side-link active" : "side-link"} onClick={() => setTab("assistant")}><span>✦</span> ChainPay AI</button>
          <button className="side-link" onClick={() => setTab("assistant")}><span>⌘</span> MCP tools <b className="tool-count">{mcpTools.length || "—"}</b></button>
          <div className="sidebar-bottom"><div className="sidebar-safe"><Shield /><span><b>Wallet protected</b><small>Agent keys never stored</small></span></div><button className="side-link muted"><span>⚙</span> Settings</button></div>
        </aside>

        <main className="dashboard-main" id="dashboard">
          <div className="dashboard-heading"><div><span className="section-kicker">CONTROL CENTER</span><h1>{tab === "assistant" ? "Talk to ChainPay." : tab === "mandates" ? "Your mandates." : tab === "payments" ? "Route a payment." : tab === "receipts" ? "Verify a receipt." : "Good to see you."}</h1><p>{tab === "assistant" ? "Use voice or text to query your live ChainPay tools." : tab === "mandates" ? "Create a limited policy and approve its delegate authority." : tab === "payments" ? "Ask MCP to preflight the request, then sign the SDK transaction." : tab === "receipts" ? "Look up durable settlement proof through the live MCP endpoint." : "Your agent permissions and settlement activity at a glance."}</p></div><button className="refresh-button" onClick={() => void onRefresh()} disabled={integrationStatus === "loading"}>↻ Refresh</button></div>

          <div className="integration-strip"><span className={`connection-dot ${integrationStatus}`} /> <b>{integrationStatus === "loading" ? "Syncing" : integrationStatus === "error" ? "Needs attention" : "Connected"}</b><span>SDK · {RPC_URL.replace("https://", "")}</span><span className="integration-divider" /><b>MCP</b><span>{mcpTools.length ? `${mcpTools.length} tools discovered` : "Discovering tools"}</span>{integrationError && <small title={integrationError}>Check connection</small>}</div>

          {tab === "assistant" ? <AssistantPanel prompt={prompt} setPrompt={setPrompt} reply={reply} thinking={thinking} listening={listening} onAsk={() => void askChainPay()} onVoice={startVoice} /> : tab === "mandates" ? <MandateBuilder wallet={wallet} onCreated={onRefresh} /> : tab === "payments" ? <PaymentPanel wallet={wallet} mandate={mandate} onCallMcp={onCallMcp} onRefresh={onRefresh} /> : tab === "receipts" ? <ReceiptPanel onCallMcp={onCallMcp} /> : (
            <>
              <section className="dashboard-stat-grid"><div className="dashboard-stat"><span className="soft-label">MANDATE STATUS</span><strong className={`status-text ${mandate ? mandate.status : "empty"}`}>{mandateStatus}</strong><small>{mandate ? "Policy account found on-chain" : "No mandate found for this wallet"}</small></div><div className="dashboard-stat"><span className="soft-label">TOTAL SPEND LIMIT</span><strong>{tokenLimit}</strong><small>Token base units · Devnet</small></div><div className="dashboard-stat"><span className="soft-label">AMOUNT SPENT</span><strong>{spent}</strong><small>{mandate?.paymentCount.toString() ?? "0"} payments recorded</small></div><div className="dashboard-stat"><span className="soft-label">MCP TOOLS</span><strong>{mcpTools.length || "—"}</strong><small>Available to connected agents</small></div></section>

              <section className="dashboard-content-grid"><div className="dashboard-card mandate-live-card"><div className="dashboard-card-heading"><div><span className="section-kicker">LIVE POLICY</span><h2>Payment mandate</h2></div><span className={`status-pill ${mandate ? "" : "muted-pill"}`}><i /> {mandate ? mandate.status : "Not created"}</span></div><div className="pda-line"><span className="soft-label">MANDATE PDA</span><button className="pda-copy" onClick={() => navigator.clipboard?.writeText(mandateAddress)}>{shortAddress(mandateAddress)} ⧉</button></div>{mandate ? <div className="mandate-details"><div><span>Approved agent</span><strong>{shortAddress(mandate.approvedAgent)}</strong></div><div><span>Allowed token</span><strong>{shortAddress(mandate.allowedMint)}</strong></div><div><span>Recipient account</span><strong>{shortAddress(mandate.allowedRecipient)}</strong></div><div><span>Max per payment</span><strong>{mandate.maxPerPayment.toString()} base units</strong></div></div> : <div className="empty-mandate"><div className="empty-icon">◇</div><h3>Create your first mandate</h3><p>This wallet does not have a ChainPay policy account yet. The next step is to set a token, recipient, spend cap, and expiry, then review a wallet-signed transaction.</p><button className="button button-primary" onClick={() => setTab("mandates")}>Configure mandate <Arrow /></button></div>}</div><div className="dashboard-card agent-card"><div className="dashboard-card-heading"><div><span className="section-kicker">AGENT CONSOLE</span><h2>Ask ChainPay</h2></div><span className="voice-status">● Voice ready</span></div><div className="agent-orb"><span>✦</span><small>ChainPay AI</small></div><p>“Check my mandate and tell me what this agent can spend.”</p><button className="button button-dark full-button" onClick={() => setTab("assistant")}>Open assistant <Arrow /></button></div></section>

              <section className="dashboard-card tools-card"><div className="dashboard-card-heading"><div><span className="section-kicker">MCP REGISTRY</span><h2>Tools available to your agents</h2></div><span className="mcp-badge"><span /> Streamable HTTP</span></div><div className="tool-list">{mcpTools.length ? mcpTools.map((tool) => <div className="tool-row" key={tool.name}><span className="tool-icon">✦</span><span><b>{tool.name}</b><small>{tool.description ?? "ChainPay agent tool"}</small></span><span className="tool-ready">ready</span></div>) : <div className="tool-empty">Connect to the MCP endpoint to discover tools.</div>}</div></section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

type PaymentPanelProps = {
  wallet: string;
  mandate: Mandate | null;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
  onRefresh: () => Promise<void>;
};

function PaymentPanel({ wallet, mandate, onCallMcp, onRefresh }: PaymentPanelProps) {
  const [invoice, setInvoice] = useState("demo-invoice-001");
  const [amount, setAmount] = useState("1000000");
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [mcpPreflight, setMcpPreflight] = useState("");
  const [status, setStatus] = useState<"idle" | "preparing" | "ready" | "signing" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");

  useEffect(() => {
    if (mandate) setAmount((current) => current || mandate.maxPerPayment.toString());
  }, [mandate]);

  async function prepare() {
    if (!mandate) {
      setError("Create an active mandate before preparing a payment.");
      setStatus("error");
      return;
    }
    setStatus("preparing");
    setError("");
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    try {
      const [invoiceHash, paymentId, signatureReference] = await Promise.all([
        sha256Hex(`${invoice}:invoice`),
        sha256Hex(`${invoice}:payment`),
        sha256Hex(`${invoice}:signature`),
      ]);
      const mcpArgs: Record<string, unknown> = {
        mandate: mandate.address,
        agent: wallet,
        invoiceHash,
        paymentId,
        signatureReference,
        mint: mandate.allowedMint,
        recipient: mandate.allowedRecipient,
        amount: amount.trim(),
        ...(mandate.tokenProgram ? { tokenProgram: mandate.tokenProgram } : {}),
      };
      const mcpResult = await onCallMcp("prepare_payment", mcpArgs);
      setMcpPreflight(toolText(mcpResult));

      const nextPrepared = await chainpayClient.preparePayment({
        mandate: mandate.address,
        invoiceHash: hexToBytes(invoiceHash),
        paymentId: hexToBytes(paymentId),
        signatureReference: hexToBytes(signatureReference),
        mint: mandate.allowedMint,
        recipient: mandate.allowedRecipient,
        amount: BigInt(amount),
        tokenProgram: mandate.tokenProgram,
      }, wallet);
      const nextSimulation = await chainpayClient.simulate(nextPrepared.transaction);
      setPrepared(nextPrepared);
      setSimulation(nextSimulation);
      const failedChecks = nextPrepared.preflight.checks.filter((check) => !check.ok).map((check) => check.message);
      if (mcpResult.isError || !nextPrepared.preflight.valid || !nextSimulation.ok) {
        setStatus("error");
        setError(failedChecks.join(" · ") || nextSimulation.error || "MCP or on-chain simulation rejected this payment.");
      } else {
        setStatus("ready");
      }
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function signPayment() {
    if (!prepared || !simulation?.ok || !prepared.preflight.valid) return;
    if (!window.solana?.signTransaction) {
      setStatus("error");
      setError("This wallet does not expose transaction signing.");
      return;
    }
    setStatus("signing");
    setError("");
    try {
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(prepared.transaction, latest.blockhash);
      const signed = await window.solana.signTransaction(transaction);
      const mcpResult = await onCallMcp("execute_payment", {
        mandate: prepared.request.mandate,
        agent: wallet,
        invoiceHash: bytesToHex(prepared.request.invoiceHash),
        paymentId: bytesToHex(prepared.request.paymentId),
        signatureReference: bytesToHex(prepared.request.signatureReference),
        mint: prepared.request.mint,
        recipient: prepared.request.recipient,
        amount: prepared.request.amount.toString(),
        ...(prepared.request.tokenProgram ? { tokenProgram: prepared.request.tokenProgram } : {}),
        signedTransaction: Buffer.from(signed.serialize()).toString("base64"),
      });
      const backendResult = mcpResult.structuredContent as { status?: string; signature?: string; error?: string } | undefined;
      if (mcpResult.isError || backendResult?.status === "failed") {
        throw new Error(backendResult?.error ?? toolText(mcpResult));
      }
      const nextSignature = backendResult?.signature;
      if (!nextSignature) throw new Error("Backend confirmed the payment without a transaction signature.");
      setSignature(nextSignature);
      setStatus("success");
      await onRefresh();
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!mandate) {
    return <div className="dashboard-card flow-empty"><div className="empty-icon">↗</div><h2>No active mandate yet</h2><p>Create a mandate first. Payments can only be prepared after ChainPay has an on-chain policy to check.</p></div>;
  }

  return (
    <section className="payment-flow-layout">
      <div className="dashboard-card payment-form-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">MCP PAYMENT REQUEST</span><h2>Prepare a policy-checked payment</h2></div><span className="mcp-badge"><span /> MCP + SDK</span></div>
        <p className="builder-intro">The invoice text becomes three deterministic SHA-256 references. MCP checks the mandate first; the SDK then prepares and simulates the transaction your connected wallet can sign.</p>
        <div className="builder-grid"><label className="field field-wide"><span>Invoice or payment reference</span><input value={invoice} onChange={(event) => { setInvoice(event.target.value); setPrepared(null); setSignature(""); }} placeholder="invoice-001" /></label><label className="field"><span>Amount <small>token base units</small></span><input inputMode="numeric" value={amount} onChange={(event) => { setAmount(event.target.value); setPrepared(null); setSignature(""); }} /></label><label className="field"><span>Agent signer</span><input value={wallet} readOnly /></label><label className="field"><span>Allowed mint</span><input value={mandate.allowedMint} readOnly /></label><label className="field"><span>Allowed recipient</span><input value={mandate.allowedRecipient} readOnly /></label></div>
        <div className="payment-policy-note"><Shield /><span>Limit: <b>{mandate.maxPerPayment.toString()}</b> per payment · <b>{mandate.totalLimit.toString()}</b> total · {mandate.status}</span></div>
        <div className="builder-actions"><button className="button button-primary" onClick={() => void prepare()} disabled={status === "preparing" || status === "signing"}>{status === "preparing" ? "Calling MCP & simulating…" : "Prepare payment"} <Arrow /></button><span className="builder-safety"><Shield /> Wallet approval required to settle</span></div>
        {error && <div className="builder-error"><b>Payment blocked</b><span>{error}</span></div>}
        {signature && prepared && <div className="success-box"><span>✓</span><div><b>Payment confirmed on Devnet</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View settlement transaction <Arrow /></a><button className="receipt-address" onClick={() => navigator.clipboard?.writeText(prepared.receiptAddress)} title={prepared.receiptAddress}>Receipt PDA: {shortAddress(prepared.receiptAddress)} ⧉</button></div></div>}
      </div>
      <div className="payment-review-stack"><div className="dashboard-card review-card"><div className="dashboard-card-heading"><div><span className="section-kicker">POLICY PREFLIGHT</span><h2>{prepared ? "Payment review" : "Waiting for a request"}</h2></div><span className={`simulation-pill ${prepared?.preflight.valid && simulation?.ok ? "ok" : prepared ? "failed" : ""}`}><i /> {prepared ? (prepared.preflight.valid && simulation?.ok ? "Approved" : "Blocked") : "Waiting"}</span></div>{prepared ? <><div className="check-list">{prepared.preflight.checks.map((check) => <div key={check.name} className={check.ok ? "check-row ok" : "check-row failed"}><span>{check.ok ? "✓" : "×"}</span><b>{check.name}</b><small>{check.message}</small></div>)}</div><div className="simulation-box"><span className="soft-label">MCP RESPONSE</span><pre>{mcpPreflight || "No MCP response returned."}</pre></div><button className="button button-dark full-button" onClick={() => void signPayment()} disabled={!prepared.preflight.valid || !simulation?.ok || status === "signing"}>{status === "signing" ? "Waiting for wallet…" : "Sign & settle payment"} <Arrow /></button></> : <div className="review-empty"><div className="empty-icon">↗</div><p>Submit an invoice reference to see MCP policy checks, SDK simulation logs, and the receipt PDA before signing.</p></div>}</div></div>
    </section>
  );
}

function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function ReceiptPanel({ onCallMcp }: { onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse> }) {
  const [receiptAddress, setReceiptAddress] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  async function lookup() {
    if (!receiptAddress.trim()) return;
    setLoading(true);
    try {
      const response = await onCallMcp("get_payment", { receiptAddress: receiptAddress.trim() });
      setResult(toolText(response));
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return <section className="dashboard-card receipt-lookup"><div className="dashboard-card-heading"><div><span className="section-kicker">MCP RECEIPT LOOKUP</span><h2>Verify a settlement</h2></div><span className="mcp-badge"><span /> get_payment</span></div><p className="builder-intro">Paste a receipt PDA from a confirmed payment. The lookup is read-only and comes directly from the ChainPay MCP server.</p><div className="receipt-search"><input value={receiptAddress} onChange={(event) => setReceiptAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void lookup(); }} placeholder="Receipt PDA address" /><button className="button button-primary" onClick={() => void lookup()} disabled={loading}>{loading ? "Looking up…" : "Verify"} <Arrow /></button></div>{result && <div className="simulation-box receipt-result"><span className="soft-label">LIVE MCP RESPONSE</span><pre>{result}</pre></div>}</section>;
}

function AssistantPanel({ prompt, setPrompt, reply, thinking, listening, onAsk, onVoice }: { prompt: string; setPrompt: (value: string) => void; reply: string; thinking: boolean; listening: boolean; onAsk: () => void; onVoice: () => void }) {
  return <section className="assistant-layout"><div className="assistant-card dashboard-card"><div className="assistant-visual"><div className={`assistant-orb ${thinking ? "thinking" : ""}`}><span>✦</span></div><span className="assistant-caption">{listening ? "Listening…" : thinking ? "Reading ChainPay…" : "ChainPay AI"}</span></div><div className="assistant-log"><span className="soft-label">LIVE RESPONSE</span><p>{reply}</p>{!reply.startsWith("Ask") && <pre>{reply}</pre>}</div><div className="assistant-input"><input value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onAsk(); }} aria-label="Ask ChainPay" /><button className={listening ? "voice-button listening" : "voice-button"} onClick={onVoice} aria-label="Use voice">{listening ? "■" : "●"}</button><button className="button button-primary ask-button" onClick={onAsk} disabled={thinking}>Ask <Arrow /></button></div><small className="assistant-note">Read-only MCP test: this assistant currently calls <b>get_mandate</b> and never signs or sends funds.</small></div><div className="assistant-side"><div className="dashboard-card"><span className="section-kicker">VOICE UI</span><h2>Give your agent a voice.</h2><p>Speak naturally. ChainPay translates the request into an MCP tool call, then shows the on-chain response before any action.</p><button className="button button-dark full-button" onClick={onVoice}>{listening ? "Listening…" : "Start voice command"}</button></div><div className="dashboard-card safety-card"><Shield /><div><b>Safe by default</b><p>Payment execution stays behind wallet signing and explicit approval.</p></div></div></div></section>;
}

type MandateForm = {
  approvedAgent: string;
  sourceTokenAccount: string;
  allowedMint: string;
  allowedRecipient: string;
  maxPerPayment: string;
  totalLimit: string;
  expiresAtSlot: string;
  maxPaymentCount: string;
  cooldownSlots: string;
  tokenProgram: TokenProgram;
};

function MandateBuilder({ wallet, onCreated }: { wallet: string; onCreated: () => Promise<void> }) {
  const [form, setForm] = useState<MandateForm>({
    approvedAgent: wallet,
    sourceTokenAccount: "",
    allowedMint: DEVNET_USDC_MINT,
    allowedRecipient: "",
    maxPerPayment: "1000000",
    totalLimit: "10000000",
    expiresAtSlot: "",
    maxPaymentCount: "0",
    cooldownSlots: "0",
    tokenProgram: "spl-token",
  });
  const [prepared, setPrepared] = useState<PreparedMandate | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [status, setStatus] = useState<"idle" | "building" | "ready" | "signing" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [accountSetup, setAccountSetup] = useState<"idle" | "working" | "ready" | "error">("idle");

  useEffect(() => {
    let active = true;
    void chainpayClient.getCurrentSlot().then((slot) => {
      if (active) setForm((current) => ({ ...current, expiresAtSlot: (slot + 100000n).toString() }));
    }).catch(() => {
      // The user can still enter a slot manually if the RPC is unavailable.
    });
    return () => { active = false; };
  }, []);

  function updateField(field: keyof MandateForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    if (status !== "idle") setStatus("idle");
    setError("");
  }

  async function setupWalletTokenAccount() {
    if (!form.allowedMint.trim()) {
      setAccountSetup("error");
      setError("Enter a token mint before creating the wallet token account.");
      return;
    }
    setAccountSetup("working");
    setError("");
    try {
      const tokenAccount = deriveAssociatedTokenAddress(wallet, form.allowedMint.trim(), form.tokenProgram);
      setForm((current) => ({ ...current, sourceTokenAccount: tokenAccount, allowedRecipient: tokenAccount }));
      const existing = await chainpayClient.connection.getAccountInfo(new PublicKey(tokenAccount), "confirmed");
      if (existing) {
        setAccountSetup("ready");
        return;
      }
      if (!window.solana?.signTransaction) throw new Error("This wallet does not expose transaction signing.");
      const instruction = buildCreateAssociatedTokenAccountInstruction({
        payer: wallet,
        owner: wallet,
        mint: form.allowedMint.trim(),
        tokenProgram: form.tokenProgram,
      });
      const prepared: PreparedTransaction = {
        instructions: [instruction],
        requiredSigners: [wallet],
        feePayer: wallet,
      };
      const simulation = await chainpayClient.simulate(prepared);
      if (!simulation.ok) throw new Error(simulation.error ?? "Token account creation simulation failed.");
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(prepared, latest.blockhash);
      const signed = await window.solana.signTransaction(transaction);
      await submitSignedTransaction(`ata:${wallet}:${tokenAccount}:${latest.blockhash}`, signed.serialize());
      setAccountSetup("ready");
    } catch (cause) {
      setAccountSetup("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function buildPreview() {
    setStatus("building");
    setError("");
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    try {
      const input = {
        approvedAgent: form.approvedAgent.trim(),
        sourceTokenAccount: form.sourceTokenAccount.trim(),
        allowedMint: form.allowedMint.trim(),
        allowedRecipient: form.allowedRecipient.trim(),
        maxPerPayment: BigInt(form.maxPerPayment),
        totalLimit: BigInt(form.totalLimit),
        expiresAtSlot: BigInt(form.expiresAtSlot),
        maxPaymentCount: BigInt(form.maxPaymentCount),
        cooldownSlots: BigInt(form.cooldownSlots),
        tokenProgram: form.tokenProgram,
      };
      const nextPrepared = await chainpayClient.buildCreateMandate(input, wallet);
      const nextSimulation = await chainpayClient.simulate(nextPrepared.transaction);
      setPrepared(nextPrepared);
      setSimulation(nextSimulation);
      setStatus(nextSimulation.ok ? "ready" : "error");
      if (!nextSimulation.ok) setError(nextSimulation.error ?? "Simulation failed. Review the RPC logs below.");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function signAndCreate() {
    if (!prepared || !simulation?.ok) return;
    if (!window.solana?.signTransaction) {
      setStatus("error");
      setError("This wallet does not expose transaction signing. Install Phantom, Backpack, or Solflare.");
      return;
    }
    setStatus("signing");
    setError("");
    try {
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(prepared.transaction, latest.blockhash);
      const signed = await window.solana.signTransaction(transaction);
      const result = await submitSignedTransaction(`mandate:${prepared.mandateAddress}:${latest.blockhash}`, signed.serialize());
      setSignature(result.signature ?? "");
      setStatus("success");
      await onCreated();
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="mandate-builder-layout">
      <div className="dashboard-card mandate-builder">
        <div className="dashboard-card-heading">
          <div><span className="section-kicker">ON-CHAIN POLICY</span><h2>Create a payment mandate</h2></div>
          <span className="network-chip"><i /> Devnet</span>
        </div>
        <p className="builder-intro">The SDK validates the mint and token accounts against Solana, prepares the policy plus delegate approval, and simulates it before your wallet is asked to sign.</p>
        <div className="builder-grid">
          <label className="field"><span>Approved agent</span><input value={form.approvedAgent} onChange={(event) => updateField("approvedAgent", event.target.value)} placeholder="Agent wallet public key" /></label>
          <label className="field"><span>Token program</span><select value={form.tokenProgram} onChange={(event) => updateField("tokenProgram", event.target.value as TokenProgram)}><option value="spl-token">Classic SPL Token</option><option value="token-2022">Token-2022</option></select></label>
          <label className="field field-wide"><span>Source token account</span><input value={form.sourceTokenAccount} onChange={(event) => updateField("sourceTokenAccount", event.target.value)} placeholder="Your Devnet stablecoin token account" /><button className="inline-action" type="button" onClick={() => void setupWalletTokenAccount()} disabled={accountSetup === "working"}>{accountSetup === "working" ? "Creating wallet token account…" : accountSetup === "ready" ? "Wallet token account ready ✓" : "Create/use my wallet token account"}</button><small className="field-help">For the first smoke test, this also fills the recipient with the same account.</small></label>
          <label className="field"><span>Allowed stablecoin mint</span><input value={form.allowedMint} onChange={(event) => updateField("allowedMint", event.target.value)} placeholder="Devnet mint address" /></label>
          <label className="field"><span>Allowed recipient token account</span><input value={form.allowedRecipient} onChange={(event) => updateField("allowedRecipient", event.target.value)} placeholder="Merchant token account" /></label>
          <label className="field"><span>Max per payment <small>base units</small></span><input inputMode="numeric" value={form.maxPerPayment} onChange={(event) => updateField("maxPerPayment", event.target.value)} /></label>
          <label className="field"><span>Total spend limit <small>base units</small></span><input inputMode="numeric" value={form.totalLimit} onChange={(event) => updateField("totalLimit", event.target.value)} /></label>
          <label className="field"><span>Expiry slot <small>current + 100,000 suggested</small></span><input inputMode="numeric" value={form.expiresAtSlot} onChange={(event) => updateField("expiresAtSlot", event.target.value)} /></label>
          <label className="field"><span>Payment count cap <small>0 = unlimited</small></span><input inputMode="numeric" value={form.maxPaymentCount} onChange={(event) => updateField("maxPaymentCount", event.target.value)} /></label>
          <label className="field"><span>Cooldown <small>minimum slots between payments</small></span><input inputMode="numeric" value={form.cooldownSlots} onChange={(event) => updateField("cooldownSlots", event.target.value)} /></label>
        </div>
        <div className="builder-actions"><button className="button button-primary" onClick={() => void buildPreview()} disabled={status === "building" || status === "signing"}>{status === "building" ? "Building & simulating…" : "Build transaction preview"} <Arrow /></button><span className="builder-safety"><Shield /> Nothing signs until you approve it</span></div>
        {error && <div className="builder-error"><b>Needs attention</b><span>{error}</span></div>}
      </div>

      <div className="dashboard-card review-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">REVIEW BEFORE SIGNING</span><h2>{prepared ? "Transaction ready" : "Your preview appears here"}</h2></div><span className={`simulation-pill ${simulation?.ok ? "ok" : simulation ? "failed" : ""}`}><i /> {simulation ? (simulation.ok ? "Simulated" : "Rejected") : "Waiting"}</span></div>
        {prepared ? <>
          <div className="review-list"><div><span>Mandate PDA</span><strong className="mono">{shortAddress(prepared.mandateAddress)}</strong></div><div><span>Config PDA</span><strong className="mono">{shortAddress(prepared.configAddress)}</strong></div><div><span>Instructions</span><strong>{prepared.transaction.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Fee payer</span><strong className="mono">{shortAddress(wallet)}</strong></div></div>
          <div className="simulation-box"><span className="soft-label">SIMULATION LOG</span><pre>{simulation?.logs.length ? simulation.logs.join("\n") : simulation?.error ?? "No simulation logs returned."}</pre></div>
          <button className="button button-dark full-button" onClick={() => void signAndCreate()} disabled={!simulation?.ok || status === "signing"}>{status === "signing" ? "Waiting for wallet…" : "Sign & create mandate"} <Arrow /></button>
          {signature && <div className="success-box"><span>✓</span><div><b>Mandate created on Devnet</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a></div></div>}
        </> : <div className="review-empty"><div className="empty-icon">◇</div><p>Enter your Devnet token accounts and build a preview. ChainPay will show the derived PDA, instructions, and simulation result here.</p></div>}
      </div>
    </section>
  );
}

export default App;
