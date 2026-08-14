import { useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { ChainPayClient, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, buildCreateAssociatedTokenAccountInstruction, bytesToHex, deriveAssociatedTokenAddress, deriveConfigAddress, deriveMandateAddress, toWeb3Transaction } from "@chainpay/sdk";
import type { ChainPayInstruction, Mandate, PreparedMandate, PreparedPayment, PreparedTransaction, SimulationResult, TokenProgram } from "@chainpay/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";
import { connectChainPayWallet, restoreChainPayWallet, type ChainPayWallet } from "./wallet";

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

type Action = "Send" | "Receive" | "Approve mandate" | "Receipts";
type Range = "1H" | "1D" | "1W" | "1M" | "1Y" | "All";

type SolanaProvider = {
  isPhantom?: boolean;
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
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const PROGRAM_ID = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEVNET_PYUSD_TOKEN_2022_MINT = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
const TOKEN_2022_MINT_OVERRIDE = import.meta.env.VITE_CHAINPAY_TOKEN_2022_MINT ?? import.meta.env.VITE_CHAINPAY_PYUSD_MINT ?? "";
const HOSTED_BACKEND_URL = "https://chainpay-backend.onrender.com";
const BACKEND_URL = import.meta.env.VITE_CHAINPAY_BACKEND_URL ?? HOSTED_BACKEND_URL;
const HOSTED_RPC_URL = `${BACKEND_URL.replace(/\/$/, "")}/rpc`;
const configuredRpcUrl = (import.meta.env.VITE_CHAINPAY_RPC_URL ?? "").replace(/\/$/, "");
const RPC_URL = configuredRpcUrl && configuredRpcUrl !== "https://api.devnet.solana.com"
  ? configuredRpcUrl
  : HOSTED_RPC_URL;
const MCP_URL = import.meta.env.VITE_CHAINPAY_MCP_URL ?? "https://chainpay-mcp.onrender.com/mcp";
const AGENT_URL = import.meta.env.VITE_CHAINPAY_AGENT_URL
  ?? `${MCP_URL.replace(/\/mcp\/?$/, "")}/agent/chat`;
const chainpayClient = new ChainPayClient({ rpcUrl: RPC_URL, programId: PROGRAM_ID });
type StablecoinOption = {
  value: "usdc" | "token-2022";
  label: string;
  detail: string;
  mint: string;
  tokenProgram: TokenProgram;
};

function buildStablecoinOptions(token2022Mint: string): StablecoinOption[] {
  return [
    { value: "usdc", label: "USDC", detail: "SPL Token", mint: DEVNET_USDC_MINT, tokenProgram: "spl-token" },
    { value: "token-2022", label: "PYUSD", detail: "Token-2022", mint: token2022Mint, tokenProgram: "token-2022" },
  ];
}

type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpToolResponse = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
type AgentHistoryItem = { role: "user" | "assistant"; content: string };
type AgentResponse = { message: string; toolCalls?: string[]; error?: string };
type ProtocolConfig = {
  address?: string;
  authority: string;
  supportedMints: string[];
  bump: number;
};

type DashboardTab = "overview" | "protocol" | "mandates" | "payments" | "agents" | "receipts" | "tools" | "connect-mcp" | "settings" | "assistant";
type MandateTableStatus = "active" | "paused" | "revoked";
type MandateAction = "pause" | "resume" | "revoke";
type ConnectionToolCall = { name: string; count: number; lastCalledAt: string };
type AgentConnection = { id: string; wallet: string; agentName: string; scope: string; connectedAt: string; lastSeenAt: string | null; totalCalls: number; toolsCalled: ConnectionToolCall[]; mandates: number };
type ServerAgentConnection = Omit<AgentConnection, "mandates">;

const coreToolReferences = [
  {
    name: "get_mandate",
    description: "Read an on-chain ChainPay payment mandate and its current status.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Mandate PDA address" } }, required: ["address"], additionalProperties: false },
  },
  {
    name: "prepare_payment",
    description: "Validate a payment request against the on-chain mandate and prepare an agent-signed transaction.",
    inputSchema: { type: "object", properties: { mandate: { type: "string" }, agent: { type: "string" }, mint: { type: "string" }, recipient: { type: "string" }, amount: { type: "string" } }, required: ["mandate", "agent", "mint", "recipient", "amount"], additionalProperties: false },
  },
  {
    name: "execute_payment",
    description: "Simulate and submit a policy-checked payment through the configured execution adapter.",
    inputSchema: { type: "object", properties: { mandate: { type: "string" }, agent: { type: "string" }, recipient: { type: "string" }, amount: { type: "string" }, signedTransaction: { type: "string" } }, required: ["mandate", "agent", "recipient", "amount"], additionalProperties: false },
  },
  {
    name: "get_payment",
    description: "Fetch a ChainPay receipt by address or by mandate and invoice hash.",
    inputSchema: { type: "object", properties: { receiptAddress: { type: "string" }, mandate: { type: "string" }, invoiceHash: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "prepare_x402_payment",
    description: "Normalize a Solana x402 challenge and prepare a mandate-checked payment transaction.",
    inputSchema: { type: "object", properties: { challenge: { type: "object", description: "x402 exact payment challenge" }, mandate: { type: "string" }, agent: { type: "string" }, signedTransaction: { type: "string" } }, required: ["challenge", "mandate", "agent"], additionalProperties: false },
  },
] as const;

function copyValue(value: string) {
  void navigator.clipboard?.writeText(value);
}

function mcpConnectionsUrl(wallet: string) {
  return `${MCP_URL.replace(/\/mcp\/?$/, "")}/connections?wallet=${encodeURIComponent(wallet)}`;
}

async function fetchMcpConnections(wallet: string): Promise<AgentConnection[]> {
  const response = await fetch(mcpConnectionsUrl(wallet));
  const payload = await response.json() as { connections?: ServerAgentConnection[]; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `MCP connections request failed (${response.status})`);
  return (payload.connections ?? []).map((connection) => ({ ...connection, mandates: connection.scope === "Current mandate" ? 1 : 0 }));
}

async function registerMcpConnection(wallet: string, agentName: string, scope: string) {
  const endpoint = mcpConnectionsUrl(wallet).replace(/\?.*$/, "");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, agentName, scope }),
  });
  const payload = await response.json() as { connection?: ServerAgentConnection; token?: string; error?: string };
  const connection = payload.connection;
  const token = payload.token;
  if (!response.ok || !connection || !token) throw new Error(payload.error ?? `MCP connection request failed (${response.status})`);
  return { connection, token };
}

async function revokeMcpConnection(wallet: string, id: string) {
  const endpoint = `${MCP_URL.replace(/\/mcp\/?$/, "")}/connections/${encodeURIComponent(id)}?wallet=${encodeURIComponent(wallet)}`;
  const response = await fetch(endpoint, { method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json() as { error?: string };
    throw new Error(payload.error ?? `MCP connection revoke failed (${response.status})`);
  }
}

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

async function callChainPayAgent(
  message: string,
  context: { wallet: string; mandateAddress: string; history: AgentHistoryItem[] },
): Promise<AgentResponse> {
  const response = await fetch(AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message, ...context }),
  });
  const payload = await response.json() as AgentResponse;
  if (!response.ok) throw new Error(payload.error ?? `AI agent request failed (${response.status})`);
  return payload;
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

function parseTokenAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Enter a valid non-negative token amount.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`This mint supports ${decimals} decimal places.`);
  }
  const scale = 10n ** BigInt(decimals);
  const fractionalUnits = fraction.padEnd(decimals, "0");
  return BigInt(whole) * scale + BigInt(fractionalUnits || "0");
}

function formatTokenAmount(value: bigint, decimals: number | null) {
  if (decimals === null) return `${value.toString()} base units`;
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

async function getAccountInfoOrNull(address: PublicKey) {
  try {
    return await chainpayClient.connection.getAccountInfo(address, "confirmed");
  } catch (cause) {
    if (cause instanceof Error && /accountnotfound/i.test(cause.message)) return null;
    throw cause;
  }
}

function tokenAccountValidationError(
  account: { owner: PublicKey; data: Uint8Array } | null,
  expectedMint: string,
  expectedOwner: string,
  tokenProgram: TokenProgram,
): string | null {
  if (!account) return "Token account is not prepared yet.";

  const expectedProgram = tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  if (account.owner.toBase58() !== expectedProgram) {
    return "The wallet account does not match the selected token type.";
  }
  if (account.data.length < 165) {
    return "The wallet account is not a valid token account.";
  }

  const accountMint = new PublicKey(account.data.slice(0, 32)).toBase58();
  if (accountMint !== expectedMint) {
    return "The wallet account belongs to a different token.";
  }

  const accountOwner = new PublicKey(account.data.slice(32, 64)).toBase58();
  if (accountOwner !== expectedOwner) {
    return "The wallet account is not owned by the connected wallet.";
  }

  return null;
}

async function resolvePaymentDestination(
  input: string,
  mint: string,
  tokenProgram: TokenProgram,
  payer: string,
): Promise<{ address: string; createInstruction?: ChainPayInstruction }> {
  let destination: PublicKey;
  try {
    destination = new PublicKey(input.trim());
  } catch {
    throw new Error("Enter a wallet address or payment destination.");
  }

  const expectedProgram = tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  const existing = await getAccountInfoOrNull(destination);
  if (existing && (existing.owner.toBase58() === SPL_TOKEN_PROGRAM_ID || existing.owner.toBase58() === TOKEN_2022_PROGRAM_ID)) {
    if (existing.owner.toBase58() !== expectedProgram || existing.data.length < 165) {
      throw new Error("That destination does not match the selected stablecoin.");
    }
    return { address: destination.toBase58() };
  }

  const associatedTokenAccount = deriveAssociatedTokenAddress(destination.toBase58(), mint, tokenProgram);
  const associatedInfo = await getAccountInfoOrNull(new PublicKey(associatedTokenAccount));
  if (associatedInfo) {
    if (associatedInfo.owner.toBase58() !== expectedProgram) {
      throw new Error("The destination wallet has an incompatible stablecoin account.");
    }
    return { address: associatedTokenAccount };
  }

  return {
    address: associatedTokenAccount,
    createInstruction: buildCreateAssociatedTokenAccountInstruction({
      payer,
      owner: destination.toBase58(),
      mint,
      tokenProgram,
    }),
  };
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

const useCases = [
  { title: "Treasury approvals", quote: "Set a capped transfer policy.", detail: "Agents can request payments without receiving unrestricted wallet access." },
  { title: "Merchant settlement", quote: "Route every invoice through one policy.", detail: "Preflight the recipient, mint, amount, and mandate before signing." },
  { title: "Programmatic payouts", quote: "Keep recipients and limits explicit.", detail: "The protocol records the request and returns a durable receipt." },
  { title: "Reconciliation", quote: "Verify the settlement later.", detail: "Look up the receipt PDA and transaction signature from MCP." },
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

function connectionSeenLabel(value: string | null) {
  if (!value) return "Registered · waiting for first call";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Active just now";
  if (minutes === 1) return "Active 1m ago";
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Last seen ${hours}h ago`;
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
  const [walletConnection, setWalletConnection] = useState<ChainPayWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<Action>("Send");
  const [range, setRange] = useState<Range>("1D");
  const [mandateAddress, setMandateAddress] = useState("");
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [protocolConfig, setProtocolConfig] = useState<ProtocolConfig | null>(null);
  const [token2022Mint, setToken2022Mint] = useState(TOKEN_2022_MINT_OVERRIDE);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [mcpResult, setMcpResult] = useState<McpToolResponse | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [integrationError, setIntegrationError] = useState("");
  const wallet = walletConnection?.address ?? "";

  async function loadWalletState(owner: string) {
    const address = deriveMandateAddress(owner, PROGRAM_ID);
    setMandateAddress(address);
    setIntegrationStatus("loading");
    setIntegrationError("");

    const [sdkState, configState, mcpState] = await Promise.allSettled([
      chainpayClient.getMandate(address),
      chainpayClient.getConfig(),
      Promise.all([
        mcpRequest<{ tools: McpTool[] }>("tools/list"),
        callMcpTool("get_mandate", { address }),
      ]),
    ]);

    if (sdkState.status === "fulfilled") setMandate(sdkState.value);
    if (configState.status === "fulfilled") setProtocolConfig(configState.value);
    if (mcpState.status === "fulfilled") {
      setMcpTools(mcpState.value[0].tools ?? []);
      setMcpResult(mcpState.value[1]);
    }

    const errors = [sdkState, configState, mcpState]
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

  useEffect(() => {
    let active = true;
    if (TOKEN_2022_MINT_OVERRIDE) {
      setToken2022Mint(TOKEN_2022_MINT_OVERRIDE);
      return () => { active = false; };
    }
    if (!protocolConfig) {
      setToken2022Mint("");
      return () => { active = false; };
    }

    const candidates = [...new Set([
      ...protocolConfig.supportedMints,
      DEVNET_PYUSD_TOKEN_2022_MINT,
    ])];
    void Promise.all(candidates.map(async (mint) => {
      try {
        const asset = await chainpayClient.getSupportedAsset(mint);
        return asset?.enabled && asset.tokenProgram === TOKEN_2022_PROGRAM_ID ? mint : null;
      } catch {
        return null;
      }
    })).then((mints) => {
      if (active) setToken2022Mint(mints.find((mint): mint is string => Boolean(mint)) ?? "");
    });

    return () => { active = false; };
  }, [protocolConfig?.address, protocolConfig?.supportedMints.join(",")]);

  async function connectWallet() {
    if (wallet || connecting) return;
    setConnecting(true);
    try {
      const connection = await connectChainPayWallet(window.solana, window.phantom?.solana);
      setWalletConnection(connection);
      void loadWalletState(connection.address);
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    const restored = restoreChainPayWallet(window.solana, window.phantom?.solana);
    if (restored) {
      setWalletConnection(restored);
      void loadWalletState(restored.address);
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
        walletName={walletConnection?.name ?? "Solana wallet"}
        walletSigner={walletConnection?.signTransaction}
        mandateAddress={mandateAddress}
        mandate={mandate}
        protocolConfig={protocolConfig}
        stablecoinOptions={buildStablecoinOptions(token2022Mint)}
        mcpTools={mcpTools}
        mcpResult={mcpResult}
        integrationStatus={integrationStatus}
        integrationError={integrationError}
        onRefresh={refreshMandate}
        onDisconnect={() => {
          setWalletConnection(null);
          setMandate(null);
          setProtocolConfig(null);
          setToken2022Mint(TOKEN_2022_MINT_OVERRIDE);
          setMcpTools([]);
          setMcpResult(null);
        }}
        onCallMcp={async (name, args) => {
          const result = await callMcpTool(name, args);
          setMcpResult(result);
          return result;
        }}
      />
    );
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
          <a href="#use-cases">Use cases</a>
          <a href="#how-it-works">How it works</a>
          <a href="#activity">Activity</a>
          <a href="#support">Support</a>
        </nav>
        <div className="top-actions">
          <button className="button button-small button-dark" onClick={connectWallet}>
            {wallet ? shortAddress(wallet) : "Connect"}
          </button>
          <button className="mobile-menu" onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation">☰</button>
        </div>
      </header>

      <main id="top">
        <section className="hero page-width">
          <div className="hero-copy">
            <div className="eyebrow"><span className="pulse-dot" /> Solana Devnet · MCP connected</div>
            <h1>The universal payment rail for <em>AI agents.</em></h1>
            <p className="hero-text">One MCP endpoint for policy enforcement, wallet authorization, routing, stablecoin settlement, and receipts. Solana is the first settlement layer.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={connectWallet}>
                {connecting ? "Connecting…" : wallet ? `Connected ${shortAddress(wallet)}` : "Connect wallet"} <Arrow />
              </button>
              <a className="text-link" href="#how-it-works">See how it works <Arrow /></a>
            </div>
            <div className="hero-trust"><Shield /> One interface for every rail <span /> ✓ Policy before payment <span /> ✓ Receipt for every settlement</div>
          </div>

          <div className="hero-visual" aria-label="ChainPay payment mandate preview">
            <div className="visual-card mandate-card">
              <div className="card-topline"><span className="soft-label">EXAMPLE MANDATE</span><span className="status-pill"><i /> Active</span></div>
              <div className="mandate-balance">$2,000<span>.00</span></div>
              <div className="muted-small">Available agent spend</div>
              <div className="mandate-rule"><span>Max per payment</span><strong>10 USDC</strong></div>
              <div className="mandate-rule"><span>Payment destination</span><strong className="mono">Chosen per payment</strong></div>
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
              <div className="command-balance"><div><span className="soft-label">EXAMPLE POLICY</span><h3>$2,000<span>.00</span></h3><p>Illustrative Devnet flow</p></div><div className="balance-orb"><Shield /></div></div>
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

        <section className="use-cases-section page-width" id="use-cases">
          <div className="section-heading"><div><span className="section-kicker">USE CASES</span><h2>One interface. Every agent payment.</h2><p>If an agent needs to move money, it calls ChainPay. The agent does not need to understand the underlying wallet, connector, or settlement rail.</p></div><a className="text-link" href="#how-it-works">See the flow <Arrow /></a></div>
          <div className="use-case-grid">{useCases.map((useCase, index) => <article className="use-case-card" key={useCase.title}><span className="use-case-number">{String(index + 1).padStart(2, "0")}</span><h3>{useCase.title}</h3><p className="use-case-quote">{useCase.quote}</p><p>{useCase.detail}</p></article>)}</div>
        </section>

        <section className="market-section page-width" id="activity">
          <div className="section-heading"><div><span className="section-kicker">DEMO ACTIVITY</span><h2>Stay in control.</h2></div><span className="live-label"><i /> Example feed</span></div>
          <div className="market-table"><div className="table-head"><span>#</span><span>Activity</span><span>Amount</span><span>Status</span><span>Time</span><span /></div>{activity.map((item, index) => <div className="table-row" key={`${item[1]}-${item[4]}`}><span className="row-number">0{index + 1}</span><span className="activity-cell"><span className={`activity-avatar ${item[5]}`}>{item[5] === "settled" ? "↗" : item[5] === "verified" ? "✓" : item[5] === "policy" ? "✦" : "◆"}</span><span><b>{item[0]}</b><small>{item[1]}</small></span></span><strong>{item[2]}</strong><span className={`table-status ${item[5]}`}><i />{item[3]}</span><span className="row-time">{item[4]}</span><button className="row-arrow" aria-label={`Open ${item[0]}`}>→</button></div>)}</div>
          <div className="insurance-note"><Shield /> ChainPay policies are enforced by the Solana program. Agents never receive your private key or unrestricted wallet access.</div>
        </section>

        <section className="proof-section page-width"><div className="proof-copy"><span className="section-kicker">WHY CHAINPAY</span><h2>Your money.<br /><em>Your rules.</em></h2><p>Give an agent a mandate with a clear token, limit, and expiry. Each payment names its own destination, and you keep the signing key.</p><a className="text-link" href="#how-it-works">Learn about mandates <Arrow /></a></div><div className="proof-stats"><div className="proof-stat"><strong>On-chain</strong><span>Policy enforcement</span></div><div className="proof-stat"><strong>Wallet</strong><span>Always approves signing</span></div><div className="proof-stat"><strong>One</strong><span>Receipt per settlement</span></div><div className="proof-stat"><strong>Devnet</strong><span>Start with a safe demo</span></div></div></section>

        <section className="steps-section page-width" id="how-it-works"><div className="section-heading centered"><span className="section-kicker">SIMPLE STEPS</span><h2>Start routing in minutes.</h2><p>From wallet connection to verified settlement, ChainPay keeps every step visible.</p></div><div className="steps-grid"><div className="step-card"><span className="step-number">01.</span><span className="step-icon">◈</span><h3>Connect wallet</h3><p>Connect your Solana wallet on Devnet. Your private key stays with you.</p></div><div className="step-card"><span className="step-number">02.</span><span className="step-icon">◇</span><h3>Create a mandate</h3><p>Choose a token, spend limit, and expiration for your agent.</p></div><div className="step-card"><span className="step-number">03.</span><span className="step-icon">✦</span><h3>Let agents request</h3><p>Agents supply one destination with each payment. ChainPay checks every request on-chain.</p></div><div className="step-card"><span className="step-number">04.</span><span className="step-icon">▤</span><h3>Verify settlement</h3><p>Successful payments create durable receipts for everyone to reconcile.</p></div></div></section>

        <section className="cta-section page-width" id="support"><span className="section-kicker">READY WHEN YOU ARE</span><h2>Give agents one payment interface.<br /><em>Keep the control.</em></h2><p>Create your first policy and connect a settlement rail on Solana Devnet.</p><button className="button button-light" onClick={connectWallet}>{wallet ? "Open mandate dashboard" : "Get started"} <Arrow /></button></section>
      </main>

      <footer className="footer page-width"><div className="footer-main"><div className="footer-brand"><a className="brand" href="#top"><span className="brand-mark"><span /></span><span>chain<span>pay</span></span></a><p>The universal payment rail for AI agents.</p><div className="footer-status"><i /> Program active · Devnet</div></div><div className="footer-links"><div><b>PRODUCTS</b><a href="#products">Mandates</a><a href="#products">Payments</a><a href="#use-cases">Use cases</a><a href="#activity">Receipts</a></div><div><b>BUILD</b><a href="#how-it-works">How it works</a><a href="#support">MCP tools</a><a href="#support">Connectors</a><a href="#support">Status</a></div><div><b>LEGAL</b><a href="#support">Privacy Policy</a><a href="#support">Terms of Service</a><a href="#support">Risk disclosure</a></div></div><div className="newsletter"><b>Stay in the loop</b><p>Product updates, protocol news, and Devnet drops.</p><div className="email-box"><input placeholder="Your email" aria-label="Your email" /><button aria-label="Subscribe">→</button></div></div></div><div className="footer-bottom"><span>© 2026 ChainPay. Built on Solana.</span><span>Program <button className="copy-id" onClick={() => navigator.clipboard?.writeText(PROGRAM_ID)}><span className="mono">{shortAddress(PROGRAM_ID)}</span> ⧉</button></span></div></footer>
    </div>
  );
}

type DashboardProps = {
  wallet: string;
  walletName: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  mandateAddress: string;
  mandate: Mandate | null;
  protocolConfig: ProtocolConfig | null;
  stablecoinOptions: StablecoinOption[];
  mcpTools: McpTool[];
  mcpResult: McpToolResponse | null;
  integrationStatus: "idle" | "loading" | "ready" | "error";
  integrationError: string;
  onRefresh: () => Promise<void>;
  onDisconnect: () => void;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
};

function Dashboard({
  wallet,
  walletName,
  walletSigner,
  mandateAddress,
  mandate,
  protocolConfig,
  stablecoinOptions,
  mcpTools,
  mcpResult,
  integrationStatus,
  integrationError,
  onRefresh,
  onDisconnect,
  onCallMcp,
}: DashboardProps) {
  const [tab, setTab] = useState<DashboardTab>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [prompt, setPrompt] = useState("Inspect my active mandate");
  const [reply, setReply] = useState("Ask ChainPay about your active mandate, receipt, or agent permissions.");
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [assistantHistory, setAssistantHistory] = useState<AgentHistoryItem[]>([]);
  const [agentToolsUsed, setAgentToolsUsed] = useState<string[]>([]);
  const voiceRecognition = useRef<SpeechRecognitionLike | null>(null);
  const [mandateDecimals, setMandateDecimals] = useState<number | null>(null);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [dangerStatus, setDangerStatus] = useState("");
  const [mandateCreateOpen, setMandateCreateOpen] = useState(false);

  const spent = mandate ? formatTokenAmount(mandate.amountSpent, mandateDecimals) : "—";

  useEffect(() => {
    let active = true;
    setMandateDecimals(null);
    if (!mandate) return () => { active = false; };
    void chainpayClient.getMintDecimals(mandate.allowedMint).then((decimals) => {
      if (active) setMandateDecimals(decimals);
    }).catch(() => {
      if (active) setMandateDecimals(null);
    });
    return () => { active = false; };
  }, [mandate?.allowedMint]);

  useEffect(() => {
    let active = true;
    const refreshConnections = async () => {
      try {
        const nextConnections = await fetchMcpConnections(wallet);
        if (active) setConnections(nextConnections.map((connection) => ({
          ...connection,
          mandates: connection.scope === "Current mandate" ? 1 : 0,
        })));
      } catch {
        // MCP telemetry is optional; the rest of the dashboard remains usable.
      }
    };
    void refreshConnections();
    const interval = window.setInterval(() => void refreshConnections(), 8_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [wallet]);

  async function askChainPay(input = prompt) {
    const query = input.trim();
    if (!query) return;
    setThinking(true);
    setReply("Thinking with ChainPay…");
    try {
      const result = await callChainPayAgent(query, {
        wallet,
        mandateAddress,
        history: assistantHistory,
      });
      const nextReply = result.message.trim() || "ChainPay did not return a response.";
      setReply(nextReply);
      setAgentToolsUsed(result.toolCalls ?? []);
      setAssistantHistory((current) => [
        ...current,
        { role: "user" as const, content: query },
        { role: "assistant" as const, content: nextReply },
      ].slice(-8));
    } catch (error) {
      // Keep the assistant useful while the server-side model is being configured.
      // This fallback is still read-only and makes the missing AI configuration visible.
      if (mandateAddress && /mandate|permission|policy/i.test(query)) try {
        const result = await onCallMcp("get_mandate", { address: mandateAddress });
        const fallback = toolText(result);
        setAgentToolsUsed(["get_mandate"]);
        setReply(`AI agent unavailable: ${error instanceof Error ? error.message : "request failed"}\n\nDirect read-only MCP response:\n${fallback}`);
      } catch (fallbackError) {
        setReply(`AI agent unavailable: ${error instanceof Error ? error.message : "request failed"}\n\n${fallbackError instanceof Error ? fallbackError.message : "The read-only MCP request failed."}`);
        setAgentToolsUsed([]);
      } else {
        setReply(error instanceof Error ? error.message : "The ChainPay assistant request failed.");
        setAgentToolsUsed([]);
      }
    } finally {
      setThinking(false);
    }
  }

  function startVoice() {
    if (listening) {
      voiceRecognition.current?.stop();
      return;
    }
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
    recognition.onend = () => {
      setListening(false);
      voiceRecognition.current = null;
    };
    recognition.onerror = (event) => {
      setListening(false);
      voiceRecognition.current = null;
      if (event.error !== "aborted") setReply("I could not hear that. Try again or type your request.");
    };
    voiceRecognition.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch (error) {
      voiceRecognition.current = null;
      setListening(false);
      setReply(error instanceof Error ? error.message : "Voice capture could not start.");
    }
  }

  async function revokeAllMandates() {
    setDangerStatus("");
    if (!mandate) {
      setDangerStatus("There are no mandates for this wallet.");
      return;
    }
    if (!walletSigner) {
      setDangerStatus("The connected wallet does not expose transaction signing.");
      return;
    }
    try {
      const prepared = chainpayClient.buildRevokeMandate(wallet);
      const simulation = await chainpayClient.simulate(prepared);
      if (!simulation.ok) throw new Error(simulation.error ?? "Mandate revocation simulation failed.");
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
      await submitSignedTransaction(`revoke-all:${mandate.address}:${latest.blockhash}`, signed.serialize());
      await onRefresh();
      setDangerStatus("Active mandate revoked.");
    } catch (cause) {
      setDangerStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function runMandateAction(action: MandateAction) {
    if (!mandate) throw new Error("There is no mandate to update.");
    if (!walletSigner) throw new Error("The connected wallet does not expose transaction signing.");
    const prepared = action === "pause"
      ? chainpayClient.buildPauseMandate(wallet)
      : action === "revoke"
        ? chainpayClient.buildRevokeMandate(wallet)
        : chainpayClient.buildUpdateMandate({
          approvedAgent: mandate.approvedAgent,
          maxPerPayment: mandate.maxPerPayment,
          totalLimit: mandate.totalLimit,
          expiresAtSlot: mandate.expiresAtSlot,
          maxPaymentCount: mandate.maxPaymentCount,
          cooldownSlots: mandate.cooldownSlots,
          paused: false,
        }, wallet);
    const simulation = await chainpayClient.simulate(prepared);
    if (!simulation.ok) throw new Error(simulation.error ?? `Mandate ${action} simulation failed.`);
    const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
    const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
    await submitSignedTransaction(`${action}-mandate:${mandate.address}:${latest.blockhash}`, signed.serialize());
    await onRefresh();
  }

  const navItems: { id: DashboardTab; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "⌂" },
    { id: "mandates", label: "Mandates", icon: "◇" },
    { id: "payments", label: "Payments", icon: "↗" },
    { id: "agents", label: "Agents", icon: "⌁" },
    { id: "receipts", label: "Receipts", icon: "▤" },
    { id: "assistant", label: "Talk to ChainPay", icon: "◉" },
  ];

  function selectTab(nextTab: DashboardTab) {
    setTab(nextTab);
    setMobileNav(false);
    if (nextTab !== "mandates") setMandateCreateOpen(false);
  }

  function openMandateCreate() {
    setMandateCreateOpen(true);
    selectTab("mandates");
  }

  function SidebarNav() {
    return (
      <>
        <div className="dashboard-sidebar-brand">
          <a className="brand" href="#dashboard" aria-label="ChainPay dashboard">
            <span className="brand-mark"><span /></span>
            <span>Chain<span>Pay</span></span>
          </a>
        </div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="dashboard-nav" aria-label="Dashboard navigation">
          {navItems.map((item) => (
            <button className={tab === item.id ? "side-link active" : "side-link"} key={item.id} onClick={() => selectTab(item.id)} aria-current={tab === item.id ? "page" : undefined}>
              <span className="sidebar-glyph" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-separator" />
        <div className="sidebar-label">AGENT TOOLS</div>
        <button className={tab === "tools" ? "side-link active" : "side-link"} onClick={() => selectTab("tools")}><span className="sidebar-glyph" aria-hidden="true">⌘</span><span>Tools</span><b className="tool-count">{mcpTools.length || 4}</b></button>
        <button className={tab === "connect-mcp" ? "side-link active" : "side-link"} onClick={() => selectTab("connect-mcp")}><span className="sidebar-glyph" aria-hidden="true">＋</span><span>Connect MCP</span></button>
        <div className="sidebar-bottom">
          <div className="sidebar-safe"><Shield /><span><b>Wallet protected</b><small>Agent keys never stored</small></span></div>
          <button className={tab === "settings" ? "side-link muted active" : "side-link muted"} onClick={() => selectTab("settings")}><span className="sidebar-glyph" aria-hidden="true">⚙</span><span>Settings</span></button>
          <button className="side-link muted sidebar-back" onClick={onDisconnect}><span className="sidebar-glyph" aria-hidden="true">‹</span><span>Back to site</span></button>
        </div>
      </>
    );
  }

  return (
    <div className="dashboard-app cp-app">
      {mobileNav && <div className="dashboard-mobile-overlay" onClick={() => setMobileNav(false)} aria-hidden="true" />}
      {mobileNav && <aside className="dashboard-mobile-panel"><SidebarNav /></aside>}
      <div className="dashboard-layout">
        <aside className="dashboard-sidebar">
          <SidebarNav />
        </aside>

        <main className="dashboard-main" id="dashboard">
          <header className="dashboard-topbar">
            <div className="dashboard-topbar-left">
              <button className="dashboard-menu-button" onClick={() => setMobileNav(true)} aria-label="Open dashboard navigation">☰</button>
              <a className="brand dashboard-topbar-brand" href="#dashboard"><span className="brand-mark"><span /></span><span>chain<span>pay</span></span></a>
            </div>
            <div className="dashboard-top-actions"><span className="dashboard-network"><i /> Solana Devnet</span><span className="wallet-chip" title={walletName}><span className="wallet-avatar">{wallet.slice(0, 2)}</span>{shortAddress(wallet)}</span></div>
          </header>
          <div className="dashboard-page">
          <div className="dashboard-heading"><div><span className="section-kicker">{tab === "mandates" ? "POLICY CONTROL" : "CONTROL CENTER"}</span><h1 className="t-xl">{tab === "assistant" ? "Talk to ChainPay." : tab === "protocol" ? "Protocol setup." : tab === "mandates" ? "Mandates." : tab === "payments" ? "Route a payment." : tab === "agents" ? "Agents." : tab === "receipts" ? "Verify a receipt." : tab === "tools" ? "Tools." : tab === "connect-mcp" ? "Connect MCP." : tab === "settings" ? "Settings." : "Good to see you."}</h1><p>{tab === "assistant" ? "Query your live ChainPay tools." : tab === "protocol" ? "Initialize the protocol asset list from the authority wallet." : tab === "mandates" ? (mandateCreateOpen ? "Create a policy for an agent to follow before a payment can be signed." : "Review the spending rules an agent must follow before a payment can be signed.") : tab === "payments" ? "Preflight the request, then sign the SDK transaction." : tab === "agents" ? "Agents connected to ChainPay and the scopes they hold." : tab === "receipts" ? "Look up settlement proof from MCP." : tab === "tools" ? "The exact tools agents can call. Nothing else is exposed." : tab === "connect-mcp" ? "Pair an agent so it can call ChainPay's tools. It never gets your wallet key." : tab === "settings" ? "Network, wallet, notifications, and account controls." : "Your agent permissions and settlement activity at a glance."}</p></div>{tab === "overview" || tab === "mandates" ? (mandateCreateOpen ? <button className="refresh-button btn btn-secondary-light" onClick={() => setMandateCreateOpen(false)}>← Back to mandates</button> : <button className="button button-primary overview-new-mandate" onClick={openMandateCreate}>＋ New mandate</button>) : <button className="refresh-button btn btn-secondary-light" onClick={() => void onRefresh()} disabled={integrationStatus === "loading"}>↻ Refresh</button>}</div>

          <div className="integration-strip"><span className={`connection-dot ${integrationStatus}`} /> <b>{integrationStatus === "loading" ? "Syncing" : integrationStatus === "error" ? "Needs attention" : "Connected"}</b><span>SDK · {RPC_URL.replace("https://", "")}</span><span className="integration-divider" /><b>MCP</b><span>{mcpTools.length ? `${mcpTools.length} tools discovered` : "Discovering tools"}</span><span className="integration-divider" /><b>AGENTS</b><span>{connections.length ? `${connections.length} connected` : "None connected"}</span>{integrationError && <small title={integrationError}>Check connection</small>}</div>

          <div>{tab === "assistant" ? <AssistantPanel prompt={prompt} setPrompt={setPrompt} reply={reply} thinking={thinking} listening={listening} agentToolsUsed={agentToolsUsed} onAsk={() => void askChainPay()} onVoice={startVoice} /> : tab === "protocol" ? <ProtocolPanel wallet={wallet} walletSigner={walletSigner} config={protocolConfig} onCreated={onRefresh} /> : tab === "mandates" ? <MandatesPanel wallet={wallet} walletSigner={walletSigner} mandate={mandate} mandateDecimals={mandateDecimals} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} createOpen={mandateCreateOpen} onCreateOpenChange={setMandateCreateOpen} onMandateAction={runMandateAction} onRefresh={onRefresh} /> : tab === "payments" ? <PaymentPanel wallet={wallet} walletSigner={walletSigner} mandate={mandate} stablecoinOptions={stablecoinOptions} onCallMcp={onCallMcp} onRefresh={onRefresh} /> : tab === "agents" ? <AgentsPanel connections={connections} onConnect={() => setTab("connect-mcp")} onOpenAssistant={() => setTab("assistant")} /> : tab === "receipts" ? <ReceiptPanel onCallMcp={onCallMcp} /> : tab === "tools" ? <ToolsPanel mcpTools={mcpTools} /> : tab === "connect-mcp" ? <ConnectMcpPanel serverUrl={MCP_URL} wallet={wallet} connections={connections} onConnected={(connection) => setConnections((current) => [connection, ...current])} onRevoked={async (id) => { await revokeMcpConnection(wallet, id); setConnections((current) => current.filter((connection) => connection.id !== id)); }} /> : tab === "settings" ? <SettingsPanel wallet={wallet} dangerStatus={dangerStatus} onRevokeAll={() => void revokeAllMandates()} onDisconnect={onDisconnect} /> : (
            <>
              <section className="dashboard-stat-grid"><div className="dashboard-stat"><span className="soft-label">ACTIVE MANDATES</span><strong>{mandate?.status === "active" ? "1" : "0"}</strong><small>{mandate ? "Policy account found on-chain" : "No mandate found for this wallet"}</small></div><div className="dashboard-stat"><span className="soft-label">SPENT THIS MONTH</span><strong>{spent}</strong><small>{mandateDecimals === null ? "Reading token decimals" : "Human-readable token amount · Devnet"}</small></div><div className="dashboard-stat"><span className="soft-label">PENDING PAYMENTS</span><strong>0</strong><small>Nothing waiting for approval</small></div><div className="dashboard-stat"><span className="soft-label">AGENTS CONNECTED</span><strong>{connections.length}</strong><small>{connections.length ? "Scoped MCP access" : "Connect an agent to begin"}</small></div></section>

              <section className="dashboard-overview overview-agent-section"><OverviewAssistant prompt={prompt} setPrompt={setPrompt} reply={reply} thinking={thinking} listening={listening} onAsk={() => void askChainPay()} onVoice={startVoice} /></section>

              <section className="dashboard-card activity-feed-card"><div className="dashboard-card-heading"><div><span className="section-kicker">ACTIVITY</span><h2>Recent activity</h2></div><span className="chip chip-muted">Devnet demo</span></div><div className="dashboard-feed">{activity.map((item) => <div className="dashboard-feed-row" key={`${item[1]}-${item[4]}`}><span className={`activity-avatar ${item[5]}`}>{item[5] === "settled" ? "↗" : item[5] === "verified" ? "✓" : item[5] === "policy" ? "✦" : "◆"}</span><span><strong>{item[0]}</strong><small>{item[1]} · {item[4]}</small></span><b>{item[2]}</b><span className={`table-status ${item[5]}`}><i />{item[3]}</span></div>)}</div></section>
            </>
          )}</div>
          </div>
        </main>
      </div>
    </div>
  );
}

function mandateTableStatus(status: Mandate["status"]): MandateTableStatus {
  if (status === "paused") return "paused";
  if (status === "revoked" || status === "expired") return "revoked";
  return "active";
}

function mandateStatusLabel(status: MandateTableStatus) {
  return status[0].toUpperCase() + status.slice(1);
}

function mandateExpiryDate(expiresAtSlot: bigint, currentSlot: bigint | null) {
  if (currentSlot === null || expiresAtSlot <= currentSlot) return null;
  const secondsUntilExpiry = Number(expiresAtSlot - currentSlot) * 0.4;
  if (!Number.isFinite(secondsUntilExpiry)) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(Date.now() + secondsUntilExpiry * 1000));
}

function MandatesPanel({
  wallet,
  walletSigner,
  mandate,
  mandateDecimals,
  stablecoinOptions,
  protocolConfig,
  createOpen,
  onCreateOpenChange,
  onMandateAction,
  onRefresh,
}: {
  wallet: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  mandate: Mandate | null;
  mandateDecimals: number | null;
  stablecoinOptions: StablecoinOption[];
  protocolConfig: ProtocolConfig | null;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onMandateAction: (action: MandateAction) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | MandateTableStatus>("all");
  const [actionInFlight, setActionInFlight] = useState<MandateAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);
  const status = mandate ? mandateTableStatus(mandate.status) : null;
  const selectedAsset = stablecoinOptions.find((option) => option.mint === mandate?.allowedMint);
  const progress = mandate && mandate.totalLimit > 0n
    ? Math.min(100, Number((mandate.amountSpent * 100n) / mandate.totalLimit))
    : 0;
  const filteredOut = Boolean(mandate && filter !== "all" && status !== filter);

  useEffect(() => {
    let active = true;
    void chainpayClient.getCurrentSlot().then((slot) => {
      if (active) setCurrentSlot(slot);
    }).catch(() => {
      if (active) setCurrentSlot(null);
    });
    return () => { active = false; };
  }, [mandate?.address, createOpen]);

  async function handleMandateAction(action: MandateAction) {
    setActionError("");
    setActionInFlight(action);
    try {
      await onMandateAction(action);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionInFlight(null);
    }
  }

  if (createOpen) {
    return (
      <section className="mandate-create-page" aria-labelledby="create-mandate-title">
        <div className="mandate-create-toolbar">
          <div>
            <span className="section-kicker">NEW MANDATE</span>
            <h2 id="create-mandate-title">Create a mandate</h2>
          </div>
          <button className="button button-secondary-light" onClick={() => onCreateOpenChange(false)}>← Back to mandates</button>
        </div>
        <MandateBuilder wallet={wallet} walletSigner={walletSigner} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} onCreated={onRefresh} />
      </section>
    );
  }

  return (
    <section className="mandates-panel" aria-labelledby="mandate-table-title">
      <div className="mandate-filter-bar" role="tablist" aria-label="Filter mandates">
        {(["all", "active", "paused", "revoked"] as const).map((value) => (
          <button
            className={`mandate-filter ${filter === value ? "is-selected" : ""}`}
            key={value}
            onClick={() => setFilter(value)}
            role="tab"
            aria-selected={filter === value}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>

      <div className="mandate-table-shell dashboard-card">
        <div className="mandate-table-scroll">
          <table className="mandate-table">
            <caption id="mandate-table-title" className="sr-only">ChainPay mandates</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Date</th>
                <th scope="col">Token type</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col" className="mandate-actions-heading"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {mandate && !filteredOut && status ? (
                <tr>
                  <td data-label="Agent">
                    <div className="mandate-agent-cell">
                      <span className="mandate-agent-avatar">{mandate.approvedAgent.slice(0, 2)}</span>
                      <span><strong>Approved agent</strong><small className="mono">{shortAddress(mandate.approvedAgent)}</small></span>
                    </div>
                  </td>
                  <td data-label="Date"><div className="mandate-date-cell"><strong>{mandateExpiryDate(mandate.expiresAtSlot, currentSlot) ?? "On-chain"}</strong><small className="mono">Slot {mandate.expiresAtSlot.toString()}</small></div></td>
                  <td data-label="Token type">
                    <div className="mandate-token-cell"><strong>{selectedAsset?.label ?? shortAddress(mandate.allowedMint)}</strong><small>{selectedAsset?.detail ?? (mandate.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token")}</small></div>
                  </td>
                  <td data-label="Amount" className="mandate-amount-cell">
                    <div className="mandate-amount-line"><strong>{mandateDecimals === null ? "—" : `$${formatTokenAmount(mandate.amountSpent, mandateDecimals)}`}</strong><span>/ {mandateDecimals === null ? "—" : `$${formatTokenAmount(mandate.totalLimit, mandateDecimals)}`}</span></div>
                    <div className="mandate-spend-bar" aria-label={`${progress}% of mandate spend used`}><span style={{ width: `${progress}%` }} /></div>
                  </td>
                  <td data-label="Status"><span className={`mandate-table-status ${status}`}><span className="mandate-status-check">✓</span>{mandateStatusLabel(status)}</span></td>
                  <td data-label="Actions" className="mandate-table-actions">
                    {status !== "revoked" ? <>
                      <button className="mandate-icon-button" onClick={() => void handleMandateAction(status === "paused" ? "resume" : "pause")} disabled={actionInFlight !== null} aria-label={status === "paused" ? "Resume mandate" : "Pause mandate"} title={status === "paused" ? "Resume mandate" : "Pause mandate"}>{actionInFlight === (status === "paused" ? "resume" : "pause") ? "…" : status === "paused" ? "▶" : "Ⅱ"}</button>
                      <button className="mandate-icon-button danger" onClick={() => void handleMandateAction("revoke")} disabled={actionInFlight !== null} aria-label="Revoke mandate" title="Revoke mandate">⌫</button>
                    </> : <span className="mandate-no-actions">—</span>}
                  </td>
                </tr>
              ) : (
                <tr className="mandate-empty-row"><td colSpan={6}><div className="mandate-empty-state"><span className="empty-icon">◇</span><strong>{mandate ? `No ${filter} mandates` : "No mandates yet"}</strong><p>{mandate ? "Try another status filter." : "Create a mandate to give an agent bounded spending authority."}</p><button className="button button-primary" onClick={() => onCreateOpenChange(true)}>＋ New mandate</button></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {actionError && <p className="mandate-action-error" role="alert">{actionError}</p>}
    </section>
  );
}

type PaymentPanelProps = {
  wallet: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  mandate: Mandate | null;
  stablecoinOptions: StablecoinOption[];
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
  onRefresh: () => Promise<void>;
};

function PaymentPanel({ wallet, walletSigner, mandate, stablecoinOptions, onCallMcp, onRefresh }: PaymentPanelProps) {
  const [invoice, setInvoice] = useState("demo-invoice-001");
  const [amount, setAmount] = useState("1");
  const [recipient, setRecipient] = useState("");
  const [mintDecimals, setMintDecimals] = useState<number | null>(null);
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [mcpPreflight, setMcpPreflight] = useState("");
  const [status, setStatus] = useState<"idle" | "preparing" | "ready" | "signing" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");

  useEffect(() => {
    if (mandate) setAmount((current) => current || mandate.maxPerPayment.toString());
  }, [mandate]);

  useEffect(() => {
    let active = true;
    setMintDecimals(null);
    if (!mandate) return () => { active = false; };
    void chainpayClient.getMintDecimals(mandate.allowedMint).then((decimals) => {
      if (active) setMintDecimals(decimals);
    }).catch(() => {
      if (active) setMintDecimals(null);
    });
    return () => { active = false; };
  }, [mandate?.allowedMint]);

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
      if (!recipient.trim()) throw new Error("Enter the recipient for this payment.");
      const [invoiceHash, paymentId, signatureReference] = await Promise.all([
        sha256Hex(`${invoice}:invoice`),
        sha256Hex(`${invoice}:payment`),
        sha256Hex(`${invoice}:signature`),
      ]);
      if (mintDecimals === null) throw new Error("Token decimals are not available yet. Refresh the mandate and try again.");
      const rawAmount = parseTokenAmount(amount, mintDecimals);
      const tokenProgram = mandate.tokenProgram ?? await chainpayClient.getTokenProgram(mandate.sourceTokenAccount);
      let sourceBalance: string;
      try {
        const balance = await chainpayClient.connection.getTokenAccountBalance(
          new PublicKey(mandate.sourceTokenAccount),
          "confirmed",
        );
        sourceBalance = balance.value.amount;
        if (BigInt(sourceBalance) < rawAmount) {
          throw new Error(
            `Payment wallet is ready, but it has ${balance.value.uiAmountString} tokens available. ` +
            `Fund the payment wallet with at least ${formatTokenAmount(rawAmount, mintDecimals)} ` +
            `before settling this payment.`,
          );
        }
      } catch (cause) {
        if (cause instanceof Error && /Payment wallet is ready/.test(cause.message)) throw cause;
        throw new Error("The payment wallet could not be read. Refresh the mandate and try again.");
      }
      const destination = await resolvePaymentDestination(recipient, mandate.allowedMint, tokenProgram, wallet);
      const mcpArgs: Record<string, unknown> = {
        mandate: mandate.address,
        agent: wallet,
        invoiceHash,
        paymentId,
        signatureReference,
        mint: mandate.allowedMint,
        recipient: destination.address,
        amount: rawAmount.toString(),
        tokenProgram,
      };
      const mcpResult = await onCallMcp("prepare_payment", mcpArgs);
      setMcpPreflight(toolText(mcpResult));

      const nextPrepared = await chainpayClient.preparePayment({
        mandate: mandate.address,
        invoiceHash: hexToBytes(invoiceHash),
        paymentId: hexToBytes(paymentId),
        signatureReference: hexToBytes(signatureReference),
        mint: mandate.allowedMint,
        recipient: destination.address,
        amount: rawAmount,
        tokenProgram,
      }, wallet);
      if (destination.createInstruction) {
        nextPrepared.transaction.instructions.unshift(destination.createInstruction);
      }
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
    if (!walletSigner) {
      setStatus("error");
      setError("The connected wallet does not expose transaction signing.");
      return;
    }
    setStatus("signing");
    setError("");
    try {
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(prepared.transaction, latest.blockhash);
      const signed = await walletSigner(transaction);
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
        ...(prepared.request.remainingAccounts?.length ? { remainingAccounts: prepared.request.remainingAccounts } : {}),
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
      <div className="builder-grid"><label className="field field-wide"><span>Invoice or payment reference</span><input value={invoice} onChange={(event) => { setInvoice(event.target.value); setPrepared(null); setSignature(""); }} placeholder="invoice-001" /></label><label className="field"><span>Amount <small>{mintDecimals === null ? "reading mint" : `${mintDecimals} decimals`}</small></span><input inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setPrepared(null); setSignature(""); }} placeholder="1.00" /></label><label className="field"><span>Agent signer</span><input value={wallet} readOnly /></label><label className="field"><span>Stablecoin</span><input value={stablecoinOptions.find((option) => option.mint === mandate.allowedMint)?.label ?? shortAddress(mandate.allowedMint)} readOnly /></label><label className="field field-wide"><span>Destination</span><input value={recipient} onChange={(event) => { setRecipient(event.target.value); setPrepared(null); setSignature(""); }} placeholder="Wallet or merchant address" /></label></div>
        <div className="payment-policy-note"><Shield /><span>Policy limit: <b>{formatTokenAmount(mandate.maxPerPayment, mintDecimals)}</b> per payment · <b>{formatTokenAmount(mandate.totalLimit, mintDecimals)}</b> total · {mandate.status}</span></div>
        <div className="builder-actions"><button className="button button-primary" onClick={() => void prepare()} disabled={status === "preparing" || status === "signing"}>{status === "preparing" ? "Calling MCP & simulating…" : "Prepare payment"} <Arrow /></button><span className="builder-safety"><Shield /> Wallet approval required to settle</span></div>
        {error && <div className="builder-error"><b>Payment blocked</b><span>{error}</span></div>}
        {signature && prepared && <div className="success-box"><span>✓</span><div><b>Payment confirmed on Devnet</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View settlement transaction <Arrow /></a><button className="receipt-address" onClick={() => navigator.clipboard?.writeText(prepared.receiptAddress)} title={prepared.receiptAddress}>Receipt PDA: {shortAddress(prepared.receiptAddress)} ⧉</button></div></div>}
      </div>
      <div className="payment-review-stack"><div className="dashboard-card review-card"><div className="dashboard-card-heading"><div><span className="section-kicker">POLICY PREFLIGHT</span><h2>{prepared ? "Payment review" : "Waiting for a request"}</h2></div><span className={`simulation-pill ${prepared?.preflight.valid && simulation?.ok ? "ok" : prepared ? "failed" : ""}`}><i /> {prepared ? (prepared.preflight.valid && simulation?.ok ? "Approved" : "Blocked") : "Waiting"}</span></div>{prepared ? <><div className="review-list payment-review-list"><div><span>Settlement amount</span><strong>{formatTokenAmount(prepared.request.amount, mintDecimals)} <small>({prepared.request.amount.toString()} base units)</small></strong></div><div><span>Stablecoin</span><strong>{stablecoinOptions.find((option) => option.mint === prepared.request.mint)?.label ?? shortAddress(prepared.request.mint)}</strong></div><div><span>Destination</span><strong className="mono">{shortAddress(prepared.request.recipient)}</strong></div><div><span>Signing wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div><div><span>Receipt</span><strong className="mono">{shortAddress(prepared.receiptAddress)}</strong></div></div><div className="check-list">{prepared.preflight.checks.map((check) => <div key={check.name} className={check.ok ? "check-row ok" : "check-row failed"}><span>{check.ok ? "✓" : "×"}</span><b>{check.name}</b><small>{check.message}</small></div>)}</div><div className="simulation-box"><span className="soft-label">MCP RESPONSE</span><pre>{mcpPreflight || "No MCP response returned."}</pre></div><div className="simulation-box"><span className="soft-label">SDK SIMULATION · {simulation?.ok ? "PASSED" : "FAILED"}</span><pre>{simulation?.logs.length ? simulation.logs.join("\n") : simulation?.error ?? "No simulation logs returned."}</pre></div><div className="review-gate"><Shield /><span>Signing will request approval from <b>{wallet}</b>. Nothing is submitted until the wallet approves.</span></div><button className="button button-dark full-button" onClick={() => void signPayment()} disabled={!prepared.preflight.valid || !simulation?.ok || status === "signing"}>{status === "signing" ? "Waiting for wallet…" : "Sign & settle payment"} <Arrow /></button></> : <div className="review-empty"><div className="empty-icon">↗</div><p>Enter an amount to see policy checks, simulation logs, and the receipt PDA before signing.</p></div>}</div></div>
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

function OverviewAssistant({ prompt, setPrompt, reply, thinking, listening, onAsk, onVoice }: { prompt: string; setPrompt: (value: string) => void; reply: string; thinking: boolean; listening: boolean; onAsk: () => void; onVoice: () => void }) {
  const hasReply = reply && !reply.startsWith("Ask ChainPay");
  return <div className="dashboard-card overview-agent-card">
    <div className="overview-agent-heading">
      <span className="overview-agent-avatar" aria-hidden="true">C</span>
      <div><span className="section-kicker">AGENT CONSOLE</span><h2>Ask ChainPay</h2></div>
      <span className="overview-agent-state"><i /> Ready</span>
    </div>
    <form className="overview-search" onSubmit={(event) => { event.preventDefault(); onAsk(); }}>
      <span className="overview-search-icon" aria-hidden="true">⌕</span>
      <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Search your mandate…" aria-label="Search your mandate" />
      <button type="button" className={listening ? "voice-button listening" : "voice-button"} onClick={onVoice} aria-label={listening ? "Stop voice input" : "Use voice input"}>{listening ? "■" : "●"}</button>
      <button type="submit" className="overview-search-submit" disabled={thinking} aria-label="Search mandate">{thinking ? "…" : "→"}</button>
    </form>
    {hasReply && <div className="overview-search-result"><span>{thinking ? "Searching…" : "Mandate result"}</span><pre>{reply}</pre></div>}
  </div>;
}

function AssistantPanel({ prompt, setPrompt, reply, thinking, listening, agentToolsUsed, onAsk, onVoice }: { prompt: string; setPrompt: (value: string) => void; reply: string; thinking: boolean; listening: boolean; agentToolsUsed: string[]; onAsk: () => void; onVoice: () => void }) {
  return <section className="assistant-layout"><div className="assistant-card dashboard-card"><div className="assistant-visual"><span className="assistant-caption">{listening ? "Listening…" : thinking ? "ChainPay agent is thinking…" : "Read-only AI agent"}</span><span className="overview-agent-state"><i /> Online</span></div><div className="assistant-log"><span className="soft-label">LIVE RESPONSE</span><p className="assistant-response">{reply}</p>{agentToolsUsed.length > 0 && <div className="assistant-tools-used"><span className="soft-label">TOOLS USED</span>{agentToolsUsed.map((tool, index) => <span className="tool-call-chip" key={`${tool}-${index}`}>{tool}</span>)}</div>}</div><div className="assistant-input"><input value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onAsk(); }} aria-label="Ask ChainPay" placeholder="Ask about your mandate, receipt, or agent permissions" /><button className={listening ? "voice-button listening" : "voice-button"} onClick={onVoice} aria-label={listening ? "Stop voice input" : "Use voice input"}>{listening ? "■" : "●"}</button><button className="button button-primary ask-button" onClick={onAsk} disabled={thinking}>Ask <Arrow /></button></div><small className="assistant-note">Voice is transcribed in your browser, then the AI agent calls only read-only ChainPay tools. It never signs or sends funds.</small></div><div className="assistant-side"><div className="dashboard-card"><span className="section-kicker">VOICE INPUT</span><h2>Give your agent a voice.</h2><p>Speak naturally. ChainPay sends the transcript to the read-only AI agent, which queries live MCP tools and explains the on-chain response before any action.</p><button className="button button-dark full-button" onClick={onVoice}>{listening ? "Stop listening" : "Start voice command"}</button></div><div className="dashboard-card safety-card"><Shield /><div><b>Safe by default</b><p>Payment execution stays behind wallet signing and explicit approval.</p></div></div></div></section>;
}

function AgentsPanel({ connections, onConnect, onOpenAssistant }: { connections: AgentConnection[]; onConnect: () => void; onOpenAssistant: () => void }) {
  return <section className="page-panel">
    <div className="page-panel-actions"><button className="button button-secondary-light" onClick={onOpenAssistant}>Open assistant <Arrow /></button><button className="button button-primary" onClick={onConnect}>Connect an agent <Arrow /></button></div>
    {connections.length ? <div className="agent-card-grid">{connections.map((connection) => <article className="dashboard-card agent-registry-card" key={connection.id}><div className="agent-registry-top"><span className="avatar-ring agent-avatar">{connection.agentName.slice(0, 2).toUpperCase()}</span><span className={connection.lastSeenAt ? "status-pill" : "simulation-pill"}><i /> {connection.lastSeenAt ? "Connected" : "Registered"}</span></div><h2>{connection.agentName}</h2><p className="mono">Owner · {shortAddress(connection.wallet)}</p><div className="agent-registry-meta"><span>{connection.mandates} active mandate{connection.mandates === 1 ? "" : "s"}</span><strong>{connectionSeenLabel(connection.lastSeenAt)}</strong></div><span className="chip chip-muted agent-scope-chip">{connection.scope}</span><div className="agent-tool-calls">{connection.toolsCalled.length ? connection.toolsCalled.map((tool) => <span className="tool-call-chip" key={tool.name}>{tool.name} <b>×{tool.count}</b></span>) : <span className="t-body-sm">No tools called yet.</span>}</div></article>)}</div> : <div className="dashboard-card page-empty"><p>No agents connected yet.</p><button className="button button-primary" onClick={onConnect}>Connect an agent <Arrow /></button></div>}
    {connections.length > 0 && <button className="button button-primary page-panel-primary" onClick={onConnect}>Connect an agent <Arrow /></button>}
  </section>;
}

function ToolsPanel({ mcpTools }: { mcpTools: McpTool[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const liveToolNames = new Set(mcpTools.map((tool) => tool.name));
  const tools = mcpTools.length ? [...mcpTools, ...coreToolReferences.filter((tool) => !liveToolNames.has(tool.name))] : coreToolReferences;
  return <section className="page-panel reference-list">
    {tools.map((tool) => {
      const schema = "inputSchema" in tool && tool.inputSchema ? tool.inputSchema : { type: "object", properties: {}, additionalProperties: false };
      return <article className="dashboard-card reference-card" key={tool.name}>
        <div className="reference-heading"><span className="chip chip-blue mono">{tool.name}</span><span className="chip chip-muted">All connected agents</span></div>
        <p>{tool.description ?? "ChainPay agent tool"}</p>
        <button className="reference-toggle" onClick={() => setExpanded(expanded === tool.name ? null : tool.name)} aria-expanded={expanded === tool.name}><span>{expanded === tool.name ? "⌃" : "⌄"} Input schema</span></button>
        {expanded === tool.name && <pre className="schema-block">{JSON.stringify(schema, null, 2)}</pre>}
      </article>;
    })}
  </section>;
}

function ConfirmDialog({ open, title, description, confirmLabel, onClose, onConfirm }: { open: boolean; title: string; description: string; confirmLabel: string; onClose: () => void; onConfirm: () => void }) {
  if (!open) return null;
  return <div className="app-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title"><div className="app-dialog-heading"><span className="section-kicker">CONFIRM ACTION</span><h2 id="confirm-dialog-title">{title}</h2></div><p>{description}</p><div className="app-dialog-actions"><button className="button button-secondary-light" onClick={onClose}>Cancel</button><button className="button button-dark" onClick={onConfirm}>{confirmLabel}</button></div></div></div>;
}

function ConnectMcpPanel({ serverUrl, wallet, connections, onConnected, onRevoked }: { serverUrl: string; wallet: string; connections: AgentConnection[]; onConnected: (connection: AgentConnection) => void; onRevoked: (id: string) => Promise<void> }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [scope, setScope] = useState("Unscoped");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const config = JSON.stringify({ mcpServers: { chainpay: { url: serverUrl, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) } } }, null, 2);

  async function createConnection() {
    if (!agentName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const result = await registerMcpConnection(wallet, agentName.trim(), scope);
      onConnected({ ...result.connection, mandates: result.connection.scope === "Current mandate" ? 1 : 0 });
      setToken(result.token);
      setDialogOpen(false);
      setAgentName("");
      setScope("Unscoped");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  return <section className="page-panel connect-panel">
    <div className="dashboard-card connection-config-card"><div className="dashboard-card-heading"><div><span className="section-kicker">CONNECTION CONFIG</span><h2>Server config</h2></div><span className="mcp-badge"><span /> Streamable HTTP</span></div><div className="copy-row"><span className="mono">{serverUrl}</span><button className="btn-icon" onClick={() => copyValue(serverUrl)} aria-label="Copy server URL">⧉</button></div><div className="config-code-wrap"><button className="button button-secondary-light copy-config" onClick={() => copyValue(config)}>Copy config</button><pre className="schema-block">{config}</pre></div></div>
    <div className="dashboard-card connected-clients-card"><div className="dashboard-card-heading"><div><span className="section-kicker">CONNECTED CLIENTS</span><h2>Agent connections</h2></div><button className="button button-primary" onClick={() => setDialogOpen(true)}>New connection <Arrow /></button></div>{connections.length ? <div className="connection-list">{connections.map((connection) => <div className="connection-row" key={connection.id}><div><strong>{connection.agentName}</strong><small className="mono">Owner · {shortAddress(connection.wallet)}</small></div><span className="chip chip-muted">{connection.scope}</span><span className="t-body-sm">{connectionSeenLabel(connection.lastSeenAt)}</span><button className="btn-icon" onClick={() => setRevokeId(connection.id)} aria-label={`Revoke ${connection.agentName}`}>×</button><div className="connection-tools">{connection.toolsCalled.length ? connection.toolsCalled.map((tool) => <span className="tool-call-chip" key={tool.name}>{tool.name} <b>×{tool.count}</b></span>) : <span>No tools called yet.</span>}</div></div>)}</div> : <div className="page-empty compact-empty"><p>No agents connected yet.</p><button className="button button-primary" onClick={() => setDialogOpen(true)}>New connection <Arrow /></button></div>}</div>
    {token && <div className="token-once"><span className="section-kicker">NEW CONNECTION TOKEN</span><div className="copy-row"><span className="mono">{token}</span><button className="btn-icon" onClick={() => copyValue(token)} aria-label="Copy connection token">⧉</button></div><p>Shown once. Store it securely.</p></div>}
    {dialogOpen && <div className="app-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialogOpen(false); }}><div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title"><div className="app-dialog-heading"><span className="section-kicker">NEW CONNECTION</span><h2 id="connection-dialog-title">Pair an agent</h2></div><label className="field"><span>Agent name</span><input autoFocus value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Invoice agent" /></label><label className="field"><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option>Unscoped</option><option disabled={!connections.length}>Current mandate{connections.length ? "" : " · create a connection first"}</option></select></label>{error && <p className="builder-error"><b>Connection failed</b><span>{error}</span></p>}<div className="app-dialog-actions"><button className="button button-secondary-light" onClick={() => setDialogOpen(false)}>Cancel</button><button className="button button-primary" onClick={() => void createConnection()} disabled={!agentName.trim() || creating}>{creating ? "Creating…" : "Create connection"} <Arrow /></button></div></div></div>}
    <ConfirmDialog open={Boolean(revokeId)} title="Revoke this connection?" description="This agent will no longer be able to call ChainPay tools with this connection." confirmLabel="Revoke connection" onClose={() => setRevokeId(null)} onConfirm={() => { if (revokeId) void onRevoked(revokeId); setRevokeId(null); }} />
  </section>;
}

function SettingsPanel({ wallet, dangerStatus, onRevokeAll, onDisconnect }: { wallet: string; dangerStatus: string; onRevokeAll: () => void; onDisconnect: () => void }) {
  const [section, setSection] = useState<"general" | "notifications" | "danger">("general");
  const [network, setNetwork] = useState("Devnet");
  const [webhook, setWebhook] = useState("");
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [confirmAction, setConfirmAction] = useState<"revoke" | "disconnect" | null>(null);
  return <section className="page-panel settings-panel">
    <div className="settings-tabs" role="tablist">{(["general", "notifications", "danger"] as const).map((item) => <button className={section === item ? "cp-tab active" : "cp-tab"} key={item} onClick={() => setSection(item)} role="tab" aria-selected={section === item}>{item === "general" ? "General" : item === "notifications" ? "Notifications" : "Danger zone"}</button>)}</div>
    {section === "general" && <div className="dashboard-card settings-card"><label className="field"><span>Network</span><select value={network} onChange={(event) => setNetwork(event.target.value)}><option>Devnet</option><option>Mainnet-beta</option></select></label><div className="settings-value"><span>Wallet address</span><div className="copy-row"><span className="mono">{wallet}</span><button className="btn-icon" onClick={() => copyValue(wallet)} aria-label="Copy wallet address">⧉</button></div></div></div>}
    {section === "notifications" && <div className="dashboard-card settings-card"><label className="field"><span>Webhook URL</span><input value={webhook} onChange={(event) => setWebhook(event.target.value)} placeholder="https://" /></label><div className="settings-actions"><button className="button button-secondary-light" onClick={() => setWebhook(webhook.trim())}>Save</button></div><div className="switch-row"><span><strong>Email alerts</strong><small>Email me when a mandate nears its limit.</small></span><button className={emailAlerts ? "toggle-switch on" : "toggle-switch"} onClick={() => setEmailAlerts((value) => !value)} role="switch" aria-checked={emailAlerts}><span /></button></div></div>}
    {section === "danger" && <div className="dashboard-card settings-card danger-card"><div className="danger-row"><div><strong>Revoke all mandates</strong><p>This immediately revokes every active mandate.</p></div><button className="button button-secondary-light danger-action" onClick={() => setConfirmAction("revoke")}>Revoke all</button></div><div className="danger-row"><div><strong>Disconnect wallet</strong><p>Return to the public ChainPay landing page.</p></div><button className="button button-secondary-light danger-action" onClick={() => setConfirmAction("disconnect")}>Disconnect</button></div>{dangerStatus && <p className="settings-status">{dangerStatus}</p>}</div>}
    <ConfirmDialog open={confirmAction === "revoke"} title="Revoke every active mandate?" description="This immediately revokes every active mandate. Agents will not be able to request payments until you create new ones." confirmLabel="Revoke all mandates" onClose={() => setConfirmAction(null)} onConfirm={() => { setConfirmAction(null); onRevokeAll(); }} />
    <ConfirmDialog open={confirmAction === "disconnect"} title="Disconnect this wallet?" description="You will leave the connected dashboard and return to the public site. Unsigned transactions will be discarded." confirmLabel="Disconnect wallet" onClose={() => setConfirmAction(null)} onConfirm={() => { setConfirmAction(null); onDisconnect(); }} />
  </section>;
}

type ProtocolPanelProps = {
  wallet: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  config: ProtocolConfig | null;
  onCreated: () => Promise<void>;
};

type AssetSnapshot = {
  mint: string;
  decimals?: number;
  tokenProgram?: string;
  registered: boolean;
  enabled: boolean;
};

function ProtocolPanel({ wallet, walletSigner, config, onCreated }: ProtocolPanelProps) {
  const emptyMint = PublicKey.default.toBase58();
  const [slots, setSlots] = useState([DEVNET_USDC_MINT, "", ""]);
  const [assets, setAssets] = useState<AssetSnapshot[]>([]);
  const [prepared, setPrepared] = useState<PreparedTransaction | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [status, setStatus] = useState<"idle" | "building" | "ready" | "signing" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");

  useEffect(() => {
    if (!config) {
      setSlots([DEVNET_USDC_MINT, "", ""]);
      setAssets([]);
      return;
    }
    setSlots([...config.supportedMints, "", ""].slice(0, 3));
    let active = true;
    void Promise.all(config.supportedMints.map(async (mint) => {
      const [asset, decimals] = await Promise.allSettled([
        chainpayClient.getSupportedAsset(mint),
        chainpayClient.getMintDecimals(mint),
      ]);
      return {
        mint,
        decimals: decimals.status === "fulfilled" ? decimals.value : undefined,
        tokenProgram: asset.status === "fulfilled" && asset.value ? asset.value.tokenProgram : undefined,
        registered: asset.status === "fulfilled" && asset.value !== null,
        enabled: asset.status === "fulfilled" && asset.value?.enabled === true,
      };
    })).then((nextAssets) => {
      if (active) setAssets(nextAssets);
    }).catch(() => {
      if (active) setAssets([]);
    });
    return () => { active = false; };
  }, [config?.address, config?.supportedMints.join(",")]);

  function updateSlot(index: number, value: string) {
    setSlots((current) => current.map((slot, slotIndex) => slotIndex === index ? value : slot));
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    setError("");
    setStatus("idle");
  }

  function normalizedSlots() {
    const normalized = slots.map((slot) => slot.trim() || emptyMint);
    const configured = normalized.filter((mint) => mint !== emptyMint);
    if (!configured.length) throw new Error("Add at least one supported mint.");
    if (new Set(configured).size !== configured.length) throw new Error("Each supported mint must be unique.");
    configured.forEach((mint) => new PublicKey(mint));
    return normalized;
  }

  async function buildPreview() {
    setStatus("building");
    setError("");
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    try {
      if (config) throw new Error("The protocol is already initialized on this program.");
      const nextPrepared = chainpayClient.buildInitializeConfig(normalizedSlots(), wallet);
      const nextSimulation = await chainpayClient.simulate(nextPrepared);
      setPrepared(nextPrepared);
      setSimulation(nextSimulation);
      setStatus(nextSimulation.ok ? "ready" : "error");
      if (!nextSimulation.ok) setError(nextSimulation.error ?? "Simulation rejected the initializer.");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function signAndInitialize() {
    if (!prepared || !simulation?.ok || !walletSigner) return;
    setStatus("signing");
    setError("");
    try {
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(prepared, latest.blockhash);
      const signed = await walletSigner(transaction);
      const result = await submitSignedTransaction(`config:${wallet}:${latest.blockhash}`, signed.serialize());
      setSignature(result.signature ?? "");
      setStatus("success");
      await onCreated();
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const isAuthority = config?.authority === wallet;

  return (
    <section className="protocol-layout">
      <div className="dashboard-card protocol-form-card">
        <div className="dashboard-card-heading">
          <div><span className="section-kicker">PROTOCOL CONFIG</span><h2>{config ? "Configuration is live" : "Initialize the protocol"}</h2></div>
          <span className={`simulation-pill ${config ? "ok" : ""}`}><i /> {config ? "On-chain" : "Not initialized"}</span>
        </div>
        <p className="builder-intro">Choose up to three mint addresses for the program config. Empty slots are stored as the zero address.</p>
        <div className="builder-grid protocol-slots">
          {slots.map((slot, index) => <label className="field field-wide" key={index}><span>Mint slot {index + 1} <small>{index === 0 ? "recommended" : "optional"}</small></span><input value={slot} onChange={(event) => updateSlot(index, event.target.value)} placeholder={index === 0 ? DEVNET_USDC_MINT : "Optional mint address"} readOnly={Boolean(config)} /></label>)}
        </div>
        {config ? <div className="protocol-authority"><span>Authority</span><strong className="mono">{shortAddress(config.authority)}</strong><small>{isAuthority ? "Connected wallet can manage this config." : "Connect the authority wallet to manage this config."}</small></div> : <div className="builder-actions"><button className="button button-primary" onClick={() => void buildPreview()} disabled={status === "building" || status === "signing"}>{status === "building" ? "Building & simulating…" : "Preview initializer"} <Arrow /></button><span className="builder-safety"><Shield /> Wallet approval required</span></div>}
        {error && <div className="builder-error"><b>Needs attention</b><span>{error}</span></div>}
      </div>

      <div className="dashboard-card protocol-review-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">SUPPORTED ASSETS</span><h2>{config ? `${assets.length} configured mint${assets.length === 1 ? "" : "s"}` : "Review transaction"}</h2></div>{config && <span className="network-chip"><i /> Devnet</span>}</div>
        {config ? <div className="asset-status-list">{assets.length ? assets.map((asset) => <div className="asset-status-row" key={asset.mint}><span className="asset-status-icon">{asset.enabled ? "✓" : "!"}</span><span><strong>{shortAddress(asset.mint)}</strong><small>{asset.tokenProgram ? (asset.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "Classic SPL Token") : "Not registered"}{asset.decimals === undefined ? "" : ` · ${asset.decimals} decimals`}</small></span><em className={asset.enabled ? "asset-enabled" : "asset-disabled"}>{asset.enabled ? "Enabled" : asset.registered ? "Disabled" : "Not registered"}</em></div>) : <div className="review-empty"><div className="empty-icon">◌</div><p>Reading asset registry…</p></div>}</div> : prepared ? <><div className="review-list"><div><span>Config PDA</span><strong className="mono">{shortAddress(deriveConfigAddress(PROGRAM_ID))}</strong></div><div><span>Instructions</span><strong>{prepared.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Authority</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="simulation-box"><pre>{simulation?.logs.length ? simulation.logs.join("\n") : simulation?.error ?? "No simulation logs returned."}</pre></div><button className="button button-dark full-button" onClick={() => void signAndInitialize()} disabled={!simulation?.ok || status === "signing" || !walletSigner}>{status === "signing" ? "Waiting for wallet…" : "Sign & initialize"} <Arrow /></button>{signature && <div className="success-box"><span>✓</span><div><b>Protocol initialized</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a></div></div>}</> : <div className="review-empty"><div className="empty-icon">◌</div><p>Preview the initializer to inspect the mint list and simulation before signing.</p></div>}
      </div>
    </section>
  );
}

type MandateForm = {
  approvedAgent: string;
  sourceTokenAccount: string;
  allowedMint: string;
  maxPerPayment: string;
  totalLimit: string;
  expiresInDays: string;
  maxPaymentCount: string;
  cooldownSlots: string;
  tokenProgram: TokenProgram;
};

function MandateBuilder({ wallet, walletSigner, stablecoinOptions, protocolConfig, onCreated }: { wallet: string; walletSigner?: (transaction: Transaction) => Promise<Transaction>; stablecoinOptions: StablecoinOption[]; protocolConfig: ProtocolConfig | null; onCreated: () => Promise<void> }) {
  const defaultStablecoin = stablecoinOptions.find((option) => option.value === "token-2022" && option.mint) ?? stablecoinOptions[0];
  const defaultSourceTokenAccount = defaultStablecoin?.mint
    ? deriveAssociatedTokenAddress(wallet, defaultStablecoin.mint, defaultStablecoin.tokenProgram)
    : "";
  const [form, setForm] = useState<MandateForm>({
    approvedAgent: wallet,
    sourceTokenAccount: defaultSourceTokenAccount,
    allowedMint: defaultStablecoin.mint,
    maxPerPayment: "10",
    totalLimit: "11",
    expiresInDays: "7",
    maxPaymentCount: "0",
    cooldownSlots: "0",
    tokenProgram: defaultStablecoin.tokenProgram,
  });
  const [stablecoin, setStablecoin] = useState(defaultStablecoin.value);
  const [prepared, setPrepared] = useState<PreparedMandate | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [status, setStatus] = useState<"idle" | "building" | "ready" | "signing" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [accountSignature, setAccountSignature] = useState("");
  const [accountSetup, setAccountSetup] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [mintDecimals, setMintDecimals] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    if (!wallet || !form.allowedMint.trim()) {
      setAccountSetup("idle");
      return () => { active = false; };
    }

    let tokenAccount: string;
    try {
      tokenAccount = deriveAssociatedTokenAddress(wallet, form.allowedMint.trim(), form.tokenProgram);
    } catch (cause) {
      setAccountSetup("error");
      setError(cause instanceof Error ? cause.message : String(cause));
      return () => { active = false; };
    }

    setForm((current) => current.sourceTokenAccount === tokenAccount ? current : { ...current, sourceTokenAccount: tokenAccount });
    setAccountSetup("working");
    void getAccountInfoOrNull(new PublicKey(tokenAccount)).then((account) => {
      if (!active) return;
      const issue = tokenAccountValidationError(account, form.allowedMint.trim(), wallet, form.tokenProgram);
      if (issue && account) {
        setAccountSetup("error");
        setError(issue);
      } else {
        setAccountSetup(issue ? "idle" : "ready");
      }
    }).catch((cause) => {
      if (!active) return;
      setAccountSetup("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => { active = false; };
  }, [wallet, form.allowedMint, form.tokenProgram]);

  useEffect(() => {
    if (stablecoin !== "usdc" || defaultStablecoin.value !== "token-2022" || form.allowedMint !== DEVNET_USDC_MINT) return;
    setStablecoin(defaultStablecoin.value);
    setForm((current) => ({ ...current, allowedMint: defaultStablecoin.mint, tokenProgram: defaultStablecoin.tokenProgram }));
  }, [defaultStablecoin.mint, defaultStablecoin.tokenProgram, defaultStablecoin.value, form.allowedMint, stablecoin]);

  useEffect(() => {
    let active = true;
    setMintDecimals(null);
    if (!form.allowedMint.trim()) return () => { active = false; };
    void chainpayClient.getMintDecimals(form.allowedMint.trim()).then((decimals) => {
      if (active) setMintDecimals(decimals);
    }).catch(() => {
      if (active) setMintDecimals(null);
    });
    return () => { active = false; };
  }, [form.allowedMint]);

  function updateField(field: keyof MandateForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    if (status !== "idle") setStatus("idle");
    setError("");
  }

  function updateStablecoin(value: string) {
    const option = stablecoinOptions.find((candidate) => candidate.value === value);
    if (!option || !option.mint) {
      setError("Token-2022 needs an enabled mint in the ChainPay asset registry.");
      return;
    }
    setStablecoin(option.value);
    const sourceTokenAccount = deriveAssociatedTokenAddress(wallet, option.mint, option.tokenProgram);
    setForm((current) => ({ ...current, allowedMint: option.mint, tokenProgram: option.tokenProgram, sourceTokenAccount }));
    setAccountSetup("idle");
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    setAccountSignature("");
    setStatus("idle");
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
      const mint = form.allowedMint.trim();
      const mintInfo = await getAccountInfoOrNull(new PublicKey(mint));
      if (!mintInfo) throw new Error(`The selected ${form.tokenProgram === "token-2022" ? "Token-2022" : "SPL Token"} mint was not found on this network. Run the Devnet bootstrap first.`);
      const expectedProgram = form.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
      if (mintInfo.owner.toBase58() !== expectedProgram) throw new Error("The selected mint does not belong to the selected token program.");

      const tokenAccount = deriveAssociatedTokenAddress(wallet, mint, form.tokenProgram);
      setForm((current) => ({ ...current, sourceTokenAccount: tokenAccount }));
      const existing = await getAccountInfoOrNull(new PublicKey(tokenAccount));
      if (existing) {
        const issue = tokenAccountValidationError(existing, mint, wallet, form.tokenProgram);
        if (issue) throw new Error(issue);
        setAccountSignature("");
        setAccountSetup("ready");
        return;
      }
      const balance = await chainpayClient.connection.getBalance(new PublicKey(wallet), "confirmed");
      if (balance === 0) {
        throw new Error("Add Devnet SOL to this wallet before preparing it for payments.");
      }
      if (!walletSigner) throw new Error("The connected wallet does not expose transaction signing.");
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
      const signed = await walletSigner(transaction);
      const result = await submitSignedTransaction(`ata:${wallet}:${tokenAccount}:${latest.blockhash}`, signed.serialize());
      setAccountSignature(result.signature ?? "");
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
      if (mintDecimals === null) throw new Error("Token decimals are not available yet. Check the selected mint.");
      if (accountSetup !== "ready" || !form.sourceTokenAccount.trim()) throw new Error("Prepare the payment wallet before continuing.");
      const days = Number(form.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Choose an expiry between 1 and 365 days.");
      const currentSlot = await chainpayClient.getCurrentSlot();
      const input = {
        approvedAgent: form.approvedAgent.trim(),
        sourceTokenAccount: form.sourceTokenAccount.trim(),
        allowedMint: form.allowedMint.trim(),
        maxPerPayment: parseTokenAmount(form.maxPerPayment, mintDecimals),
        totalLimit: parseTokenAmount(form.totalLimit, mintDecimals),
        expiresAtSlot: currentSlot + BigInt(days) * 216_000n,
        maxPaymentCount: BigInt(form.maxPaymentCount),
        cooldownSlots: BigInt(form.cooldownSlots),
        tokenProgram: form.tokenProgram,
      };
      const nextPrepared = await chainpayClient.buildCreateMandate(input, wallet);
      if (protocolConfig?.authority === wallet) {
        const asset = await chainpayClient.getSupportedAsset(input.allowedMint);
        const expectedTokenProgram = input.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
        if (asset && asset.tokenProgram !== expectedTokenProgram) {
          throw new Error("The selected mint is registered with a different token program.");
        }
        const setup = asset
          ? asset.enabled
            ? null
            : chainpayClient.buildSetAssetStatus(input.allowedMint, wallet, true)
          : chainpayClient.buildRegisterAsset(input.allowedMint, input.tokenProgram, wallet);
        if (setup) nextPrepared.transaction.instructions.unshift(...setup.instructions);
      }
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
    if (!walletSigner) {
      setStatus("error");
      setError("The connected wallet does not expose transaction signing.");
      return;
    }
    setStatus("signing");
    setError("");
    try {
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(prepared.transaction, latest.blockhash);
      const signed = await walletSigner(transaction);
      const result = await submitSignedTransaction(`mandate:${prepared.mandateAddress}:${latest.blockhash}`, signed.serialize());
      setSignature(result.signature ?? "");
      setStatus("success");
      await onCreated();
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const selectedStablecoin = stablecoinOptions.find((option) => option.value === stablecoin) ?? stablecoinOptions[0];

  return (
    <section className="mandate-builder-layout">
      <div className="dashboard-card mandate-builder">
        <div className="dashboard-card-heading">
          <div><span className="section-kicker">NEW MANDATE</span><h2>Set agent spending</h2></div>
          <span className="network-chip"><i /> Devnet</span>
        </div>
        <p className="builder-intro">Set exactly what this agent can spend, on what, and until when.</p>
        <div className="builder-grid simple-mandate-grid">
          <label className="field field-wide"><span>Agent</span><input value={form.approvedAgent} onChange={(event) => updateField("approvedAgent", event.target.value)} placeholder="Agent wallet address" /></label>
          <label className="field field-wide"><span>Stablecoin</span><select value={stablecoin} onChange={(event) => updateStablecoin(event.target.value)}>{stablecoinOptions.map((option) => <option value={option.value} key={option.value} disabled={!option.mint}>{option.label} · {option.detail}{option.mint ? "" : " · not configured"}</option>)}</select></label>
          <label className="field"><span>Max per payment</span><input inputMode="decimal" value={form.maxPerPayment} onChange={(event) => updateField("maxPerPayment", event.target.value)} placeholder="10" /></label>
          <label className="field"><span>Total spend limit</span><input inputMode="decimal" value={form.totalLimit} onChange={(event) => updateField("totalLimit", event.target.value)} placeholder="11" /></label>
          <label className="field field-wide"><span>Expires in</span><select value={form.expiresInDays} onChange={(event) => updateField("expiresInDays", event.target.value)}><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
        </div>
        <div className="account-setup-row"><div><span>Payment wallet</span><small>{accountSetup === "ready" ? "Ready" : accountSetup === "working" ? "Checking wallet" : "Needs setup"}</small></div><button className="inline-action" type="button" onClick={() => void setupWalletTokenAccount()} disabled={accountSetup === "working"}>{accountSetup === "working" ? "Checking…" : accountSetup === "ready" ? "Ready" : "Prepare wallet"}</button></div>
        {accountSetup === "ready" && <div className="success-box"><span>✓</span><div><b>{accountSignature ? "Payment wallet prepared" : "Payment wallet ready"}</b><a href={accountSignature ? `https://explorer.solana.com/tx/${accountSignature}?cluster=devnet` : `https://explorer.solana.com/address/${form.sourceTokenAccount}?cluster=devnet`} target="_blank" rel="noreferrer">{accountSignature ? "View account transaction" : "View wallet activity"} <Arrow /></a></div></div>}
        <div className="builder-actions"><button className="button button-primary" onClick={() => void buildPreview()} disabled={status === "building" || status === "signing"}>{status === "building" ? "Reviewing…" : "Review mandate"} <Arrow /></button><span className="builder-safety"><Shield /> Wallet approval required</span></div>
        {error && <div className="builder-error"><b>Needs attention</b><span>{error}</span></div>}
      </div>

      <div className="dashboard-card review-card mandate-review-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">REVIEW</span><h2>{prepared ? "Ready to sign" : "Your mandate"}</h2></div><span className={`simulation-pill ${simulation?.ok ? "ok" : simulation ? "failed" : ""}`}><i /> {simulation ? (simulation.ok ? "Simulated" : "Rejected") : "Waiting"}</span></div>
        {prepared ? <>
          <div className="mandate-summary"><div><span>Agent</span><strong className="mono">{shortAddress(form.approvedAgent)}</strong></div><div><span>Stablecoin</span><strong>{selectedStablecoin.label} <small>{selectedStablecoin.detail}</small></strong></div><div><span>Recipient</span><strong>Chosen per payment</strong></div><div><span>Max per payment</span><strong>{form.maxPerPayment}</strong></div><div><span>Total spend limit</span><strong>{form.totalLimit}</strong></div><div><span>Expires in</span><strong>{form.expiresInDays} days</strong></div></div>
          <details className="technical-details"><summary>Transaction details</summary><div className="review-list"><div><span>Mandate PDA</span><strong className="mono">{shortAddress(prepared.mandateAddress)}</strong></div><div><span>Instructions</span><strong>{prepared.transaction.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Fee payer</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="simulation-box"><pre>{simulation?.logs.length ? simulation.logs.join("\n") : simulation?.error ?? "No simulation logs returned."}</pre></div></details>
          <button className="button button-dark full-button" onClick={() => void signAndCreate()} disabled={!simulation?.ok || status === "signing" || status === "success"}>{status === "signing" ? "Waiting for wallet…" : status === "success" ? "Mandate created" : "Sign & create mandate"} <Arrow /></button>
          {signature && <div className="success-box"><span>✓</span><div><b>Mandate created</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a></div></div>}
        </> : <div className="review-empty"><div className="empty-icon">◇</div><p>Review the mandate before signing.</p></div>}
      </div>
    </section>
  );
}

export default App;
