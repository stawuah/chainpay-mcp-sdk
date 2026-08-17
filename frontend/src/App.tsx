import { useEffect, useRef, useState, type ReactNode } from "react";
import { Buffer } from "buffer";
import { ChainPayClient, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, buildCreateAssociatedTokenAccountInstruction, bytesToHex, deriveAssociatedTokenAddress, deriveConfigAddress, deriveMandateAddress, toWeb3Transaction } from "@chainpay/sdk";
import type { ChainPayInstruction, Mandate, PaymentReceipt, PreparedMandate, PreparedPayment, PreparedTransaction, SimulationResult, TokenProgram } from "@chainpay/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";
import { connectChainPayWallet, restoreChainPayWallet, type ChainPayWallet } from "./wallet";
import connectorRoutingImage from "./assets/connector-routing.png";

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
const MAX_MANDATES_VISIBLE = 50;
const MAX_PAYMENT_MANDATES = 5;
type StablecoinOption = {
  value: "usdc" | "token-2022";
  label: string;
  detail: string;
  mint: string;
  tokenProgram: TokenProgram;
};

function buildStablecoinOptions(token2022Mint: string): StablecoinOption[] {
  return [
    { value: "token-2022", label: "PYUSD", detail: "Token-2022", mint: token2022Mint, tokenProgram: "token-2022" },
    { value: "usdc", label: "USDC", detail: "SPL Token", mint: DEVNET_USDC_MINT, tokenProgram: "spl-token" },
  ];
}

function mandateDisplayName(mandate: Mandate, mandates: Mandate[], stablecoinOptions: StablecoinOption[]) {
  const option = stablecoinOptions.find((candidate) => candidate.mint === mandate.allowedMint);
  const tokenLabel = option?.label ?? (mandate.tokenProgram === "token-2022" ? "Token-2022" : "SPL Token");
  const sameToken = mandates
    .filter((candidate) => candidate.allowedMint === mandate.allowedMint)
    .sort(compareMandatesByCreation)
    .map((candidate) => candidate.address);
  const policyNumber = sameToken.indexOf(mandate.address) + 1;
  return `${tokenLabel} settlement policy ${policyNumber > 0 ? policyNumber : ""}`.trim();
}

function compareMandatesByCreation(left: Mandate, right: Mandate) {
  const createdAtDifference = (right.createdAt ?? 0) - (left.createdAt ?? 0);
  return createdAtDifference || right.address.localeCompare(left.address);
}

function mandateCreatedLabel(mandate: Mandate) {
  if (mandate.createdAt !== undefined) {
    const date = new Date(mandate.createdAt * 1_000);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    }
  }
  return mandate.createdAtSlot === undefined ? "Creation time unavailable" : `Created at slot ${mandate.createdAtSlot}`;
}

type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpToolResponse = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
type AgentHistoryItem = { role: "user" | "assistant"; content: string };
type AgentAttachment = {
  name: string;
  mimeType: string;
  kind: "image" | "document";
  size: number;
  dataUrl?: string;
  text?: string;
};
type AgentAttachmentPreview = Pick<AgentAttachment, "name" | "mimeType" | "kind" | "size"> & { previewUrl?: string; textPreview?: string };
type AgentApproval = {
  kind: "mandate" | "payment";
  action: string;
  mandateAddress?: string;
  configAddress?: string;
  payment?: Record<string, unknown>;
  transaction?: {
    feePayer?: string;
    requiredSigners?: string[];
    instructions?: Array<{
      name: string;
      programId: string;
      keys: Array<{ address: string; isSigner: boolean; isWritable: boolean }>;
      dataBase64: string;
    }>;
  };
  [key: string]: unknown;
};
type AgentOutcome = {
  kind: "mandate_approval_required" | "payment_approval_required" | "payment_settled" | "payment_blocked" | "details_required";
  receiptAddress?: string;
  signature?: string;
  status?: string;
};
type AgentCheck = {
  key: "limits" | "token" | "recipient" | "expiry" | "policy";
  label: string;
  status: "pass" | "fail" | "missing" | "pending";
  detail: string;
};
type AgentRequirements = {
  status: "ready" | "needs_details" | "blocked";
  missing: string[];
  checks: AgentCheck[];
};
type AgentResponse = { message: string; toolCalls?: string[]; approval?: AgentApproval; outcome?: AgentOutcome; requirements?: AgentRequirements; error?: string };
type AgentInboxStage = "received" | "understood" | "mandate_prepared" | "policy_checked" | "needs_details" | "waiting_for_approval" | "approved" | "receipt_ready" | "blocked";
type AgentInboxItem = {
  id: string;
  createdAt: string;
  source: "message" | "invoice" | "mandate";
  title: string;
  prompt: string;
  response: string;
  stage: AgentInboxStage;
  toolCalls: string[];
  attachments: AgentAttachmentPreview[];
  approval?: AgentApproval;
  outcome?: AgentOutcome;
  requirements?: AgentRequirements;
  error?: string;
};
type ApprovalStatus = "idle" | "signing" | "success" | "error";
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
    name: "list_mandates",
    description: "Discover all ChainPay mandates owned by a wallet and their live delegation status.",
    inputSchema: { type: "object", properties: { owner: { type: "string" } }, required: ["owner"], additionalProperties: false },
  },
  {
    name: "find_compatible_mandate",
    description: "Find an active mandate compatible with an invoice mint, amount, token program, and agent.",
    inputSchema: { type: "object", properties: { owner: { type: "string" }, mint: { type: "string" }, amount: { type: "string" }, tokenProgram: { type: "string" }, agent: { type: "string" } }, required: ["owner", "mint", "amount"], additionalProperties: false },
  },
  {
    name: "create_demo_payment_request",
    description: "Create a valid, merchant-signed Devnet demo payment request using a real token account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "quote_payment_request",
    description: "Verify a merchant-signed request, derive payment references, and quote it against a mandate.",
    inputSchema: { type: "object", properties: { request: { type: "object" }, mandate: { type: "string" }, agent: { type: "string" } }, required: ["request", "mandate", "agent"], additionalProperties: false },
  },
  {
    name: "get_mandate",
    description: "Read an on-chain ChainPay payment mandate and its current status.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Mandate PDA address" } }, required: ["address"], additionalProperties: false },
  },
  {
    name: "check_payment_requirements",
    description: "Check whether a payment has the token, recipient, amount, expiry, mandate limits, and policy details needed to proceed.",
    inputSchema: { type: "object", properties: { mandate: { type: "string" }, agent: { type: "string" }, request: { type: "object", description: "Optional signed merchant request; MCP derives its payment references" }, mint: { type: "string" }, recipient: { type: "string" }, amount: { type: "string" }, tokenProgram: { type: "string" }, invoiceHash: { type: "string" }, paymentId: { type: "string" }, signatureReference: { type: "string" } }, additionalProperties: false },
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

function buildMcpClientConfig(serverUrl: string, token?: string) {
  return JSON.stringify({
    mcpServers: {
      chainpay: {
        url: serverUrl,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    },
  }, null, 2);
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

const AGENT_INBOX_STORAGE_KEY = "chainpay.ai-inbox.v1";
const MAX_AGENT_ATTACHMENT_BYTES = 500_000;
const MAX_AGENT_ATTACHMENT_TEXT = 12_000;
const agentFlowSteps = ["AI receives", "Understands", "Creates mandate", "Checks policy", "Routes", "You approve", "Settles", "Receipts"] as const;

function agentInboxKey(wallet: string) {
  return `${AGENT_INBOX_STORAGE_KEY}:${wallet}`;
}

function loadAgentInbox(wallet: string): AgentInboxItem[] {
  if (!wallet || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(agentInboxKey(wallet)) ?? "null") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AgentInboxItem => Boolean(
      item && typeof item === "object" &&
      typeof (item as AgentInboxItem).id === "string" &&
      typeof (item as AgentInboxItem).prompt === "string" &&
      typeof (item as AgentInboxItem).response === "string" &&
      typeof (item as AgentInboxItem).stage === "string",
    )).slice(0, 30);
  } catch {
    return [];
  }
}

function persistAgentInbox(wallet: string, items: AgentInboxItem[]) {
  if (!wallet || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(agentInboxKey(wallet), JSON.stringify(items.slice(0, 30)));
  } catch {
    // The inbox remains usable for this session if local storage is unavailable.
  }
}

function attachmentKind(file: File): AgentAttachment["kind"] {
  return file.type.startsWith("image/") ? "image" : "document";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(`Could not read ${file.name}.`));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function readAgentAttachment(file: File): Promise<AgentAttachment> {
  if (file.size > MAX_AGENT_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than 500 KB. Upload a smaller invoice or image.`);
  }
  const base = { name: file.name, mimeType: file.type || "application/octet-stream", kind: attachmentKind(file), size: file.size } as const;
  if (base.kind === "image") return { ...base, dataUrl: await readFileAsDataUrl(file) };
  if (file.type.startsWith("text/") || /\.(csv|json|md|txt)$/i.test(file.name)) {
    return { ...base, text: (await file.text()).slice(0, MAX_AGENT_ATTACHMENT_TEXT) };
  }
  return base;
}

function attachmentPreview(attachment: AgentAttachment): AgentAttachmentPreview {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.size,
    ...(attachment.dataUrl ? { previewUrl: attachment.dataUrl } : {}),
    ...(attachment.text ? { textPreview: attachment.text.slice(0, 180) } : {}),
  };
}

function inboxSource(prompt: string, attachments: AgentAttachment[]) {
  if (attachments.length > 0 || /invoice|receipt|bill|image|document|pdf/i.test(prompt)) return "invoice" as const;
  if (/mandate|policy|allowance|spend limit/i.test(prompt)) return "mandate" as const;
  return "message" as const;
}

function inboxTitle(prompt: string, attachments: AgentAttachment[]) {
  if (attachments.length) return `AI received ${attachments[0].name}${attachments.length > 1 ? ` + ${attachments.length - 1} more` : ""}`;
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact || "AI request";
}

function paymentRequestFromAttachments(attachments: AgentAttachment[]) {
  for (const attachment of attachments) {
    if (!attachment.text || !/\.json$/i.test(attachment.name)) continue;
    try {
      const candidate = JSON.parse(attachment.text) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const record = candidate as Record<string, unknown>;
        if (record.payload && typeof record.payload === "object" && typeof record.signature === "string") return record;
      }
    } catch {
      // The agent will ask for a structured signed request when a JSON attachment is incomplete.
    }
  }
  return undefined;
}

function paymentRequestFromMessage(message: string): Record<string, unknown> | undefined {
  const payloadBlock = message.match(/(?:"|'?)payload(?:"|'?)\s*:\s*\{([\s\S]*?)\}\s*,\s*(?:"|'?)signature(?:"|'?)\s*:/i)?.[1];
  if (!payloadBlock) return undefined;
  const stringField = (name: string) => payloadBlock.match(new RegExp(`(?:"|'?)${name}(?:"|'?)\\s*:\\s*(?:"|'?)([^"'\\r\\n]+)(?:"|'?)`, "i"))?.[1]?.trim();
  const version = Number(payloadBlock.match(/(?:"|'?)version(?:"|'?)\s*:\s*(\d+)/i)?.[1]);
  const decimals = Number(payloadBlock.match(/(?:"|'?)decimals(?:"|'?)\s*:\s*(\d+)/i)?.[1]);
  const signature = message.match(/(?:"|'?)signature(?:"|'?)\s*:\s*["']([\s\S]*?)["']/i)?.[1]?.replace(/\s+/g, "");
  const payload = {
    version,
    cluster: stringField("cluster"),
    merchant: stringField("merchant"),
    invoice: stringField("invoice"),
    mint: stringField("mint"),
    tokenProgram: stringField("tokenProgram"),
    recipient: stringField("recipient"),
    amount: stringField("amount"),
    decimals,
    nonce: stringField("nonce"),
    expiresAtSlot: stringField("expiresAtSlot"),
    resource: stringField("resource"),
  };
  if (!Number.isInteger(version) || !Number.isInteger(decimals) || !signature || Object.values(payload).some((value) => value === undefined || value === "")) return undefined;
  return { payload, signature };
}

function paymentRequestFromPastedText(message: string): Record<string, unknown> | undefined {
  const payloadBlock = message.match(/(?:"|'?)payload(?:"|'?)\s*:\s*\{([\s\S]*?)\}\s*,\s*(?:"|'?)signature(?:"|'?)\s*:/i)?.[1];
  const source = payloadBlock ?? message;
  const readField = (names: string[]) => {
    const keyPattern = names.join("|");
    const pattern = "(?:\"|'?)(" + keyPattern + ")(?:\"|'?)\\s*[:=]\\s*(?:\"|'?)([^\"'\\r\\n,}]+)(?:\"|'?)";
    return source.match(new RegExp(pattern, "i"))?.[2]?.trim();
  };
  const version = Number(readField(["version"]));
  const decimals = Number(readField(["decimals"]));
  const cluster = readField(["cluster"]);
  const merchant = readField(["merchant"]);
  const invoice = readField(["invoice"]);
  const mint = readField(["token\\s+mint", "mint"]);
  const tokenProgramText = readField(["token\\s*program", "tokenProgram"]);
  const tokenProgram = /token[- ]?2022/i.test(tokenProgramText ?? "")
    ? "token-2022"
    : /classic\\s+spl|spl[- ]?token/i.test(tokenProgramText ?? "")
      ? "spl-token"
      : tokenProgramText;
  const recipient = readField(["recipient\\s+token\\s+account", "recipient"]);
  const amount = readField(["payment\\s+amount", "amount"]);
  const nonce = readField(["nonce"]);
  const expiresAtSlot = readField(["expiresAtSlot", "expires\\s*at\\s*slot"]);
  const resource = readField(["resource"]);
  const quotedSignature = message.match(/(?:"|'?)signature(?:"|'?)\s*[:=]\s*["']([\s\S]*?)["']/i)?.[1];
  const plainSignature = message.match(/(?:"|'?)signature(?:"|'?)\s*[:=]\s*([A-Za-z0-9+/=]{40,}(?:\s*\n\s*[A-Za-z0-9+/=]+)*)/i)?.[1];
  const signature = (quotedSignature ?? plainSignature)?.replace(/\s+/g, "");
  const payload = { version, cluster, merchant, invoice, mint, tokenProgram, recipient, amount, decimals, nonce, expiresAtSlot, resource };
  if (!Number.isInteger(version) || !Number.isInteger(decimals) || !signature || !/^[A-Za-z0-9+/=]+$/.test(signature) || Object.values(payload).some((value) => value === undefined || value === "")) return undefined;
  return { payload, signature };
}

type PastedPaymentDetails = {
  mandate?: string;
  agent?: string;
  mint?: string;
  tokenProgram?: "spl-token" | "token-2022";
  recipient?: string;
  amount?: string;
};

const SOLANA_ADDRESS_PATTERN = "[1-9A-HJ-NP-Za-km-z]{32,44}";

function pastedField(message: string, label: string) {
  return message.match(new RegExp(`${label}\\s*:\\s*(${SOLANA_ADDRESS_PATTERN})`, "i"))?.[1];
}

function pastedPaymentDetails(message: string): PastedPaymentDetails | null {
  const mandate = pastedField(message, "Mandate");
  const agent = pastedField(message, "Approved agent");
  const mint = pastedField(message, "Token mint");
  const tokenProgramText = message.match(/Token program\s*:\s*([^\n]+)/i)?.[1] ?? "";
  const tokenProgram = /token[- ]?2022/i.test(tokenProgramText)
    ? "token-2022"
    : /classic\s+spl/i.test(tokenProgramText) || /spl[- ]?token/i.test(tokenProgramText)
      ? "spl-token"
      : undefined;
  const recipient = message.match(new RegExp(`(?:recipient\\s+token\\s+account(?:\\s+for\\s+testing)?|use\\s+this\\s+(?:usdc|pyusd)?\\s*recipient\\s+token\\s+account\\s+for\\s+testing)\\s*:\\s*(${SOLANA_ADDRESS_PATTERN})`, "i"))?.[1];
  const amount = message.match(/(?:payment\s+amount|amount\s+to\s+pay|amount)\s*:\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]
    ?? message.match(/\b(?:pay|send|transfer|route|settle)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:usdc|pyusd|tokens?)\b/i)?.[1];
  const details = { mandate, agent, mint, tokenProgram, recipient, amount } satisfies PastedPaymentDetails;
  return Object.values(details).some(Boolean) ? details : null;
}

function asksAgentToCreatePaymentRequest(message: string) {
  return /\b(?:create|generate|make)\b[\s\S]{0,160}\b(?:signed\s+)?(?:devnet\s+)?(?:demo\s+)?(?:payment\s+request|invoice)\b/i.test(message);
}

function demoPaymentRequestArguments(message: string): Record<string, unknown> | undefined {
  const invoice = message.match(/Invoice\s*:\s*([^\n]+)/i)?.[1]?.trim();
  const mint = message.match(new RegExp(`(?:Token mint|Mint)\\s*:\\s*(${SOLANA_ADDRESS_PATTERN})`, "i"))?.[1];
  const recipient = message.match(new RegExp(`Recipient\\s+token\\s+account\\s*:\\s*(${SOLANA_ADDRESS_PATTERN})`, "i"))?.[1];
  const amount = message.match(/Amount\s*:\s*([0-9]+)/i)?.[1];
  const tokenProgramText = message.match(/Token program\s*:\s*([^\n]+)/i)?.[1] ?? "";
  const tokenProgram = /token[- ]?2022/i.test(tokenProgramText) ? "token-2022" : /spl[- ]?token|classic\s+spl/i.test(tokenProgramText) ? "spl-token" : undefined;
  if (!invoice || !mint || !recipient || !amount || !tokenProgram) return undefined;
  return { invoice, mint, recipient, amount, tokenProgram };
}

function pastedPaymentResponse(details: PastedPaymentDetails): AgentResponse {
  const missing: string[] = ["a merchant-signed ChainPay payment request or invoice"];
  const checks: AgentCheck[] = [
    {
      key: "limits",
      label: "Limits",
      status: details.amount ? "pending" : "missing",
      detail: details.amount ? "I found the payment amount and will check it against the mandate limits." : "Provide the amount you want to pay so I can check the per-payment and total limits.",
    },
    {
      key: "token",
      label: "Token",
      status: details.mint && details.tokenProgram ? "pending" : "missing",
      detail: details.mint && details.tokenProgram ? "I found the USDC mint and token type and will check them against the mandate." : "Provide the token mint and token program.",
    },
    {
      key: "recipient",
      label: "Recipient",
      status: details.recipient ? "pending" : "missing",
      detail: details.recipient ? "I found the recipient token account for this payment." : "Provide the recipient token account for this payment.",
    },
    {
      key: "expiry",
      label: "Expiry",
      status: details.mandate ? "pending" : "missing",
      detail: details.mandate ? "I found the mandate and will check that it is active and unexpired." : "Provide the active mandate so I can check its expiry.",
    },
    {
      key: "policy",
      label: "Policy",
      status: details.mandate && details.agent ? "missing" : "missing",
      detail: details.mandate && details.agent
        ? "I found the mandate and approved agent, but I still need a merchant-signed request or invoice to verify the payment policy."
        : "Provide the active mandate, approved agent, and merchant-signed request.",
    },
  ];
  if (!details.amount) missing.push("payment amount");
  if (!details.mint || !details.tokenProgram) missing.push("token mint and token program");
  if (!details.recipient) missing.push("recipient token account");
  if (!details.mandate || !details.agent) missing.push("active mandate and its approved agent");
  return {
    message: details.mandate && details.mint && details.tokenProgram && details.recipient
      ? `I found your active mandate, ${details.tokenProgram === "spl-token" ? "USDC" : "Token-2022"} payment details, approved agent, and recipient. Before I route the payment, I still need ${missing.join(" and ")}.`
      : `I found some payment details, but I still need ${missing.join(" and ")}.`,
    toolCalls: [],
    outcome: { kind: "details_required" },
    requirements: { status: "needs_details", missing, checks },
  };
}

function inboxStageForResult(result: AgentResponse): AgentInboxStage {
  if (result.outcome?.kind === "payment_settled") return "receipt_ready";
  if (result.outcome?.kind === "details_required" || result.requirements?.status === "needs_details") return "needs_details";
  if (result.outcome?.kind === "payment_blocked") return "blocked";
  if (result.approval) return "waiting_for_approval";
  if (result.toolCalls?.includes("create_mandate")) return "mandate_prepared";
  if (result.toolCalls?.some((tool) => ["quote_payment_request", "quote_payment", "find_compatible_mandate", "verify_payment_request"].includes(tool))) return "policy_checked";
  return result.toolCalls?.length ? "understood" : "received";
}

function agentStageIndex(stage: AgentInboxStage) {
  switch (stage) {
    case "received": return 0;
    case "understood": return 1;
    case "mandate_prepared": return 2;
    case "policy_checked": return 3;
    case "needs_details": return 3;
    case "waiting_for_approval": return 5;
    case "approved": return 5;
    case "receipt_ready": return 7;
    case "blocked": return 3;
  }
}

async function callChainPayAgent(
  message: string,
  context: { wallet: string; mandateAddress?: string; history: AgentHistoryItem[]; paymentRequest?: Record<string, unknown>; attachments?: AgentAttachment[] },
): Promise<AgentResponse> {
  const response = await fetch(AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message, wallet: context.wallet, mandateAddress: context.mandateAddress, history: context.history, paymentRequest: context.paymentRequest, attachments: context.attachments }),
  });
  const payload = await response.json() as AgentResponse;
  if (!response.ok) throw new Error(payload.error ?? `AI agent request failed (${response.status})`);
  return payload;
}

function preparedTransactionFromAgentApproval(approval: AgentApproval): PreparedTransaction {
  const serialized = approval.transaction;
  if (!serialized || !Array.isArray(serialized.instructions) || serialized.instructions.length === 0) {
    throw new Error("The approval request did not include a transaction.");
  }
  return {
    feePayer: serialized.feePayer,
    requiredSigners: serialized.requiredSigners ?? [],
    instructions: serialized.instructions.map((instruction) => ({
      name: instruction.name,
      programId: instruction.programId,
      keys: instruction.keys,
      data: Uint8Array.from(Buffer.from(instruction.dataBase64, "base64")),
    })),
  };
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

function stablecoinOrder(mint: string, options: StablecoinOption[]) {
  const index = options.findIndex((option) => option.mint === mint);
  return index === -1 ? options.length : index;
}

async function getAccountInfoOrNull(address: PublicKey) {
  try {
    return await chainpayClient.connection.getAccountInfo(address, "confirmed");
  } catch (cause) {
    if (cause instanceof Error && /accountnotfound/i.test(cause.message)) return null;
    throw cause;
  }
}

function readTokenAccountDelegate(account: { data: Uint8Array } | null): string | null {
  if (!account || account.data.length < 108) return null;
  const delegateOption = new DataView(account.data.buffer, account.data.byteOffset + 72, 4).getUint32(0, true);
  return delegateOption === 0 ? null : new PublicKey(account.data.slice(76, 108)).toBase58();
}

function readTokenAccountDelegatedAmount(account: { data: Uint8Array } | null): bigint {
  if (!account || account.data.length < 129) return 0n;
  return new DataView(account.data.buffer, account.data.byteOffset + 121, 8).getBigUint64(0, true);
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

async function isPaymentMandateUsable(value: Mandate): Promise<boolean> {
  if (value.status !== "active") return false;
  try {
    const tokenProgram = value.tokenProgram ?? await chainpayClient.getTokenProgram(value.sourceTokenAccount);
    const account = await getAccountInfoOrNull(new PublicKey(value.sourceTokenAccount));
    if (tokenAccountValidationError(account, value.allowedMint, value.owner, tokenProgram)) return false;
    return readTokenAccountDelegate(account) === value.address && readTokenAccountDelegatedAmount(account) > 0n;
  } catch {
    return false;
  }
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

const connectorRoadmap = [
  { name: "x402", detail: "HTTP payment requests", logo: "https://x402.org/wp-content/uploads/sites/10/2026/06/favicon.png", href: "https://x402.org/" },
  { name: "Lobster.cash", detail: "Scoped agent wallets", logo: "https://www.lobster.cash/lobster-logo-icon.svg", href: "https://www.lobster.cash/" },
  { name: "Your agent stack", detail: "Custom rail adapters", logo: "", href: "" },
] as const;

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
  const [heroMessage, setHeroMessage] = useState<"rail" | "sign">("rail");
  const [mandateAddress, setMandateAddress] = useState("");
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [protocolConfig, setProtocolConfig] = useState<ProtocolConfig | null>(null);
  const [token2022Mint, setToken2022Mint] = useState(TOKEN_2022_MINT_OVERRIDE);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [mcpResult, setMcpResult] = useState<McpToolResponse | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [integrationError, setIntegrationError] = useState("");
  const wallet = walletConnection?.address ?? "";

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(() => {
      setHeroMessage((current) => current === "rail" ? "sign" : "rail");
    }, 3000);
    return () => window.clearInterval(interval);
  }, []);

  async function loadWalletState(owner: string, preferredMandateAddress?: string) {
    const legacyAddress = deriveMandateAddress(owner, PROGRAM_ID);
    setMandateAddress(preferredMandateAddress ?? legacyAddress);
    setIntegrationStatus("loading");
    setIntegrationError("");

    const [configState, toolsState] = await Promise.allSettled([
      chainpayClient.getConfig(),
      mcpRequest<{ tools: McpTool[] }>("tools/list"),
    ]);

    const nextConfig = configState.status === "fulfilled" ? configState.value : null;
    if (configState.status === "fulfilled") setProtocolConfig(nextConfig);
    if (toolsState.status === "fulfilled") setMcpTools(toolsState.value.tools ?? []);

    const candidateMints = [...new Set([
      DEVNET_USDC_MINT,
      DEVNET_PYUSD_TOKEN_2022_MINT,
      ...(nextConfig?.supportedMints ?? []),
    ])];
    const candidateAddresses = [
      legacyAddress,
      ...candidateMints.map((mint) => deriveMandateAddress(owner, PROGRAM_ID, mint)),
    ];
    const discoveredState = await Promise.allSettled([
      chainpayClient.getMandatesByOwner(owner),
    ]);
    const mandateStates = await Promise.allSettled(
      [...new Set(candidateAddresses)].map((address) => chainpayClient.getMandate(address)),
    );
    const discoveredMandates = discoveredState[0]?.status === "fulfilled" ? discoveredState[0].value : [];
    const fallbackMandates = mandateStates
      .filter((state): state is PromiseFulfilledResult<Mandate | null> => state.status === "fulfilled")
      .map((state) => state.value)
      .filter((value): value is Mandate => value !== null);
    const nextMandates = Array.from(new Map(
      [...discoveredMandates, ...fallbackMandates].map((value) => [value.address, value]),
    ).values()).sort(compareMandatesByCreation);
    const usableMandates = (await Promise.all(
      nextMandates.map(async (value) => (await isPaymentMandateUsable(value) ? value : null)),
    )).filter((value): value is Mandate => value !== null);
    const selectedMandate = usableMandates.find((value) => value.address === preferredMandateAddress)
      ?? usableMandates.find((value) => value.allowedMint === DEVNET_USDC_MINT)
      ?? usableMandates[0]
      ?? nextMandates.find((value) => value.address === preferredMandateAddress && value.status === "active")
      ?? nextMandates.find((value) => value.status === "active")
      ?? nextMandates.find((value) => value.address === preferredMandateAddress && value.status !== "revoked")
      ?? nextMandates.find((value) => value.status !== "revoked")
      ?? nextMandates[0]
      ?? null;
    setMandates(nextMandates);
    setMandate(selectedMandate);
    setMandateAddress(selectedMandate?.address ?? legacyAddress);

    const mcpState = await Promise.allSettled([
      callMcpTool("get_mandate", { address: selectedMandate?.address ?? legacyAddress }),
    ]);
    if (mcpState[0]?.status === "fulfilled") {
      setMcpResult(mcpState[0].value);
    }

    const errors = [configState, toolsState, ...mandateStates]
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
    if (wallet) await loadWalletState(wallet, mandate?.address);
  }

  function selectMandate(nextMandate: Mandate) {
    setMandate(nextMandate);
    setMandateAddress(nextMandate.address);
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
        mandateAddress={mandate?.address}
        mandate={mandate}
        mandates={mandates}
        protocolConfig={protocolConfig}
        stablecoinOptions={buildStablecoinOptions(token2022Mint)}
        mcpTools={mcpTools}
        mcpResult={mcpResult}
        integrationStatus={integrationStatus}
        integrationError={integrationError}
        onRefresh={refreshMandate}
        onSelectMandate={selectMandate}
        onDisconnect={() => {
          setWalletConnection(null);
          setMandate(null);
          setMandates([]);
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
          <a href="#connectors">Connectors</a>
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
            <h1 className="hero-headline" aria-live="polite"><span key={heroMessage} className="hero-headline-transition">{heroMessage === "rail" ? <>The universal payment rail for <em>AI agents.</em></> : <>Give agents limits.<br /><em>Not your keys.</em></>}</span></h1>
            <p className="hero-text">One MCP endpoint for policy enforcement, wallet authorization, routing, stablecoin settlement, and receipts. Solana is the first settlement layer.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={connectWallet}>
                {connecting ? "Connecting…" : wallet ? `Connected ${shortAddress(wallet)}` : "Connect wallet"} <Arrow />
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
          <div className="use-case-grid">{useCases.map((useCase, index) => <article className="use-case-card" key={useCase.title}><span className="use-case-number">{String(index + 1).padStart(2, "0")}</span><h3>{useCase.title}</h3><p className="use-case-quote">{useCase.quote}</p><p>{useCase.detail}</p></article>)}</div>
        </section>

        <section className="market-section page-width" id="activity">
          <div className="section-heading"><div><span className="section-kicker">DEMO ACTIVITY</span><h2>Stay in control.</h2></div><span className="live-label"><i /> Example feed</span></div>
          <div className="market-table"><div className="table-head"><span>#</span><span>Activity</span><span>Amount</span><span>Status</span><span>Time</span><span /></div>{activity.map((item, index) => <div className="table-row" key={`${item[1]}-${item[4]}`}><span className="row-number">0{index + 1}</span><span className="activity-cell"><span className={`activity-avatar ${item[5]}`}>{item[5] === "settled" ? "↗" : item[5] === "verified" ? "✓" : item[5] === "policy" ? "✦" : "◆"}</span><span><b>{item[0]}</b><small>{item[1]}</small></span></span><strong>{item[2]}</strong><span className={`table-status ${item[5]}`}><i />{item[3]}</span><span className="row-time">{item[4]}</span><button className="row-arrow" aria-label={`Open ${item[0]}`}>→</button></div>)}</div>
        </section>

        <section className="proof-section page-width"><div className="proof-copy"><span className="section-kicker">WHY CHAINPAY</span><h2>Your money.<br /><em>Your rules.</em></h2><p>Give an agent a mandate with a clear token, limit, and expiry. Each payment names its own destination, and you keep the signing key.</p><a className="text-link" href="#how-it-works">Learn about mandates <Arrow /></a></div><div className="proof-stats"><div className="proof-stat"><strong>On-chain</strong><span>Policy enforcement</span></div><div className="proof-stat"><strong>Wallet</strong><span>Always approves signing</span></div><div className="proof-stat"><strong>One</strong><span>Receipt per settlement</span></div><div className="proof-stat"><strong>Devnet</strong><span>Start with a safe demo</span></div></div></section>

        <section className="steps-section page-width" id="how-it-works"><div className="section-heading centered"><span className="section-kicker">SIMPLE STEPS</span><h2>Start routing in minutes.</h2><p>From wallet connection to verified settlement, ChainPay keeps every step visible.</p></div><div className="steps-grid"><div className="step-card"><span className="step-number">01.</span><span className="step-icon">◈</span><h3>Connect wallet</h3><p>Connect your Solana wallet on Devnet. Your private key stays with you.</p></div><div className="step-card"><span className="step-number">02.</span><span className="step-icon">◇</span><h3>Create a mandate</h3><p>Choose a token, spend limit, and expiration for your agent.</p></div><div className="step-card"><span className="step-number">03.</span><span className="step-icon">✦</span><h3>Let agents request</h3><p>Agents supply one destination with each payment. ChainPay checks every request on-chain.</p></div><div className="step-card"><span className="step-number">04.</span><span className="step-icon">▤</span><h3>Verify settlement</h3><p>Successful payments create durable receipts for everyone to reconcile.</p></div></div></section>

        <section className="cta-section page-width" id="support"><span className="section-kicker">READY WHEN YOU ARE</span><h2>Give agents one payment interface.<br /><em>Keep the control.</em></h2><p>Create your first policy and connect a settlement rail on Solana Devnet.</p><button className="button button-light" onClick={connectWallet}>{wallet ? "Open mandate dashboard" : "Get started"} <Arrow /></button></section>
      </main>

      <footer className="footer page-width"><div className="footer-main"><div className="footer-brand"><a className="brand" href="#top"><span className="brand-mark"><span /></span><span>chain<span>pay</span></span></a><p>Solana Summer School bootcamp project building a policy-controlled payment rail for AI agents.</p><div className="footer-status"><i /> Solana Devnet</div></div><div className="footer-links"><div><b>PRODUCTS</b><a href="#products">Mandates</a><a href="#products">Payments</a><a href="#use-cases">Use cases</a><a href="#activity">Receipts</a></div><div><b>BUILD</b><a href="#how-it-works">How it works</a><a href="https://chainpay-mcp.onrender.com/docs" target="_blank" rel="noreferrer">MCP docs</a><a href="https://chainpay-mcp.onrender.com/tools" target="_blank" rel="noreferrer">MCP tools</a><a href="https://github.com/stawuah/chainpay-mcp-sdk" target="_blank" rel="noreferrer">GitHub repository</a></div><div><b>SOLANA</b><a href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noreferrer">Program on Explorer</a><a href="https://api.devnet.solana.com" target="_blank" rel="noreferrer">Devnet RPC</a><a href="https://chainpay-mcp.onrender.com/healthz" target="_blank" rel="noreferrer">MCP status</a></div></div><div className="newsletter"><b>Stay in the loop</b><p>Product updates, protocol news, and Devnet drops.</p><div className="email-box"><input placeholder="Your email" aria-label="Your email" /><button aria-label="Subscribe">→</button></div></div></div><div className="footer-bottom"><span>© 2026 ChainPay. Built on Solana.</span><span>Program <button className="copy-id" onClick={() => navigator.clipboard?.writeText(PROGRAM_ID)}><span className="mono">{shortAddress(PROGRAM_ID)}</span> ⧉</button></span></div></footer>
    </div>
  );
}

type DashboardProps = {
  wallet: string;
  walletName: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  mandateAddress?: string;
  mandate: Mandate | null;
  mandates: Mandate[];
  protocolConfig: ProtocolConfig | null;
  stablecoinOptions: StablecoinOption[];
  mcpTools: McpTool[];
  mcpResult: McpToolResponse | null;
  integrationStatus: "idle" | "loading" | "ready" | "error";
  integrationError: string;
  onRefresh: (preferredMandateAddress?: string) => Promise<void>;
  onSelectMandate: (mandate: Mandate) => void;
  onDisconnect: () => void;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
};

function Dashboard({
  wallet,
  walletName,
  walletSigner,
  mandateAddress,
  mandate,
  mandates,
  protocolConfig,
  stablecoinOptions,
  mcpTools,
  mcpResult,
  integrationStatus,
  integrationError,
  onRefresh,
  onSelectMandate,
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
  const [demoPaymentRequest, setDemoPaymentRequest] = useState<Record<string, unknown> | undefined>();
  const [agentInbox, setAgentInbox] = useState<AgentInboxItem[]>([]);
  const [agentAttachments, setAgentAttachments] = useState<AgentAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [approvalStatuses, setApprovalStatuses] = useState<Record<string, ApprovalStatus>>({});
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});

  const spent = mandate ? formatTokenAmount(mandate.amountSpent, mandateDecimals) : "—";

  useEffect(() => {
    setAgentInbox(wallet ? loadAgentInbox(wallet) : []);
    setAgentAttachments([]);
    setApprovalStatuses({});
    setApprovalErrors({});
  }, [wallet]);

  useEffect(() => {
    if (wallet) persistAgentInbox(wallet, agentInbox);
  }, [agentInbox, wallet]);

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

  function updateAgentInboxItem(id: string, patch: Partial<AgentInboxItem>) {
    setAgentInbox((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function prepareExplicitDemoPayment(request: Record<string, unknown>): Promise<AgentResponse> {
    const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
      ? request.payload as Record<string, unknown>
      : undefined;
    const mint = typeof payload?.mint === "string" ? payload.mint : "";
    const tokenProgram = payload?.tokenProgram === "token-2022" || payload?.tokenProgram === "spl-token" ? payload.tokenProgram : undefined;
    const recipient = typeof payload?.recipient === "string" ? payload.recipient : "";
    const amount = typeof payload?.amount === "string" ? payload.amount : "";
    if (!payload || !mint || !tokenProgram || !recipient || !/^\d+$/.test(amount) || !request.signature) {
      throw new Error("The signed demo request is incomplete and cannot be verified.");
    }

    const candidates = Array.from(new Map(
      (mandate ? [mandate, ...mandates] : mandates).map((candidate) => [candidate.address, candidate]),
    ).values()).filter((candidate) => (
      candidate.owner === wallet &&
      candidate.status === "active" &&
      candidate.allowedMint === mint &&
      candidate.tokenProgram === tokenProgram &&
      candidate.maxPerPayment >= BigInt(amount) &&
      candidate.amountSpent + BigInt(amount) <= candidate.totalLimit
    ));
    let selectedMandate: Mandate | undefined;
    for (const candidate of candidates) {
      if (await isPaymentMandateUsable(candidate)) {
        selectedMandate = candidate;
        break;
      }
    }
    if (!selectedMandate) {
      throw new Error("I found the request, but no active compatible USDC mandate is currently usable by this wallet.");
    }

    const verifiedResult = await onCallMcp("verify_payment_request", { request });
    const verified = verifiedResult.structuredContent as Record<string, unknown> | undefined;
    if (verifiedResult.isError || verified?.valid !== true) throw new Error(toolText(verifiedResult));
    const verifiedReferences = verified.references && typeof verified.references === "object" && !Array.isArray(verified.references)
      ? verified.references as Record<string, unknown>
      : verified;
    const invoiceHash = typeof verifiedReferences?.invoiceHash === "string" ? verifiedReferences.invoiceHash : "";
    const paymentId = typeof verifiedReferences?.paymentId === "string" ? verifiedReferences.paymentId : "";
    const signatureReference = typeof verifiedReferences?.signatureReference === "string" ? verifiedReferences.signatureReference : "";
    if (!invoiceHash || !paymentId || !signatureReference) throw new Error("The request was verified, but its payment references were incomplete.");

    const quoteResult = await onCallMcp("quote_payment_request", {
      request,
      mandate: selectedMandate.address,
      agent: selectedMandate.approvedAgent,
    });
    const quote = quoteResult.structuredContent as Record<string, unknown> | undefined;
    if (quoteResult.isError || quote?.requirements && typeof quote.requirements === "object" && (quote.requirements as { status?: unknown }).status !== "ready") {
      throw new Error(toolText(quoteResult));
    }

    const preparedResult = await onCallMcp("prepare_payment", {
      mandate: selectedMandate.address,
      agent: selectedMandate.approvedAgent,
      invoiceHash,
      paymentId,
      signatureReference,
      mint,
      recipient,
      amount,
      tokenProgram,
    });
    const prepared = preparedResult.structuredContent as Record<string, unknown> | undefined;
    if (preparedResult.isError || !prepared?.transaction || !prepared.payment) throw new Error(toolText(preparedResult));
    const requirements = prepared.requirements ?? quote?.requirements;
    return {
      message: "The signed request is verified and all five policy checks passed. The payment is prepared and waiting for your wallet approval in Phantom. It has not been submitted.",
      toolCalls: ["verify_payment_request", "quote_payment_request", "prepare_payment"],
      approval: { kind: "payment", ...prepared } as AgentApproval,
      outcome: { kind: "payment_approval_required", receiptAddress: typeof prepared.receiptAddress === "string" ? prepared.receiptAddress : undefined, status: "ready" },
      ...(requirements && typeof requirements === "object" ? { requirements: requirements as AgentRequirements } : {}),
    };
  }

  async function addAgentAttachments(files: FileList | File[]) {
    setAttachmentError("");
    try {
      const next = await Promise.all(Array.from(files).slice(0, 4).map(readAgentAttachment));
      setAgentAttachments((current) => [...current, ...next].slice(0, 4));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "The attachment could not be added.");
    }
  }

  function removeAgentAttachment(name: string) {
    setAgentAttachments((current) => current.filter((attachment) => attachment.name !== name));
  }

  async function askChainPay(input = prompt) {
    const query = input.trim();
    if (!query) return;
    const requestAttachments = [...agentAttachments];
    const inboxId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initialItem: AgentInboxItem = {
      id: inboxId,
      createdAt: new Date().toISOString(),
      source: inboxSource(query, requestAttachments),
      title: inboxTitle(query, requestAttachments),
      prompt: query,
      response: "AI is receiving the request…",
      stage: "received",
      toolCalls: [],
      attachments: requestAttachments.map(attachmentPreview),
    };
    setAgentInbox((current) => [initialItem, ...current].slice(0, 30));
    setAgentAttachments([]);
    setThinking(true);
    setReply("Thinking with ChainPay…");
    try {
      const attachedPaymentRequest = paymentRequestFromAttachments(requestAttachments);
      const parsedPayment = pastedPaymentDetails(query);
      const inlinePaymentRequest = paymentRequestFromPastedText(query) ?? paymentRequestFromMessage(query);
      const asksForFreshPaymentRequest = asksAgentToCreatePaymentRequest(query);
      let suppliedPaymentRequest = attachedPaymentRequest ?? inlinePaymentRequest ?? (asksForFreshPaymentRequest ? undefined : demoPaymentRequest);
      let createdDemoRequest = false;
      if (asksForFreshPaymentRequest && !suppliedPaymentRequest) {
        const requestArgs = demoPaymentRequestArguments(query);
        if (requestArgs) {
          const demoResult = await onCallMcp("create_demo_payment_request", requestArgs);
          const structured = demoResult.structuredContent as { request?: Record<string, unknown> } | undefined;
          if (demoResult.isError || !structured?.request) throw new Error(toolText(demoResult));
          suppliedPaymentRequest = structured.request;
          createdDemoRequest = true;
        }
      }
      const requestMandateAddress = parsedPayment?.mandate ?? mandateAddress;
      let result: AgentResponse;
      if (createdDemoRequest && suppliedPaymentRequest) {
        result = await prepareExplicitDemoPayment(suppliedPaymentRequest);
        result.toolCalls = ["create_demo_payment_request", ...(result.toolCalls ?? [])];
      } else if (asksForFreshPaymentRequest || suppliedPaymentRequest || requestAttachments.length > 0) {
        result = await callChainPayAgent(query, {
          wallet,
          mandateAddress: requestMandateAddress,
          history: assistantHistory,
          paymentRequest: suppliedPaymentRequest,
          attachments: requestAttachments,
        });
      } else if (parsedPayment) {
        result = pastedPaymentResponse(parsedPayment);
      } else {
        result = await callChainPayAgent(query, {
          wallet,
          mandateAddress: requestMandateAddress,
          history: assistantHistory,
          paymentRequest: suppliedPaymentRequest,
          attachments: requestAttachments,
        });
      }
      const nextReply = result.outcome?.kind === "payment_settled"
        ? `${result.message.trim() || "The payment settled successfully."}\n\nI'm done with the payment. Kindly go to ChainPay and verify the payment in Receipts.`
        : result.message.trim() || "ChainPay did not return a response.";
      setReply(nextReply);
      setAgentToolsUsed(result.toolCalls ?? []);
      updateAgentInboxItem(inboxId, {
        response: nextReply,
        stage: inboxStageForResult(result),
        toolCalls: result.toolCalls ?? [],
        ...(result.approval ? { approval: result.approval } : {}),
        ...(result.outcome ? { outcome: result.outcome } : {}),
        ...(result.requirements ? { requirements: result.requirements } : {}),
      });
      setAssistantHistory((current) => [
        ...current,
        { role: "user" as const, content: query },
        { role: "assistant" as const, content: nextReply },
      ].slice(-12));
    } catch (error) {
      // Keep the assistant useful while the server-side model is being configured.
      // This fallback is still read-only and makes the missing AI configuration visible.
      if (mandateAddress && /mandate|permission|policy/i.test(query)) try {
        const result = await onCallMcp("get_mandate", { address: mandateAddress });
        const fallback = toolText(result);
        setAgentToolsUsed(["get_mandate"]);
        const response = `AI agent unavailable: ${error instanceof Error ? error.message : "request failed"}\n\nDirect read-only MCP response:\n${fallback}`;
        setReply(response);
        updateAgentInboxItem(inboxId, { response, stage: "understood", toolCalls: ["get_mandate"] });
      } catch (fallbackError) {
        const failure = `AI agent unavailable: ${error instanceof Error ? error.message : "request failed"}\n\n${fallbackError instanceof Error ? fallbackError.message : "The read-only MCP request failed."}`;
        setReply(failure);
        setAgentToolsUsed([]);
        updateAgentInboxItem(inboxId, { response: failure, stage: "blocked", error: failure });
      } else {
        const failure = error instanceof Error ? error.message : "The ChainPay assistant request failed.";
        setReply(failure);
        setAgentToolsUsed([]);
        updateAgentInboxItem(inboxId, { response: failure, stage: "blocked", error: failure });
      }
    } finally {
      setThinking(false);
    }
  }

  async function loadDemoPaymentRequest() {
    const inboxId = `ai-demo-${Date.now()}`;
    const demoItem: AgentInboxItem = {
      id: inboxId,
      createdAt: new Date().toISOString(),
      source: "invoice",
      title: "Signed Devnet demo invoice",
      prompt: "Load a signed Devnet demo invoice",
      response: "AI is receiving the invoice…",
      stage: "received",
      toolCalls: [],
      attachments: [],
    };
    setAgentInbox((current) => [demoItem, ...current].slice(0, 30));
    setThinking(true);
    setReply("Creating a signed Devnet demo invoice…");
    try {
      const result = await onCallMcp("create_demo_payment_request", {});
      const structured = result.structuredContent as { request?: Record<string, unknown>; display?: { amount?: string; decimals?: number; token?: string; description?: string } } | undefined;
      if (result.isError || !structured?.request) throw new Error(toolText(result));
      setDemoPaymentRequest(structured.request);
      const display = structured.display;
      setPrompt("Verify and review this signed Devnet demo invoice");
      const response = `I loaded a valid signed demo invoice for ${display?.amount && display.decimals !== undefined ? formatTokenAmount(BigInt(display.amount), display.decimals) : "1"} ${display?.token ?? "token"}. I can verify the merchant request next.`;
      setReply(response);
      setAgentToolsUsed(["create_demo_payment_request"]);
      updateAgentInboxItem(inboxId, { response, stage: "understood", toolCalls: ["create_demo_payment_request"] });
    } catch (error) {
      const failure = error instanceof Error ? error.message : "I could not create the demo invoice.";
      setReply(failure);
      setAgentToolsUsed([]);
      updateAgentInboxItem(inboxId, { response: failure, stage: "blocked", error: failure });
    } finally {
      setThinking(false);
    }
  }

  async function approveAgentRequest(inboxId: string) {
    const inboxItem = agentInbox.find((item) => item.id === inboxId);
    const agentApproval = inboxItem?.approval;
    if (!agentApproval || !inboxItem) return;
    if (!walletSigner) {
      setApprovalStatuses((current) => ({ ...current, [inboxId]: "error" }));
      setApprovalErrors((current) => ({ ...current, [inboxId]: "The connected wallet does not expose transaction signing." }));
      return;
    }
    setApprovalStatuses((current) => ({ ...current, [inboxId]: "signing" }));
    setApprovalErrors((current) => ({ ...current, [inboxId]: "" }));
    updateAgentInboxItem(inboxId, { stage: "waiting_for_approval" });
    try {
      const prepared = preparedTransactionFromAgentApproval(agentApproval);
      const feePayer = prepared.feePayer ?? prepared.requiredSigners[0];
      if (feePayer !== wallet || !prepared.requiredSigners.includes(wallet)) {
        throw new Error("This approval is addressed to a different signer wallet.");
      }
      const simulation = await chainpayClient.simulate(prepared);
      if (!simulation.ok) throw new Error("The mandate approval checks could not be completed.");
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
      if (agentApproval.kind === "mandate") {
        const result = await submitSignedTransaction(`agent-mandate:${agentApproval.mandateAddress ?? latest.blockhash}:${latest.blockhash}`, signed.serialize());
        const response = `Mandate approved${result.signature ? ` (${shortAddress(result.signature)})` : ""}. The agent can now use this policy within the limits you approved without another wallet prompt.`;
        setApprovalStatuses((current) => ({ ...current, [inboxId]: "success" }));
        setReply(response);
        updateAgentInboxItem(inboxId, { response, stage: "approved", approval: undefined });
        await onRefresh(agentApproval.mandateAddress);
        if (result.signature) setAgentToolsUsed((current) => [...current, "wallet_approval"]);
      } else {
        if (!agentApproval.payment || typeof agentApproval.payment !== "object") {
          throw new Error("The prepared payment did not include its policy request details.");
        }
        const paymentResult = await onCallMcp("execute_payment", {
          ...(agentApproval.payment as Record<string, unknown>),
          signedTransaction: Buffer.from(signed.serialize()).toString("base64"),
        });
        const settled = paymentResult.structuredContent as { status?: string; signature?: string; error?: string; receiptAddress?: string } | undefined;
        if (paymentResult.isError || settled?.status === "failed") {
          throw new Error(settled?.error ?? toolText(paymentResult));
        }
        if (!settled?.signature) throw new Error("The backend did not return a transaction signature.");
        const response = `I'm done with the payment. The transaction is ${shortAddress(settled.signature)}. Kindly go to ChainPay and verify the payment in Receipts.`;
        setApprovalStatuses((current) => ({ ...current, [inboxId]: "success" }));
        setReply(response);
        updateAgentInboxItem(inboxId, { response, stage: "receipt_ready", approval: undefined, outcome: { kind: "payment_settled", signature: settled.signature, receiptAddress: settled.receiptAddress, status: settled.status } });
        setAgentToolsUsed((current) => [...current, "wallet_approval", "execute_payment"]);
        await onRefresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApprovalStatuses((current) => ({ ...current, [inboxId]: "error" }));
      setApprovalErrors((current) => ({ ...current, [inboxId]: message }));
      updateAgentInboxItem(inboxId, { stage: "waiting_for_approval", error: message });
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
    const activeMandates = mandates.filter((value) => value.status === "active" || value.status === "paused");
    if (!activeMandates.length) {
      setDangerStatus("There are no mandates for this wallet.");
      return;
    }
    if (!walletSigner) {
      setDangerStatus("The connected wallet does not expose transaction signing.");
      return;
    }
    try {
      const prepared: PreparedTransaction = {
        instructions: activeMandates.flatMap((value) => chainpayClient.buildRevokeMandate(wallet, value.address).instructions),
        requiredSigners: [wallet],
        feePayer: wallet,
      };
      const simulation = await chainpayClient.simulate(prepared);
      if (!simulation.ok) throw new Error("The mandate could not be updated. Review the policy details and try again.");
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
      await submitSignedTransaction(`revoke-all:${wallet}:${latest.blockhash}`, signed.serialize());
      await onRefresh();
      setDangerStatus("Active mandates revoked.");
    } catch (cause) {
      setDangerStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function runMandateAction(action: MandateAction, targetMandate: Mandate = mandate ?? mandates[0]) {
    if (!targetMandate) throw new Error("There is no mandate to update.");
    if (!walletSigner) throw new Error("The connected wallet does not expose transaction signing.");
    const prepared = action === "pause"
      ? chainpayClient.buildPauseMandate(wallet, targetMandate.address)
      : action === "revoke"
        ? chainpayClient.buildRevokeMandate(wallet, targetMandate.address)
        : chainpayClient.buildUpdateMandate({
          approvedAgent: targetMandate.approvedAgent,
          maxPerPayment: targetMandate.maxPerPayment,
          totalLimit: targetMandate.totalLimit,
          expiresAtSlot: targetMandate.expiresAtSlot,
          maxPaymentCount: targetMandate.maxPaymentCount,
          cooldownSlots: targetMandate.cooldownSlots,
          paused: false,
        }, wallet, targetMandate.address);
    const simulation = await chainpayClient.simulate(prepared);
    if (!simulation.ok) throw new Error(`The mandate ${action} could not be completed. Review the policy details and try again.`);
    const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
    const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
    await submitSignedTransaction(`${action}-mandate:${targetMandate.address}:${latest.blockhash}`, signed.serialize());
    await onRefresh(targetMandate.address);
  }

  const navItems: { id: DashboardTab; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "⌂" },
    { id: "mandates", label: "Mandates", icon: "◇" },
    { id: "payments", label: "Payments", icon: "↗" },
    { id: "agents", label: "Agents", icon: "⌁" },
    { id: "receipts", label: "Receipts", icon: "▤" },
    { id: "assistant", label: "AI inbox", icon: "◉" },
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
              <span>{item.label}</span>{item.id === "assistant" && agentInbox.some((entry) => entry.stage === "waiting_for_approval") && <b className="tool-count">{agentInbox.filter((entry) => entry.stage === "waiting_for_approval").length}</b>}
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
          <div className="dashboard-heading"><div><span className="section-kicker">{tab === "mandates" ? "POLICY CONTROL" : tab === "assistant" ? "AI ORCHESTRATION" : "CONTROL CENTER"}</span><h1 className="t-xl">{tab === "assistant" ? "AI inbox." : tab === "protocol" ? "Protocol setup." : tab === "mandates" ? "Mandates." : tab === "payments" ? "Route a payment." : tab === "agents" ? "Agents." : tab === "receipts" ? "Verify a receipt." : tab === "tools" ? "Tools." : tab === "connect-mcp" ? "Connect MCP." : tab === "settings" ? "Settings." : "Good to see you."}</h1><p>{tab === "assistant" ? "Bring an invoice or payment request here. The AI checks it against your mandate and leaves only the final wallet approval for you." : tab === "protocol" ? "Initialize the protocol asset list from the authority wallet." : tab === "mandates" ? (mandateCreateOpen ? "Create a policy for an agent to follow before a payment can be signed." : "Review the spending rules an agent must follow before a payment can be signed.") : tab === "payments" ? "Check the request, then approve the payment in your wallet." : tab === "agents" ? "Agents connected to ChainPay and the scopes they hold." : tab === "receipts" ? "Look up settlement proof from MCP." : tab === "tools" ? "The exact tools agents can call. Nothing else is exposed." : tab === "connect-mcp" ? "One MCP endpoint for policy enforcement, wallet authorization, routing, stablecoin settlement, and receipts. It never gets your wallet key." : tab === "settings" ? "Network, wallet, notifications, and account controls." : "Your agent permissions and settlement activity at a glance."}</p></div>{tab === "overview" || tab === "mandates" ? (mandateCreateOpen ? <button className="refresh-button btn btn-secondary-light" onClick={() => setMandateCreateOpen(false)}>← Back to mandates</button> : <button className="button button-primary overview-new-mandate" onClick={openMandateCreate}>＋ New mandate</button>) : <button className="refresh-button btn btn-secondary-light" onClick={() => void onRefresh()} disabled={integrationStatus === "loading"}>↻ Refresh</button>}</div>

          <div className="integration-strip"><span className={`connection-dot ${integrationStatus}`} /> <b>{integrationStatus === "loading" ? "Syncing" : integrationStatus === "error" ? "Needs attention" : "Connected"}</b><span>Network · Solana Devnet</span><span className="integration-divider" /><b>PAYMENT TOOLS</b><span>{mcpTools.length ? `${mcpTools.length} available` : "Loading"}</span><span className="integration-divider" /><b>AGENTS</b><span>{connections.length ? `${connections.length} connected` : "None connected"}</span>{integrationError && <small title={integrationError}>Check connection</small>}</div>

          <div>{tab === "assistant" ? <AssistantPanel prompt={prompt} setPrompt={setPrompt} reply={reply} thinking={thinking} listening={listening} agentToolsUsed={agentToolsUsed} inbox={agentInbox} approvalStatuses={approvalStatuses} approvalErrors={approvalErrors} attachments={agentAttachments} attachmentError={attachmentError} stablecoinOptions={stablecoinOptions} mandateDecimals={mandateDecimals} onAsk={() => void askChainPay()} onVoice={startVoice} onLoadDemoInvoice={() => void loadDemoPaymentRequest()} onApprove={approveAgentRequest} onAddAttachments={addAgentAttachments} onRemoveAttachment={removeAgentAttachment} onOpenReceipts={() => selectTab("receipts")} /> : tab === "protocol" ? <ProtocolPanel wallet={wallet} walletSigner={walletSigner} config={protocolConfig} onCreated={onRefresh} /> : tab === "mandates" ? <MandatesPanel wallet={wallet} walletSigner={walletSigner} mandates={mandates} mandate={mandate} mandateDecimals={mandateDecimals} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} createOpen={mandateCreateOpen} onCreateOpenChange={setMandateCreateOpen} onMandateAction={runMandateAction} onSelectMandate={onSelectMandate} onOpenPayments={() => selectTab("payments")} onRefresh={onRefresh} /> : tab === "payments" ? <PaymentPanel wallet={wallet} walletSigner={walletSigner} mandates={mandates} mandate={mandate} stablecoinOptions={stablecoinOptions} onSelectMandate={onSelectMandate} onCallMcp={onCallMcp} onAskAgent={(message) => void askChainPay(message)} onRefresh={onRefresh} /> : tab === "agents" ? <AgentsPanel connections={connections} onConnect={() => setTab("connect-mcp")} onOpenAssistant={() => setTab("assistant")} /> : tab === "receipts" ? <ReceiptPanel onCallMcp={onCallMcp} /> : tab === "tools" ? <ToolsPanel mcpTools={mcpTools} /> : tab === "connect-mcp" ? <ConnectMcpPanel serverUrl={MCP_URL} wallet={wallet} connections={connections} onConnected={(connection) => setConnections((current) => [connection, ...current])} onRevoked={async (id) => { await revokeMcpConnection(wallet, id); setConnections((current) => current.filter((connection) => connection.id !== id)); }} /> : tab === "settings" ? <SettingsPanel wallet={wallet} dangerStatus={dangerStatus} onRevokeAll={() => void revokeAllMandates()} onDisconnect={onDisconnect} /> : (
            <>
              <section className="dashboard-stat-grid"><div className="dashboard-stat"><span className="soft-label">ACTIVE MANDATES</span><strong>{mandates.filter((value) => value.status === "active").length}</strong><small>{mandates.length ? `${mandates.length} policy account${mandates.length === 1 ? "" : "s"} found on-chain` : "No mandates found for this wallet"}</small></div><div className="dashboard-stat"><span className="soft-label">SELECTED SPEND</span><strong>{spent}</strong><small>{mandateDecimals === null ? "Reading token decimals" : "Selected mandate · Devnet"}</small></div><div className="dashboard-stat"><span className="soft-label">PENDING PAYMENTS</span><strong>0</strong><small>Nothing waiting for approval</small></div><div className="dashboard-stat"><span className="soft-label">AGENTS CONNECTED</span><strong>{connections.length}</strong><small>{connections.length ? "Scoped MCP access" : "Connect an agent to begin"}</small></div></section>

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
  mandates,
  mandate,
  mandateDecimals,
  stablecoinOptions,
  protocolConfig,
  createOpen,
  onCreateOpenChange,
  onMandateAction,
  onSelectMandate,
  onOpenPayments,
  onRefresh,
}: {
  wallet: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  mandates: Mandate[];
  mandate: Mandate | null;
  mandateDecimals: number | null;
  stablecoinOptions: StablecoinOption[];
  protocolConfig: ProtocolConfig | null;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onMandateAction: (action: MandateAction, mandate: Mandate) => Promise<void>;
  onSelectMandate: (mandate: Mandate) => void;
  onOpenPayments: () => void;
  onRefresh: (preferredMandateAddress?: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | MandateTableStatus>("all");
  const [mandateSearch, setMandateSearch] = useState("");
  const [actionInFlight, setActionInFlight] = useState<MandateAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);
  const [decimalsByMint, setDecimalsByMint] = useState<Record<string, number>>({});
  const [expandedMandateAddress, setExpandedMandateAddress] = useState<string | null>(mandate?.address ?? null);
  const normalizedSearch = mandateSearch.trim().toLowerCase();
  const filteredMandates = mandates.filter((value) => {
    const statusMatches = filter === "all" || mandateTableStatus(value.status) === filter;
    const searchMatches = !normalizedSearch || [value.address, value.approvedAgent, value.allowedMint].some((field) => field.toLowerCase().includes(normalizedSearch));
    return statusMatches && searchMatches;
  });
  const visibleMandates = filteredMandates.slice(0, MAX_MANDATES_VISIBLE);
  const expandedMandate = expandedMandateAddress ? mandates.find((value) => value.address === expandedMandateAddress) ?? null : null;
  const expandedMandateStatus = expandedMandate ? mandateTableStatus(expandedMandate.status) : null;
  const expandedMandateAsset = expandedMandate ? stablecoinOptions.find((option) => option.mint === expandedMandate.allowedMint) : null;
  const expandedMandateDecimals = expandedMandate ? decimalsByMint[expandedMandate.allowedMint] : undefined;
  const expandedMandateExpiry = expandedMandate && currentSlot !== null && expandedMandate.expiresAtSlot <= currentSlot
    ? "Expired"
    : expandedMandate
      ? mandateExpiryDate(expandedMandate.expiresAtSlot, currentSlot) ?? `Slot ${expandedMandate.expiresAtSlot.toString()}`
      : "";

  useEffect(() => {
    if (mandate?.address) setExpandedMandateAddress(mandate.address);
  }, [mandate?.address]);

  useEffect(() => {
    let active = true;
    void chainpayClient.getCurrentSlot().then((slot) => {
      if (active) setCurrentSlot(slot);
    }).catch(() => {
      if (active) setCurrentSlot(null);
    });
    return () => { active = false; };
  }, [mandate?.address, createOpen]);

  useEffect(() => {
    let active = true;
    void Promise.all(mandates.map(async (value) => {
      try {
        return [value.allowedMint, await chainpayClient.getMintDecimals(value.allowedMint)] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (!active) return;
      setDecimalsByMint(Object.fromEntries(entries.filter((entry): entry is readonly [string, number] => entry !== null)));
    });
    return () => { active = false; };
  }, [mandates.map((value) => value.allowedMint).join(",")]);

  async function handleMandateAction(action: MandateAction, targetMandate: Mandate) {
    setActionError("");
    setActionInFlight(action);
    try {
      await onMandateAction(action, targetMandate);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionInFlight(null);
    }
  }

  function useMandateForPayment(targetMandate: Mandate) {
    if (targetMandate.status !== "active") {
      setActionError("Only an active mandate can be used for payment.");
      return;
    }
    onSelectMandate(targetMandate);
    onOpenPayments();
  }

  function copyExpandedMandateDetails() {
    if (!expandedMandate) return;
    const tokenName = expandedMandateAsset?.label ?? expandedMandate.allowedMint;
    const tokenProgram = expandedMandate.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token";
    const recipient = expandedMandate.legacyAllowedRecipient ?? "Chosen for each payment";
    copyValue([
      `Mandate: ${expandedMandate.address}`,
      `Status: ${expandedMandate.status}`,
      `Approved agent: ${expandedMandate.approvedAgent}`,
      `Owner: ${expandedMandate.owner}`,
      `Token: ${tokenName}`,
      `Token mint: ${expandedMandate.allowedMint}`,
      `Token program: ${tokenProgram}`,
      `Payment wallet: ${expandedMandate.sourceTokenAccount}`,
      `Recipient rule: ${recipient}`,
      `Maximum per payment: ${formatTokenAmount(expandedMandate.maxPerPayment, expandedMandateDecimals ?? null)}`,
      `Total spending limit: ${formatTokenAmount(expandedMandate.totalLimit, expandedMandateDecimals ?? null)}`,
      `Already spent: ${formatTokenAmount(expandedMandate.amountSpent, expandedMandateDecimals ?? null)}`,
      `Payments used: ${expandedMandate.paymentCount.toString()}${expandedMandate.maxPaymentCount === 0n ? " (no payment-count limit)" : ` of ${expandedMandate.maxPaymentCount.toString()}`}`,
      `Expires: ${expandedMandateExpiry}`,
    ].join("\n"));
  }

  const searchedMandate = normalizedSearch
    ? filteredMandates.find((value) => value.address.toLowerCase() === normalizedSearch)
      ?? (filteredMandates.length === 1 ? filteredMandates[0] : undefined)
    : undefined;

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
        <MandateBuilder wallet={wallet} walletSigner={walletSigner} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} onCreated={(address) => onRefresh(address)} onOpenPayments={onOpenPayments} />
      </section>
    );
  }

  return (
    <section className="mandates-panel" aria-labelledby="mandate-table-title">
      <div className="mandate-filter-controls"><div className="mandate-filter-bar" role="tablist" aria-label="Filter mandates">
        {["all", "active", "paused", "revoked"].map((value) => (
          <button
            className={`mandate-filter ${filter === value ? "is-selected" : ""}`}
            key={value}
            onClick={() => setFilter(value as "all" | MandateTableStatus)}
            role="tab"
            aria-selected={filter === value}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div><div className="mandate-search-group"><label className="mandate-search"><span className="sr-only">Search mandate, agent, or mint</span><input value={mandateSearch} onChange={(event) => setMandateSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && searchedMandate) useMandateForPayment(searchedMandate); }} placeholder="Search mandate ID…" aria-label="Search mandate ID" /><span>⌕</span></label>{searchedMandate && <button type="button" className="button button-secondary-light mandate-search-action" onClick={() => useMandateForPayment(searchedMandate)}>Pay with mandate <Arrow /></button>}</div></div>
      <div className="mandate-list-meta" aria-live="polite">
        <span>Showing {visibleMandates.length} of {filteredMandates.length} {filter === "all" ? "mandates" : `${filter} mandates`}</span>
        {filteredMandates.length > visibleMandates.length && <span>Showing the first {MAX_MANDATES_VISIBLE}. Use the filters to narrow the list.</span>}
        {normalizedSearch && filteredMandates.length === 0 && <span>No mandate matches “{mandateSearch}”.</span>}
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
              {visibleMandates.length ? visibleMandates.map((value) => {
                const status = mandateTableStatus(value.status);
                const selectedAsset = stablecoinOptions.find((option) => option.mint === value.allowedMint);
                const decimals = decimalsByMint[value.allowedMint];
                const progress = value.totalLimit > 0n ? Math.min(100, Number((value.amountSpent * 100n) / value.totalLimit)) : 0;
                const selected = mandate?.address === value.address;
                const expiry = mandateExpiryDate(value.expiresAtSlot, currentSlot);
                return (
                  <tr key={value.address} className={selected ? "is-selected" : undefined} onClick={() => { onSelectMandate(value); setExpandedMandateAddress(value.address); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectMandate(value); setExpandedMandateAddress(value.address); } }} tabIndex={0} aria-expanded={expandedMandateAddress === value.address}>
                    <td data-label="Agent">
                      <div className="mandate-agent-cell">
                        <span className="mandate-agent-avatar">{value.approvedAgent.slice(0, 2)}</span>
                        <span><strong>{mandateDisplayName(value, mandates, stablecoinOptions)}{selected ? " · Selected" : ""}</strong><small className="mono">Agent {shortAddress(value.approvedAgent)} · Mandate {shortAddress(value.address)}</small></span>
                      </div>
                    </td>
                    <td data-label="Date"><div className="mandate-date-cell"><strong>{mandateCreatedLabel(value)}</strong><small className="mono">{expiry ? `Expires ${expiry}` : `Expiry slot ${value.expiresAtSlot.toString()}`}</small></div></td>
                    <td data-label="Token type">
                      <div className="mandate-token-cell"><strong>{selectedAsset?.label ?? shortAddress(value.allowedMint)}</strong><small>{selectedAsset?.detail ?? (value.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token")}</small></div>
                    </td>
                    <td data-label="Amount" className="mandate-amount-cell">
                      <div className="mandate-amount-line"><strong>{decimals === undefined ? "—" : `$${formatTokenAmount(value.amountSpent, decimals)}`}</strong><span>/ {decimals === undefined ? "—" : `$${formatTokenAmount(value.totalLimit, decimals)}`}</span></div>
                      <div className="mandate-spend-bar" aria-label={`${progress}% of mandate spend used`}><span style={{ width: `${progress}%` }} /></div>
                    </td>
                    <td data-label="Status"><span className={`mandate-table-status ${status}`}><span className="mandate-status-check">✓</span>{mandateStatusLabel(status)}</span></td>
                    <td data-label="Actions" className="mandate-table-actions">
                      {status !== "revoked" ? <>
                        <button className="mandate-icon-button" onClick={(event) => { event.stopPropagation(); void handleMandateAction(status === "paused" ? "resume" : "pause", value); }} disabled={actionInFlight !== null} aria-label={status === "paused" ? "Resume mandate" : "Pause mandate"} title={status === "paused" ? "Resume mandate" : "Pause mandate"}>{actionInFlight === (status === "paused" ? "resume" : "pause") ? "…" : status === "paused" ? "▶" : "Ⅱ"}</button>
                        <button className="mandate-icon-button danger" onClick={(event) => { event.stopPropagation(); void handleMandateAction("revoke", value); }} disabled={actionInFlight !== null} aria-label="Revoke mandate" title="Revoke mandate">⌫</button>
                      </> : <span className="mandate-no-actions">—</span>}
                    </td>
                  </tr>
                );
              }) : (
                <tr className="mandate-empty-row"><td colSpan={6}><div className="mandate-empty-state"><span className="empty-icon">◇</span><strong>{mandates.length ? `No ${filter} mandates` : "No mandates yet"}</strong><p>{mandates.length ? "Try another status filter." : "Create a mandate to give an agent bounded spending authority."}</p><button className="button button-primary" onClick={() => onCreateOpenChange(true)}>＋ New mandate</button></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {expandedMandate && <article className="dashboard-card mandate-detail-card" aria-labelledby="mandate-detail-title">
        <div className="mandate-detail-heading">
          <div><span className="section-kicker">MANDATE DETAILS</span><h2 id="mandate-detail-title">{expandedMandateAsset?.label ?? "Selected mandate"}</h2><p>Review this policy and copy the details the AI needs before routing a payment.</p></div>
          <div className="mandate-detail-heading-actions"><span className={`mandate-table-status ${expandedMandateStatus}`}><span className="mandate-status-check">✓</span>{expandedMandate.status === "expired" ? "Expired" : mandateStatusLabel(expandedMandateStatus ?? "revoked")}</span><button type="button" className="btn-icon" onClick={() => setExpandedMandateAddress(null)} aria-label="Close mandate details" title="Close details">×</button></div>
        </div>
        <div className="mandate-detail-grid">
          <div><span>Mandate address</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.address)} title="Copy mandate address">{expandedMandate.address} ⧉</button></div>
          <div><span>Approved agent</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.approvedAgent)} title="Copy approved agent">{expandedMandate.approvedAgent} ⧉</button></div>
          <div><span>Owner</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.owner)} title="Copy owner address">{expandedMandate.owner} ⧉</button></div>
          <div><span>Token</span><strong>{expandedMandateAsset?.label ?? "Unknown token"}<small>{expandedMandateAsset?.detail ?? "Token mint"}</small></strong></div>
          <div><span>Token mint</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.allowedMint)} title="Copy token mint">{expandedMandate.allowedMint} ⧉</button></div>
          <div><span>Token type</span><strong>{expandedMandate.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token"}</strong></div>
          <div><span>Payment wallet</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.sourceTokenAccount)} title="Copy payment wallet">{expandedMandate.sourceTokenAccount} ⧉</button></div>
          <div><span>Recipient rule</span><strong>{expandedMandate.legacyAllowedRecipient ?? "Chosen for each payment"}<small>{expandedMandate.legacyAllowedRecipient ? "Fixed recipient" : "Provide the recipient token account with each payment"}</small></strong></div>
          <div><span>Maximum per payment</span><strong>{expandedMandateDecimals === undefined ? "Loading amount…" : formatTokenAmount(expandedMandate.maxPerPayment, expandedMandateDecimals)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Total spending limit</span><strong>{expandedMandateDecimals === undefined ? "Loading amount…" : formatTokenAmount(expandedMandate.totalLimit, expandedMandateDecimals)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Already spent</span><strong>{expandedMandateDecimals === undefined ? "Loading amount…" : formatTokenAmount(expandedMandate.amountSpent, expandedMandateDecimals)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Payment count</span><strong>{expandedMandate.paymentCount.toString()}{expandedMandate.maxPaymentCount === 0n ? " · No limit" : ` of ${expandedMandate.maxPaymentCount.toString()}`}</strong></div>
          <div><span>Expiry</span><strong>{expandedMandateExpiry}<small>Slot {expandedMandate.expiresAtSlot.toString()}</small></strong></div>
        </div>
        <div className="mandate-detail-actions">
          <button type="button" className="button button-secondary-light" onClick={copyExpandedMandateDetails}>Copy details for AI</button>
          {expandedMandate.status === "active" && <button type="button" className="button button-primary" onClick={() => useMandateForPayment(expandedMandate)}>Use this mandate for payment <Arrow /></button>}
          {expandedMandate.status === "paused" && <span className="mandate-detail-note">This mandate is paused. Resume it before using it for payment.</span>}
          {(expandedMandate.status === "revoked" || expandedMandate.status === "expired") && <span className="mandate-detail-note">This mandate cannot be used for new payments.</span>}
        </div>
      </article>}
      {actionError && <p className="mandate-action-error" role="alert">{actionError}</p>}
    </section>
  );
}

type PaymentPanelProps = {
  wallet: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  mandates: Mandate[];
  mandate: Mandate | null;
  stablecoinOptions: StablecoinOption[];
  onSelectMandate: (mandate: Mandate) => void;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
  onAskAgent: (message: string) => void;
  onRefresh: () => Promise<void>;
};

function PaymentPanel({ wallet, walletSigner, mandates, mandate, stablecoinOptions, onSelectMandate, onCallMcp, onAskAgent, onRefresh }: PaymentPanelProps) {
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
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const allPaymentMandates = mandates
    .filter((candidate) => candidate.status === "active")
    .sort((left, right) => stablecoinOrder(left.allowedMint, stablecoinOptions) - stablecoinOrder(right.allowedMint, stablecoinOptions));
  const paymentMandates = allPaymentMandates.slice(0, MAX_PAYMENT_MANDATES);
  const selectedPaymentMandate = paymentMandates.find((candidate) => candidate.address === mandate?.address) ?? paymentMandates[0] ?? null;
  const representedMints = new Set(allPaymentMandates.map((candidate) => candidate.allowedMint));

  useEffect(() => {
    if (selectedPaymentMandate && mandate?.address !== selectedPaymentMandate.address) {
      onSelectMandate(selectedPaymentMandate);
    }
  }, [mandate?.address, onSelectMandate, selectedPaymentMandate?.address]);

  useEffect(() => {
    if (selectedPaymentMandate) setAmount((current) => current || selectedPaymentMandate.maxPerPayment.toString());
  }, [selectedPaymentMandate]);

  useEffect(() => {
    setPrepared(null);
    setSimulation(null);
    setMcpPreflight("");
    setSignature("");
    setReceipt(null);
    setError("");
  }, [selectedPaymentMandate?.address]);

  useEffect(() => {
    let active = true;
    setMintDecimals(null);
    if (!selectedPaymentMandate) return () => { active = false; };
    void chainpayClient.getMintDecimals(selectedPaymentMandate.allowedMint).then((decimals) => {
      if (active) setMintDecimals(decimals);
    }).catch(() => {
      if (active) setMintDecimals(null);
    });
    return () => { active = false; };
  }, [selectedPaymentMandate?.allowedMint]);

  async function prepare() {
    if (!selectedPaymentMandate) {
      setError("Create an active mandate before preparing a payment.");
      setStatus("error");
      return;
    }
    setStatus("preparing");
    setError("");
    setPrepared(null);
    setSimulation(null);
    setSignature("");
    setReceipt(null);
    try {
      if (!recipient.trim()) throw new Error("Enter the recipient for this payment.");
      const [invoiceHash, paymentId, signatureReference] = await Promise.all([
        sha256Hex(`${invoice}:invoice`),
        sha256Hex(`${invoice}:payment`),
        sha256Hex(`${invoice}:signature`),
      ]);
      if (mintDecimals === null) throw new Error("Token decimals are not available yet. Refresh the mandate and try again.");
      const rawAmount = parseTokenAmount(amount, mintDecimals);
      const tokenProgram = selectedPaymentMandate.tokenProgram ?? await chainpayClient.getTokenProgram(selectedPaymentMandate.sourceTokenAccount);
      const sourceAccount = await getAccountInfoOrNull(new PublicKey(selectedPaymentMandate.sourceTokenAccount));
      const sourceAccountError = tokenAccountValidationError(
        sourceAccount,
        selectedPaymentMandate.allowedMint,
        selectedPaymentMandate.owner,
        tokenProgram,
      );
      if (sourceAccountError) throw new Error(`This mandate cannot pay: ${sourceAccountError}`);
      const delegatedTo = readTokenAccountDelegate(sourceAccount);
      if (delegatedTo !== selectedPaymentMandate.address || readTokenAccountDelegatedAmount(sourceAccount) <= 0n) {
        throw new Error("This mandate is active but is not currently delegated to its source account. Select the usable active mandate.");
      }
      let sourceBalance: string;
      try {
        const balance = await chainpayClient.connection.getTokenAccountBalance(
          new PublicKey(selectedPaymentMandate.sourceTokenAccount),
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
      const destination = await resolvePaymentDestination(recipient, selectedPaymentMandate.allowedMint, tokenProgram, wallet);
      const mcpArgs: Record<string, unknown> = {
        mandate: selectedPaymentMandate.address,
        agent: wallet,
        invoiceHash,
        paymentId,
        signatureReference,
        mint: selectedPaymentMandate.allowedMint,
        recipient: destination.address,
        amount: rawAmount.toString(),
        tokenProgram,
      };
      const mcpResult = await onCallMcp("prepare_payment", mcpArgs);
      setMcpPreflight(toolText(mcpResult));

      const nextPrepared = await chainpayClient.preparePayment({
        mandate: selectedPaymentMandate.address,
        invoiceHash: hexToBytes(invoiceHash),
        paymentId: hexToBytes(paymentId),
        signatureReference: hexToBytes(signatureReference),
        mint: selectedPaymentMandate.allowedMint,
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
        setError(failedChecks.join(" · ") || "The payment checks could not approve this payment.");
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
      try {
        setReceipt(await chainpayClient.getPayment(prepared.receiptAddress));
      } catch {
        // The backend waits for finalization. If this RPC read briefly lags,
        // still show the deterministic receipt address and transaction link.
        setReceipt(null);
      }
      setStatus("success");
      await onRefresh();
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function selectPaymentMandate(address: string) {
    const nextMandate = paymentMandates.find((candidate) => candidate.address === address);
    if (nextMandate?.status === "active") onSelectMandate(nextMandate);
  }

  if (!selectedPaymentMandate) {
    return <div className="dashboard-card flow-empty"><div className="empty-icon">↗</div><h2>No active mandate yet</h2><p>Create a mandate first. Payments can only be prepared after ChainPay has an on-chain policy to check.</p></div>;
  }

  return (
    <>
    <section className="payment-flow-layout">
      <div className="dashboard-card payment-form-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">PAYMENT REQUEST</span><h2>Prepare a policy-checked payment</h2></div><span className="mcp-badge"><span /> Payment safety checks</span></div>
        <p className="builder-intro">ChainPay checks the mandate, policy, and transaction before asking your wallet to approve this payment.</p>
        <div className="payment-mandate-picker">
          <div className="payment-mandate-picker-heading"><div><span className="soft-label">AVAILABLE MANDATES</span><strong>Choose the active policy the agent will use</strong></div><span className="payment-mandate-count">{paymentMandates.length}{allPaymentMandates.length > MAX_PAYMENT_MANDATES ? ` of ${allPaymentMandates.length}` : ""} active</span></div>
          {allPaymentMandates.length > MAX_PAYMENT_MANDATES && <p className="payment-mandate-limit">Payments show the first {MAX_PAYMENT_MANDATES} active mandates. Manage all mandates from the Mandates page.</p>}
          <div className="payment-mandate-options">
            {paymentMandates.map((candidate) => {
              const option = stablecoinOptions.find((item) => item.mint === candidate.allowedMint);
              const selected = candidate.address === selectedPaymentMandate.address;
              return <button type="button" className={`payment-mandate-option ${selected ? "is-selected" : ""}`} key={candidate.address} onClick={() => selectPaymentMandate(candidate.address)}>
                <span className="payment-mandate-token"><strong>{mandateDisplayName(candidate, mandates, stablecoinOptions)}</strong><small>{option?.detail ?? (candidate.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token")}</small></span>
                <span className="payment-mandate-details"><strong>{selected ? "Selected policy" : "Available policy"}</strong><small>Agent {shortAddress(candidate.approvedAgent)} · Mandate {shortAddress(candidate.address)}</small><small>Created {mandateCreatedLabel(candidate)}</small><small>{formatTokenAmount(candidate.maxPerPayment, mintDecimals)} per payment · {formatTokenAmount(candidate.totalLimit, mintDecimals)} total</small></span>
                <span className={`payment-mandate-status ${candidate.status}`}><i />{candidate.status}</span>
              </button>;
            })}
            {stablecoinOptions.filter((option) => option.mint && !representedMints.has(option.mint)).map((option) => <div className="payment-mandate-missing" key={`missing-${option.value}`}><strong>{option.label}</strong><span>{option.detail} · create a mandate first</span></div>)}
          </div>
        </div>
        <div className="builder-grid"><label className="field field-wide"><span>Invoice or payment reference</span><input value={invoice} onChange={(event) => { setInvoice(event.target.value); setPrepared(null); setSignature(""); }} placeholder="invoice-001" /></label><label className="field"><span>Amount <small>{mintDecimals === null ? "reading mint" : `${mintDecimals} decimals`}</small></span><input inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setPrepared(null); setSignature(""); }} placeholder="1.00" /></label><label className="field"><span>Agent signer</span><input value={wallet} readOnly /></label><label className="field field-wide"><span>Destination</span><input value={recipient} onChange={(event) => { setRecipient(event.target.value); setPrepared(null); setSignature(""); }} placeholder="Wallet or merchant address" /></label></div>
        <div className="payment-policy-note"><Shield /><span>Policy limit: <b>{formatTokenAmount(selectedPaymentMandate.maxPerPayment, mintDecimals)}</b> per payment · <b>{formatTokenAmount(selectedPaymentMandate.totalLimit, mintDecimals)}</b> total · {selectedPaymentMandate.status}</span></div>
        <div className="builder-actions"><button className="button button-primary" onClick={() => void prepare()} disabled={status === "preparing" || status === "signing"}>{status === "preparing" ? "Checking payment…" : "Prepare payment"} <Arrow /></button><span className="builder-safety"><Shield /> Wallet approval required to settle</span></div>
        {error && <div className="builder-error"><b>Payment blocked</b><span>{error}</span></div>}
        {signature && prepared && <>
          <div className="success-box"><span>✓</span><div><b>Payment confirmed on Devnet</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View settlement transaction <Arrow /></a></div></div>
          <div className="receipt-confirmation">
            <div className="receipt-confirmation-heading"><div><span className="soft-label">ON-CHAIN RECEIPT</span><h3>Settlement receipt</h3></div><span className="receipt-confirmed"><i /> Confirmed</span></div>
            <div className="receipt-confirmation-grid">
              <div><span>Receipt PDA</span><button className="receipt-address receipt-address-full" onClick={() => copyValue(prepared.receiptAddress)} title="Copy receipt PDA">{prepared.receiptAddress} ⧉</button></div>
              <div><span>Invoice</span><strong>{invoice}</strong></div>
              <div><span>Amount</span><strong>{formatTokenAmount(receipt?.amount ?? prepared.request.amount, mintDecimals)} {stablecoinOptions.find((option) => option.mint === prepared.request.mint)?.label ?? "tokens"}</strong></div>
              <div><span>Recipient token account</span><strong className="mono">{shortAddress(receipt?.recipientTokenAccount ?? prepared.request.recipient)}</strong></div>
              <div><span>Executed slot</span><strong>{receipt?.executedAtSlot?.toString() ?? "Finalized"}</strong></div>
            </div>
            <div className="receipt-confirmation-actions"><a href={`https://explorer.solana.com/address/${prepared.receiptAddress}?cluster=devnet`} target="_blank" rel="noreferrer">Open receipt account <Arrow /></a><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">Open transaction <Arrow /></a></div>
          </div>
        </>}
      </div>
      <div className="payment-review-stack"><div className="dashboard-card review-card"><div className="dashboard-card-heading"><div><span className="section-kicker">PAYMENT REVIEW</span><h2>{prepared ? "Payment review" : "Waiting for a request"}</h2></div><span className={`simulation-pill ${prepared?.preflight.valid && simulation?.ok ? "ok" : prepared ? "failed" : ""}`}><i /> {prepared ? (prepared.preflight.valid && simulation?.ok ? "Ready to approve" : "Needs attention") : "Waiting"}</span></div>{prepared ? <><div className="review-list payment-review-list"><div><span>Settlement amount</span><strong>{formatTokenAmount(prepared.request.amount, mintDecimals)} <small>({prepared.request.amount.toString()} base units)</small></strong></div><div><span>Stablecoin</span><strong>{stablecoinOptions.find((option) => option.mint === prepared.request.mint)?.label ?? shortAddress(prepared.request.mint)}</strong></div><div><span>Destination</span><strong className="mono">{shortAddress(prepared.request.recipient)}</strong></div><div><span>Signing wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div><div><span>Receipt</span><strong className="mono">{shortAddress(prepared.receiptAddress)}</strong></div></div><div className="check-list">{prepared.preflight.checks.map((check) => <div key={check.name} className={check.ok ? "check-row ok" : "check-row failed"}><span>{check.ok ? "✓" : "×"}</span><b>{check.name}</b><small>{check.message}</small></div>)}</div><div className="simulation-box payment-readiness-message"><span className="soft-label">{prepared.preflight.valid && simulation?.ok ? "PAYMENT READY" : "PAYMENT NEEDS ATTENTION"}</span><p>{prepared.preflight.valid && simulation?.ok ? "Everything looks good. Review the payment above, then approve it in your wallet to complete the settlement." : "We could not complete the payment checks. Review the issue above before trying again."}</p></div><details className="technical-details"><summary>View payment check details</summary><div className="simulation-box"><span className="soft-label">Policy response</span><pre>{mcpPreflight || "No policy response returned."}</pre></div><div className="simulation-box"><span className="soft-label">Transaction check details</span><pre>{simulation?.logs.length ? simulation.logs.join("\n") : simulation?.error ?? "No transaction check details returned."}</pre></div></details><div className="review-gate"><Shield /><span>Signing will request approval from <b>{wallet}</b>. Nothing is submitted until the wallet approves.</span></div><button className="button button-dark full-button" onClick={() => void signPayment()} disabled={!prepared.preflight.valid || !simulation?.ok || status === "signing"}>{status === "signing" ? "Waiting for wallet…" : "Approve payment"} <Arrow /></button></> : <div className="review-empty"><div className="empty-icon">↗</div><p>Enter an amount to review the policy checks and payment details before approving in your wallet.</p></div>}</div></div>
    </section>
    <BatchPaymentsPanel wallet={wallet} walletSigner={walletSigner} mandates={mandates} stablecoinOptions={stablecoinOptions} onAskAgent={onAskAgent} onRefresh={onRefresh} />
    </>
  );
}

const MAX_ATOMIC_BATCH_PAYMENTS = 4;

type BatchCsvPayment = {
  row: number;
  mandateAddress: string;
  invoice: string;
  amount: string;
  recipient: string;
  requiredToken?: string;
  receiptAddress?: string;
  tokenProgram?: TokenProgram;
};

type BatchPaymentEntry = {
  item: BatchCsvPayment;
  prepared?: PreparedPayment;
  status: "imported" | "ready" | "blocked" | "settled";
  error?: string;
};

type BatchPaymentsPanelProps = {
  wallet: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  mandates: Mandate[];
  stablecoinOptions: StablecoinOption[];
  onAskAgent: (message: string) => void;
  onRefresh: () => Promise<void>;
};

function parseCsvCells(value: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("The CSV has an unclosed quoted value.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeCsvHeader(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function importBatchPaymentsCsv(value: string): BatchCsvPayment[] {
  const rows = parseCsvCells(value);
  const [header, ...records] = rows;
  if (!header) throw new Error("The CSV is empty.");
  const headers = header.map(normalizeCsvHeader);
  const fieldIndex = (...names: string[]) => headers.findIndex((field) => names.includes(field));
  const required = {
    mandateAddress: fieldIndex("mandate_address", "mandate"),
    invoice: fieldIndex("invoice", "invoice_reference", "payment_reference"),
    amount: fieldIndex("amount"),
    recipient: fieldIndex("recipient", "recipient_address", "destination"),
  };
  const missing = Object.entries(required).filter(([, index]) => index < 0).map(([field]) => field);
  if (missing.length) throw new Error(`Add these required columns: ${missing.join(", ")}.`);
  if (records.length === 0) throw new Error("Add at least one payment row below the header.");
  if (records.length > MAX_ATOMIC_BATCH_PAYMENTS) {
    throw new Error(`An atomic batch can contain up to ${MAX_ATOMIC_BATCH_PAYMENTS} payments. Split this CSV into smaller batches.`);
  }

  const requiredTokenIndex = fieldIndex("required_token", "mint", "token_mint");
  const receiptAddressIndex = fieldIndex("receipt_address", "receipt", "receipt_pda");
  const tokenProgramIndex = fieldIndex("token_program");
  return records.map((record, index) => {
    const get = (field: number) => field >= 0 ? (record[field] ?? "").trim() : "";
    const item: BatchCsvPayment = {
      row: index + 2,
      mandateAddress: get(required.mandateAddress),
      invoice: get(required.invoice),
      amount: get(required.amount),
      recipient: get(required.recipient),
      ...(get(requiredTokenIndex) ? { requiredToken: get(requiredTokenIndex) } : {}),
      ...(get(receiptAddressIndex) ? { receiptAddress: get(receiptAddressIndex) } : {}),
    };
    const tokenProgram = get(tokenProgramIndex);
    if (tokenProgram) {
      if (tokenProgram !== "spl-token" && tokenProgram !== "token-2022") {
        throw new Error(`Row ${item.row}: token_program must be spl-token or token-2022.`);
      }
      item.tokenProgram = tokenProgram;
    }
    if (!item.mandateAddress || !item.invoice || !item.amount || !item.recipient) {
      throw new Error(`Row ${item.row}: mandate_address, invoice, amount, and recipient are all required.`);
    }
    return item;
  });
}

function downloadBatchPaymentsTemplate() {
  const csv = [
    "mandate_address,invoice,amount,recipient,required_token,receipt_address,token_program",
    "MANDATE_PDA,invoice-001,1.50,RECIPIENT_WALLET_OR_TOKEN_ACCOUNT,TOKEN_MINT,,spl-token",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "chainpay-batch-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function BatchPaymentsPanel({ wallet, walletSigner, mandates, stablecoinOptions, onAskAgent, onRefresh }: BatchPaymentsPanelProps) {
  const [items, setItems] = useState<BatchCsvPayment[]>([]);
  const [entries, setEntries] = useState<BatchPaymentEntry[]>([]);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "ready" | "signing" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const [batchPrepared, setBatchPrepared] = useState<PreparedTransaction | null>(null);
  const [batchSimulation, setBatchSimulation] = useState<SimulationResult | null>(null);
  const [signature, setSignature] = useState("");
  const [aiReviewRequested, setAiReviewRequested] = useState(false);

  async function importCsv(file?: File) {
    if (!file) return;
    setError("");
    setStatus("idle");
    setBatchPrepared(null);
    setBatchSimulation(null);
    setSignature("");
    setAiReviewRequested(false);
    try {
      if (file.size > 512_000) throw new Error("Keep the CSV below 500 KB.");
      const nextItems = importBatchPaymentsCsv(await file.text());
      setItems(nextItems);
      setEntries(nextItems.map((item) => ({ item, status: "imported" })));
      setFileName(file.name);
    } catch (cause) {
      setItems([]);
      setEntries([]);
      setFileName("");
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function askAiToReview() {
    if (!items.length) return;
    const summary = items.map((item) => [
      `CSV row ${item.row}`,
      `mandate ${item.mandateAddress}`,
      `invoice ${item.invoice}`,
      `amount ${item.amount}`,
      `recipient ${item.recipient}`,
      item.requiredToken ? `required token ${item.requiredToken}` : "required token from mandate",
      item.receiptAddress ? `receipt address ${item.receiptAddress}` : "receipt address will be derived",
    ].join(" · ")).join("\n");
    onAskAgent(`Review this imported ChainPay batch for policy and data risks. Do not submit or sign a payment. Explain any concerns clearly.\n\n${summary}`);
    setAiReviewRequested(true);
  }

  async function prepareBatch() {
    if (!items.length) return;
    setStatus("checking");
    setError("");
    setBatchPrepared(null);
    setBatchSimulation(null);
    setSignature("");
    const nextEntries: BatchPaymentEntry[] = [];
    const seenInvoices = new Set<string>();
    const seenRecipientAccounts = new Set<string>();

    for (const item of items) {
      try {
        const selectedMandate = mandates.find((candidate) => candidate.address === item.mandateAddress);
        if (!selectedMandate) throw new Error("Mandate is not available in this wallet.");
        if (selectedMandate.status !== "active") throw new Error(`Mandate is ${selectedMandate.status}.`);
        if (selectedMandate.approvedAgent !== wallet) throw new Error("This wallet is not the mandate's approved agent.");
        if (item.requiredToken && item.requiredToken !== selectedMandate.allowedMint) throw new Error("Required token does not match the mandate token.");
        const invoiceKey = `${selectedMandate.address}:${item.invoice}`;
        if (seenInvoices.has(invoiceKey)) throw new Error("Invoice must be unique within a mandate.");
        seenInvoices.add(invoiceKey);

        const [invoiceHash, paymentId, signatureReference] = await Promise.all([
          sha256Hex(`${item.invoice}:invoice`),
          sha256Hex(`${item.invoice}:payment`),
          sha256Hex(`${item.invoice}:signature`),
        ]);
        const decimals = await chainpayClient.getMintDecimals(selectedMandate.allowedMint);
        const amount = parseTokenAmount(item.amount, decimals);
        const tokenProgram = selectedMandate.tokenProgram ?? await chainpayClient.getTokenProgram(selectedMandate.sourceTokenAccount);
        if (item.tokenProgram && item.tokenProgram !== tokenProgram) throw new Error("Token program does not match the mandate source account.");

        const sourceAccount = await getAccountInfoOrNull(new PublicKey(selectedMandate.sourceTokenAccount));
        const sourceAccountError = tokenAccountValidationError(sourceAccount, selectedMandate.allowedMint, selectedMandate.owner, tokenProgram);
        if (sourceAccountError) throw new Error(`This mandate cannot pay: ${sourceAccountError}`);
        if (readTokenAccountDelegate(sourceAccount) !== selectedMandate.address || readTokenAccountDelegatedAmount(sourceAccount) <= 0n) {
          throw new Error("The mandate is not delegated to its payment token account.");
        }

        const destination = await resolvePaymentDestination(item.recipient, selectedMandate.allowedMint, tokenProgram, wallet);
        const prepared = await chainpayClient.preparePayment({
          mandate: selectedMandate.address,
          invoiceHash: hexToBytes(invoiceHash),
          paymentId: hexToBytes(paymentId),
          signatureReference: hexToBytes(signatureReference),
          mint: selectedMandate.allowedMint,
          recipient: destination.address,
          amount,
          tokenProgram,
        }, wallet);
        if (item.receiptAddress && item.receiptAddress !== prepared.receiptAddress) {
          throw new Error("Receipt address does not match the receipt derived from this mandate and invoice.");
        }
        if (destination.createInstruction && !seenRecipientAccounts.has(destination.address)) {
          prepared.transaction.instructions.unshift(destination.createInstruction);
          seenRecipientAccounts.add(destination.address);
        }
        const failedChecks = prepared.preflight.checks.filter((check) => !check.ok).map((check) => check.message);
        if (failedChecks.length) throw new Error(failedChecks.join(" · "));
        nextEntries.push({ item, prepared, status: "ready" });
      } catch (cause) {
        nextEntries.push({ item, status: "blocked", error: cause instanceof Error ? cause.message : String(cause) });
      }
    }

    const readyByMandate = new Map<string, BatchPaymentEntry[]>();
    for (const entry of nextEntries.filter((entry) => entry.status === "ready" && entry.prepared)) {
      const group = readyByMandate.get(entry.prepared!.mandate.address) ?? [];
      group.push(entry);
      readyByMandate.set(entry.prepared!.mandate.address, group);
    }
    for (const group of readyByMandate.values()) {
      const mandate = group[0].prepared!.mandate;
      const totalAmount = group.reduce((total, entry) => total + entry.prepared!.request.amount, 0n);
      let groupError = "";
      if (group.length > 1 && mandate.cooldownSlots > 0n) groupError = "This mandate has a cooldown and can only settle once per atomic batch.";
      if (!groupError && mandate.amountSpent + totalAmount > mandate.totalLimit) groupError = "Together, these payments exceed the mandate's total spending limit.";
      if (!groupError && mandate.maxPaymentCount > 0n && mandate.paymentCount + BigInt(group.length) > mandate.maxPaymentCount) groupError = "Together, these payments exceed the mandate's payment-count limit.";
      if (!groupError) {
        try {
          const balance = await chainpayClient.connection.getTokenAccountBalance(new PublicKey(mandate.sourceTokenAccount), "confirmed");
          if (BigInt(balance.value.amount) < totalAmount) groupError = "The mandate payment account does not have enough tokens for this batch.";
        } catch {
          groupError = "The mandate payment account could not be checked.";
        }
      }
      if (groupError) {
        for (const entry of group) {
          entry.status = "blocked";
          entry.error = groupError;
          delete entry.prepared;
        }
      }
    }

    setEntries(nextEntries);
    const readyEntries = nextEntries.filter((entry): entry is BatchPaymentEntry & { prepared: PreparedPayment } => entry.status === "ready" && Boolean(entry.prepared));
    if (readyEntries.length !== items.length) {
      setStatus("error");
      setError("Fix every blocked row before this batch can be approved. Nothing has been submitted.");
      return;
    }

    try {
      const transaction: PreparedTransaction = {
        feePayer: wallet,
        requiredSigners: [wallet],
        instructions: readyEntries.flatMap((entry) => entry.prepared.transaction.instructions),
      };
      const nextSimulation = await chainpayClient.simulate(transaction);
      setBatchSimulation(nextSimulation);
      if (!nextSimulation.ok) throw new Error("The combined transaction could not pass the on-chain checks. Split the CSV into smaller batches and try again.");
      const { blockhash } = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const serialized = toWeb3Transaction(transaction, blockhash).serialize({ requireAllSignatures: false, verifySignatures: false });
      if (serialized.length > 1_100) throw new Error("This combined transaction is too large. Split the CSV into smaller batches.");
      setBatchPrepared(transaction);
      setStatus("ready");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function approveAndSettleBatch() {
    if (!batchPrepared || !batchSimulation?.ok || !walletSigner) return;
    setStatus("signing");
    setError("");
    try {
      const { blockhash } = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await walletSigner(toWeb3Transaction(batchPrepared, blockhash));
      const batchFingerprint = await sha256Hex(items.map((item) => `${item.mandateAddress}:${item.invoice}`).join("|"));
      const result = await submitSignedTransaction(
        `batch:${wallet}:${batchFingerprint.slice(0, 24)}`,
        signed.serialize(),
      );
      if (result.status === "failed" || !result.signature) throw new Error(result.error ?? "The batch transaction was not confirmed.");
      setSignature(result.signature);
      setEntries((current) => current.map((entry) => entry.status === "ready" ? { ...entry, status: "settled" } : entry));
      setStatus("success");
      try {
        await onRefresh();
      } catch {
        // Settlement has already finalized. A later dashboard refresh must not change its result.
      }
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="dashboard-card batch-payments-panel" aria-labelledby="batch-payments-title">
      <div className="dashboard-card-heading">
        <div><span className="section-kicker">CSV BATCH SETTLEMENT</span><h2 id="batch-payments-title">Review once. Settle together.</h2></div>
        <span className={`simulation-pill ${status === "ready" || status === "success" ? "ok" : status === "error" ? "failed" : ""}`}><i /> {status === "checking" ? "Checking" : status === "ready" ? "Ready" : status === "signing" ? "Approving" : status === "success" ? "Settled" : "Import CSV"}</span>
      </div>
      <p className="builder-intro">Import up to {MAX_ATOMIC_BATCH_PAYMENTS} policy-backed payments. ChainPay checks every row, derives each receipt, and submits the valid batch as one atomic Solana transaction after one wallet approval.</p>
      <div className="batch-template-note"><span className="soft-label">CSV COLUMNS</span><code>mandate_address, invoice, amount, recipient, required_token, receipt_address, token_program</code><small>Only the first four columns are required. A supplied receipt address is verified against ChainPay’s derived receipt PDA.</small></div>
      <div className="batch-import-actions"><label className="batch-file-button"><input type="file" accept=".csv,text/csv" onChange={(event) => void importCsv(event.target.files?.[0])} />{fileName || "Choose CSV file"}</label><button type="button" className="button button-secondary-light button-small" onClick={downloadBatchPaymentsTemplate}>Download template</button></div>
      {error && <div className="builder-error"><b>Batch needs attention</b><span>{error}</span></div>}
      {entries.length > 0 && <>
        <div className="batch-list-meta"><span>{entries.length} of {MAX_ATOMIC_BATCH_PAYMENTS} payments imported</span><span>{entries.filter((entry) => entry.status === "ready" || entry.status === "settled").length} ready</span></div>
        <div className="batch-payment-list">
          {entries.map((entry) => {
            const token = entry.prepared?.request.mint ?? entry.item.requiredToken;
            const tokenLabel = stablecoinOptions.find((option) => option.mint === token)?.label;
            return <article className={`batch-payment-row ${entry.status}`} key={`${entry.item.row}-${entry.item.invoice}`}><span className="batch-row-number">{entry.item.row}</span><div><strong>{entry.item.invoice}</strong><small>Mandate {shortAddress(entry.item.mandateAddress)} · Recipient {shortAddress(entry.item.recipient)}</small></div><div><strong>{entry.item.amount}</strong><small>{tokenLabel ?? (token ? shortAddress(token) : "Mandate token")}</small></div><div className="batch-row-status"><span className={`simulation-pill ${entry.status === "ready" || entry.status === "settled" ? "ok" : entry.status === "blocked" ? "failed" : ""}`}><i /> {entry.status === "settled" ? "Settled" : entry.status === "ready" ? "Ready" : entry.status === "blocked" ? "Blocked" : "Imported"}</span>{entry.error && <small>{entry.error}</small>}</div></article>;
          })}
        </div>
        <div className="batch-actions"><button type="button" className="button button-secondary-light" onClick={askAiToReview} disabled={status === "checking" || status === "signing"}>{aiReviewRequested ? "AI review sent" : "Ask AI to review"}</button><button type="button" className="button button-primary" onClick={() => void prepareBatch()} disabled={status === "checking" || status === "signing"}>{status === "checking" ? "Checking batch…" : "Check batch"} <Arrow /></button></div>
      </>}
      {batchPrepared && <div className="batch-readiness"><Shield /><div><b>{batchSimulation?.ok ? "All rows passed the batch checks" : "Batch checks need attention"}</b><p>{batchPrepared.instructions.length} instructions will be signed and submitted together. If any instruction fails, the whole transaction is rejected.</p></div><button type="button" className="button button-dark" onClick={() => void approveAndSettleBatch()} disabled={status !== "ready" || !walletSigner}>{status === "signing" ? "Waiting for wallet…" : "Approve & settle batch"} <Arrow /></button></div>}
      {signature && <div className="batch-success"><div><span className="soft-label">BATCH SETTLED</span><b>{entries.length} payments confirmed in one transaction.</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">Open batch transaction <Arrow /></a></div><div className="batch-receipt-links">{entries.filter((entry) => entry.prepared).map((entry) => <a key={entry.item.row} href={`https://explorer.solana.com/address/${entry.prepared!.receiptAddress}?cluster=devnet`} target="_blank" rel="noreferrer">{entry.item.invoice} receipt <Arrow /></a>)}</div></div>}
    </section>
  );
}

function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function inlineAssistantText(value: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function assistantTableCells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function assistantMessageBlocks(value: string): ReactNode[] {
  const lines = value.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1]?.trim() ?? "";
    if (line.includes("|") && /^[\s|:-]+$/.test(nextLine) && nextLine.includes("|")) {
      const header = assistantTableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(assistantTableCells(lines[index]));
        index += 1;
      }
      blocks.push(<div className="assistant-table" key={`table-${index}`}>
        <div className="assistant-table-row assistant-table-header">{header.map((cell, cellIndex) => <span key={cellIndex}>{inlineAssistantText(cell)}</span>)}</div>
        {rows.map((row, rowIndex) => <div className="assistant-table-row" key={rowIndex}>{row.map((cell, cellIndex) => <span key={cellIndex}>{inlineAssistantText(cell)}</span>)}</div>)}
      </div>);
      continue;
    }

    if (/^(?:[-*])\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^(?:[-*])\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^(?:[-*])\s+/, ""));
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineAssistantText(item)}</li>)}</ul>);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineAssistantText(item)}</li>)}</ol>);
      continue;
    }

    const heading = line.match(/^#{1,3}\s+(.+)$/) ?? line.match(/^\*\*(.+)\*\*$/);
    if (heading) {
      blocks.push(<h3 key={`heading-${index}`}>{inlineAssistantText(heading[1])}</h3>);
      index += 1;
      continue;
    }

    blocks.push(<p key={`paragraph-${index}`}>{inlineAssistantText(line)}</p>);
    index += 1;
  }

  return blocks;
}

function AssistantMessage({ value, className = "" }: { value: string; className?: string }) {
  return <div className={`assistant-message ${className}`}>{assistantMessageBlocks(value)}</div>;
}

type VerifiedReceiptDetails = {
  address: string;
  mandate: string;
  invoiceHash: string;
  paymentId: string;
  mint: string;
  sourceTokenAccount: string;
  recipientTokenAccount: string;
  recipient?: string;
  amount: string;
  agent: string;
  executedAtSlot: string;
  signatureReference: string;
  status: string;
  onChainStatus: string;
  bump: string;
  transactionSignature?: string;
};

type SavedReceipt = VerifiedReceiptDetails & { savedAt: string };
const SAVED_RECEIPTS_STORAGE_KEY = "chainpay.saved-receipts.v1";

function parseReceiptRecord(value: unknown): VerifiedReceiptDetails | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  const requiredFields = [
    "address", "mandate", "invoiceHash", "paymentId", "mint", "sourceTokenAccount",
    "recipientTokenAccount", "amount", "agent", "executedAtSlot", "signatureReference", "status",
  ];
  if (requiredFields.some((field) => typeof receipt[field] !== "string")) return null;
  return {
      address: receipt.address as string,
      mandate: receipt.mandate as string,
      invoiceHash: receipt.invoiceHash as string,
      paymentId: receipt.paymentId as string,
      mint: receipt.mint as string,
      sourceTokenAccount: receipt.sourceTokenAccount as string,
      recipientTokenAccount: receipt.recipientTokenAccount as string,
      recipient: typeof receipt.recipient === "string" ? receipt.recipient : undefined,
      amount: receipt.amount as string,
      agent: receipt.agent as string,
      executedAtSlot: receipt.executedAtSlot as string,
      signatureReference: receipt.signatureReference as string,
      status: receipt.status as string,
      onChainStatus: String(receipt.onChainStatus ?? "—"),
      bump: String(receipt.bump ?? "—"),
      transactionSignature: typeof receipt.transactionSignature === "string" ? receipt.transactionSignature : undefined,
  };
}

function parseVerifiedReceipt(value: string): VerifiedReceiptDetails | null {
  try {
    const payload = JSON.parse(value) as { found?: unknown; receipt?: unknown };
    if (payload.found !== true) return null;
    return parseReceiptRecord(payload.receipt);
  } catch {
    return null;
  }
}

function loadSavedReceipts(): SavedReceipt[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(SAVED_RECEIPTS_STORAGE_KEY) ?? "null") as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const savedAt = (value as Record<string, unknown>).savedAt;
      const receipt = parseReceiptRecord(value);
      return receipt && typeof savedAt === "string" ? [{ ...receipt, savedAt }] : [];
    }).slice(0, 25);
  } catch {
    return [];
  }
}

function solscanAccountUrl(address: string) {
  return `https://solscan.io/account/${encodeURIComponent(address)}?cluster=devnet`;
}

function solscanTransactionUrl(signature: string) {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function receiptAmount(receipt: VerifiedReceiptDetails) {
  if (!/^\d+$/.test(receipt.amount)) return `${receipt.amount} base units`;
  try {
    const decimals = receipt.mint === DEVNET_PYUSD_TOKEN_2022_MINT ? 6 : null;
    return formatTokenAmount(BigInt(receipt.amount), decimals);
  } catch {
    return `${receipt.amount} base units`;
  }
}

function ReceiptAddressField({ label, value }: { label: string; value: string }) {
  return <div className="verified-receipt-field">
    <span>{label}</span>
    <div className="verified-receipt-address">
      <a href={solscanAccountUrl(value)} target="_blank" rel="noreferrer" title={`Open ${label} on Solscan`}>{value}</a>
      <button type="button" className="btn-icon" onClick={() => copyValue(value)} aria-label={`Copy ${label}`}>⧉</button>
    </div>
  </div>;
}

function VerifiedReceiptCard({ receipt, saved = false, onSave, onRemove }: { receipt: VerifiedReceiptDetails; saved?: boolean; onSave?: () => void; onRemove?: () => void }) {
  const tokenLabel = receipt.mint === DEVNET_PYUSD_TOKEN_2022_MINT ? "PYUSD" : shortAddress(receipt.mint);
  const recipient = receipt.recipientTokenAccount || receipt.recipient;
  return <div className="verified-receipt-card">
    <div className="verified-receipt-heading">
      <div><span className="soft-label">VERIFIED RECEIPT</span><h3>Settlement confirmed</h3></div>
      <span className="receipt-confirmed"><i /> {receipt.status}</span>
    </div>
    <div className="verified-receipt-summary">
      <div><span>Settlement amount</span><strong>{receiptAmount(receipt)} {tokenLabel}</strong><small>{receipt.amount} base units</small></div>
      <div><span>Network</span><strong>Solana Devnet</strong><small>On-chain status {receipt.onChainStatus}</small></div>
      <div><span>Executed slot</span><strong>{receipt.executedAtSlot}</strong><small>Receipt bump {receipt.bump}</small></div>
    </div>
    <div className="verified-receipt-fields">
      <ReceiptAddressField label="Receipt PDA" value={receipt.address} />
      <ReceiptAddressField label="Mandate" value={receipt.mandate} />
      <ReceiptAddressField label="PYUSD mint" value={receipt.mint} />
      <ReceiptAddressField label="Source token account" value={receipt.sourceTokenAccount} />
      {recipient && <ReceiptAddressField label="Recipient token account" value={recipient} />}
      <ReceiptAddressField label="Agent" value={receipt.agent} />
      <div className="verified-receipt-field verified-receipt-wide"><span>Invoice hash</span><strong>{receipt.invoiceHash}</strong><button type="button" className="btn-icon" onClick={() => copyValue(receipt.invoiceHash)} aria-label="Copy invoice hash">⧉</button></div>
      <div className="verified-receipt-field verified-receipt-wide"><span>Payment ID</span><strong>{receipt.paymentId}</strong><button type="button" className="btn-icon" onClick={() => copyValue(receipt.paymentId)} aria-label="Copy payment ID">⧉</button></div>
      <div className="verified-receipt-field verified-receipt-wide"><span>Signature reference</span><strong>{receipt.signatureReference}</strong><button type="button" className="btn-icon" onClick={() => copyValue(receipt.signatureReference)} aria-label="Copy signature reference">⧉</button></div>
    </div>
    <div className="verified-receipt-actions">
      {onSave && <button type="button" className="button button-primary button-small" onClick={onSave} disabled={saved}>{saved ? "Saved locally" : "Save receipt"}</button>}
      {onRemove && <button type="button" className="button button-secondary-light button-small" onClick={onRemove}>Remove saved receipt</button>}
      <a href={solscanAccountUrl(receipt.address)} target="_blank" rel="noreferrer">View receipt on Solscan <Arrow /></a>
      <a href={solscanAccountUrl(receipt.mandate)} target="_blank" rel="noreferrer">View mandate <Arrow /></a>
      {recipient && <a href={solscanAccountUrl(recipient)} target="_blank" rel="noreferrer">View recipient account <Arrow /></a>}
      <a href={solscanAccountUrl(receipt.mint)} target="_blank" rel="noreferrer">View PYUSD mint <Arrow /></a>
      {receipt.transactionSignature && <a href={solscanTransactionUrl(receipt.transactionSignature)} target="_blank" rel="noreferrer">View transaction <Arrow /></a>}
    </div>
  </div>;
}

function ReceiptPanel({ onCallMcp }: { onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse> }) {
  const [lookupMode, setLookupMode] = useState<"receipt" | "mandate">("receipt");
  const [receiptAddress, setReceiptAddress] = useState("");
  const [lookupMandate, setLookupMandate] = useState("");
  const [lookupInvoiceHash, setLookupInvoiceHash] = useState("");
  const [result, setResult] = useState("");
  const [verifiedReceipt, setVerifiedReceipt] = useState<VerifiedReceiptDetails | null>(null);
  const [savedReceipts, setSavedReceipts] = useState<SavedReceipt[]>(loadSavedReceipts);
  const [saveMessage, setSaveMessage] = useState("");
  const [loading, setLoading] = useState(false);

  function persistSavedReceipts(next: SavedReceipt[]) {
    try {
      window.localStorage.setItem(SAVED_RECEIPTS_STORAGE_KEY, JSON.stringify(next));
      setSavedReceipts(next);
      return true;
    } catch {
      setSaveMessage("This browser could not save the receipt locally.");
      return false;
    }
  }

  function saveReceipt(receipt: VerifiedReceiptDetails) {
    const next: SavedReceipt[] = [
      { ...receipt, savedAt: new Date().toISOString() },
      ...savedReceipts.filter((item) => item.address !== receipt.address),
    ].slice(0, 25);
    if (persistSavedReceipts(next)) setSaveMessage("Receipt saved to this browser.");
  }

  function removeSavedReceipt(address: string) {
    const next = savedReceipts.filter((item) => item.address !== address);
    if (persistSavedReceipts(next)) setSaveMessage("Receipt removed from saved receipts.");
  }

  async function lookup() {
    const args = lookupMode === "receipt"
      ? { receiptAddress: receiptAddress.trim() }
      : { mandate: lookupMandate.trim(), invoiceHash: lookupInvoiceHash.trim() };
    if (Object.values(args).some((value) => !value)) return;
    setLoading(true);
    try {
      const response = await onCallMcp("get_payment", args);
      const text = toolText(response);
      setResult(text);
      setVerifiedReceipt(parseVerifiedReceipt(text));
    } catch (cause) {
      setVerifiedReceipt(null);
      setResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return <section className="receipt-page">
    <div className="dashboard-card saved-receipts-card">
      <div className="dashboard-card-heading"><div><span className="section-kicker">SAVED RECEIPTS</span><h2>Your verified settlements</h2></div><span className="chip chip-muted">{savedReceipts.length} saved</span></div>
      {savedReceipts.length === 0 ? <p className="saved-receipts-empty">Verified receipts you save will appear here for quick access on this browser.</p> : <div className="saved-receipts-list">{savedReceipts.map((receipt) => <div className="saved-receipt-row" key={receipt.address}><div><strong>{receiptAmount(receipt)} {receipt.mint === DEVNET_PYUSD_TOKEN_2022_MINT ? "PYUSD" : shortAddress(receipt.mint)}</strong><small>{shortAddress(receipt.address)} · {receipt.status} · saved {new Date(receipt.savedAt).toLocaleString()}</small></div><div className="saved-receipt-row-actions"><a href={solscanAccountUrl(receipt.address)} target="_blank" rel="noreferrer">Solscan <Arrow /></a><button type="button" className="btn-icon" onClick={() => removeSavedReceipt(receipt.address)} aria-label={`Remove saved receipt ${receipt.address}`}>×</button></div></div>)}</div>}
      {saveMessage && <small className="saved-receipts-message">{saveMessage}</small>}
    </div>
    <div className="dashboard-card receipt-lookup"><div className="dashboard-card-heading"><div><span className="section-kicker">MCP RECEIPT LOOKUP</span><h2>Verify a settlement</h2></div><span className="mcp-badge"><span /> get_payment</span></div><p className="builder-intro">Look up a confirmed payment by receipt PDA, or use the mandate and invoice hash from the AI response. These lookups are read-only.</p><div className="receipt-lookup-tabs" role="tablist" aria-label="Receipt lookup type"><button type="button" className={lookupMode === "receipt" ? "is-selected" : ""} onClick={() => { setLookupMode("receipt"); setVerifiedReceipt(null); setResult(""); }} role="tab" aria-selected={lookupMode === "receipt"}>Receipt address</button><button type="button" className={lookupMode === "mandate" ? "is-selected" : ""} onClick={() => { setLookupMode("mandate"); setVerifiedReceipt(null); setResult(""); }} role="tab" aria-selected={lookupMode === "mandate"}>Mandate + invoice</button></div>{lookupMode === "receipt" ? <div className="receipt-search"><input value={receiptAddress} onChange={(event) => { setReceiptAddress(event.target.value); setVerifiedReceipt(null); setSaveMessage(""); }} onKeyDown={(event) => { if (event.key === "Enter") void lookup(); }} placeholder="Receipt PDA address" aria-label="Receipt PDA address" /><button className="button button-primary" onClick={() => void lookup()} disabled={loading || !receiptAddress.trim()}>{loading ? "Looking up…" : "Verify"} <Arrow /></button></div> : <div className="receipt-search receipt-search-grid"><input value={lookupMandate} onChange={(event) => { setLookupMandate(event.target.value); setVerifiedReceipt(null); setSaveMessage(""); }} placeholder="Mandate address" aria-label="Mandate address" /><input value={lookupInvoiceHash} onChange={(event) => { setLookupInvoiceHash(event.target.value); setVerifiedReceipt(null); setSaveMessage(""); }} onKeyDown={(event) => { if (event.key === "Enter") void lookup(); }} placeholder="64-character invoice hash" aria-label="Invoice hash" /><button className="button button-primary" onClick={() => void lookup()} disabled={loading || !lookupMandate.trim() || !lookupInvoiceHash.trim()}>{loading ? "Looking up…" : "Verify"} <Arrow /></button></div>}{verifiedReceipt && <VerifiedReceiptCard receipt={verifiedReceipt} saved={savedReceipts.some((item) => item.address === verifiedReceipt.address)} onSave={() => saveReceipt(verifiedReceipt)} onRemove={savedReceipts.some((item) => item.address === verifiedReceipt.address) ? () => removeSavedReceipt(verifiedReceipt.address) : undefined} />}{result && <details className="receipt-raw"><summary>View raw MCP response</summary><div className="simulation-box receipt-result"><pre>{result}</pre></div></details>}</div>
  </section>;
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
    {hasReply && <div className="overview-search-result"><span>{thinking ? "Searching…" : "Mandate result"}</span><AssistantMessage value={reply} className="overview-assistant-message" /></div>}
  </div>;
}

function AgentFlowRail({ stage }: { stage: AgentInboxStage }) {
  const current = agentStageIndex(stage);
  return <div className="agent-flow-rail" aria-label="AI payment flow">{agentFlowSteps.map((step, index) => <div className={`agent-flow-step ${index < current ? "complete" : index === current ? "current" : ""}`} key={step}><span>{String(index + 1).padStart(2, "0")}</span><b>{step}</b></div>)}</div>;
}

function AgentRequirementChecklist({ requirements }: { requirements: AgentRequirements }) {
  const statusLabel = requirements.status === "ready" ? "Ready for approval" : requirements.status === "blocked" ? "Blocked" : "Details needed";
  return <div className={`agent-requirement-checklist ${requirements.status}`}>
    <div className="agent-requirement-heading"><span className="soft-label">CHECKS BEFORE APPROVAL</span><span className="simulation-pill"><i /> {statusLabel}</span></div>
    <div className="agent-requirement-grid">{requirements.checks.map((check) => <div className={`agent-requirement-row ${check.status}`} key={check.key}><span>{check.status === "pass" ? "✓" : check.status === "fail" ? "×" : check.status === "missing" ? "!" : "·"}</span><div><b>{check.label}</b><small>{check.detail}</small></div></div>)}</div>
    {requirements.missing.length > 0 && <p className="agent-requirement-missing"><b>Please provide:</b> {requirements.missing.join(" · ")}</p>}
  </div>;
}

function AgentInboxPanel({ inbox, approvalStatuses, approvalErrors, stablecoinOptions, mandateDecimals, onApprove, onOpenReceipts }: { inbox: AgentInboxItem[]; approvalStatuses: Record<string, ApprovalStatus>; approvalErrors: Record<string, string>; stablecoinOptions: StablecoinOption[]; mandateDecimals: number | null; onApprove: (id: string) => Promise<void>; onOpenReceipts: () => void }) {
  const waitingCount = inbox.filter((item) => item.stage === "waiting_for_approval").length;
  const currentItem = inbox[0];
  const historyItems = inbox.slice(1, 12);
  const renderApproval = (item: AgentInboxItem) => item.approval && item.stage === "waiting_for_approval" && <AgentApprovalCard approval={item.approval} status={approvalStatuses[item.id] ?? "idle"} error={approvalErrors[item.id] ?? item.error ?? ""} stablecoinOptions={stablecoinOptions} decimals={mandateDecimals} onApprove={() => onApprove(item.id)} />;
  const renderReceipt = (item: AgentInboxItem) => item.stage === "receipt_ready" && <div className="agent-receipt-callout"><div><b>Payment complete</b><p>I'm done with the payment. Kindly go to ChainPay and verify the payment in Receipts.</p></div><button className="button button-secondary-light button-small" onClick={onOpenReceipts}>Verify payment <Arrow /></button></div>;
  const sourceLabel = (item: AgentInboxItem) => item.source === "invoice" ? "INVOICE / DOCUMENT" : item.source === "mandate" ? "MANDATE REQUEST" : "AI REQUEST";
  const statusLabel = (item: AgentInboxItem) => item.stage === "waiting_for_approval" ? "Approval needed" : item.stage === "receipt_ready" ? "Receipt ready" : item.stage === "approved" ? "Policy active" : item.stage === "blocked" ? "Blocked" : item.stage.replaceAll("_", " ");
  const statusClass = (item: AgentInboxItem) => item.stage === "receipt_ready" || item.stage === "approved" ? "ok" : item.stage === "blocked" ? "failed" : "";
  const renderHeader = (item: AgentInboxItem, current: boolean) => <div className="agent-inbox-item-heading"><div><span className="agent-inbox-source">{sourceLabel(item)}</span>{current && <span className="agent-current-label">CURRENT REQUEST</span>}<h3>{item.title}</h3></div><span className={`simulation-pill ${statusClass(item)}`}><i /> {statusLabel(item)}</span></div>;
  return <section className="agent-inbox-panel" aria-labelledby="agent-inbox-title">
    <div className="agent-inbox-heading"><div><span className="section-kicker">AI RECEIVED & PREPARED</span><h2 id="agent-inbox-title">Approval queue</h2></div><div className="agent-inbox-summary"><span className="chip chip-muted">{waitingCount} awaiting approval</span><span className="chip chip-muted">{inbox.length} received</span></div></div>
    {currentItem ? <div className="agent-inbox-list">
      <article className={`agent-inbox-item agent-current-item ${currentItem.stage}`}>
        {renderHeader(currentItem, true)}
        <small className="agent-inbox-time">{new Date(currentItem.createdAt).toLocaleString()}{currentItem.attachments.length ? ` · ${currentItem.attachments.length} attachment${currentItem.attachments.length === 1 ? "" : "s"}` : ""}</small>
        {currentItem.attachments.length > 0 && <div className="agent-attachment-previews">{currentItem.attachments.map((attachment) => <div className="agent-attachment-preview" key={attachment.name}>{attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <span className="agent-attachment-icon">{attachment.kind === "image" ? "▧" : "▤"}</span>}<span><b>{attachment.name}</b><small>{attachment.textPreview ?? (attachment.mimeType || "document")}</small></span></div>)}</div>}
        <AgentFlowRail stage={currentItem.stage} />
        {currentItem.requirements && <AgentRequirementChecklist requirements={currentItem.requirements} />}
        <AssistantMessage value={currentItem.response} className="agent-inbox-response" />
        {renderApproval(currentItem)}
        {renderReceipt(currentItem)}
      </article>
      {historyItems.length > 0 && <details className="agent-history"><summary><span><b>Recent requests</b><small>Older invoices, mandates, and receipts</small></span><span className="chip chip-muted">{historyItems.length}</span></summary><div className="agent-history-list">{historyItems.map((item) => <article className={`agent-inbox-item agent-history-item ${item.stage}`} key={item.id}>
        {renderHeader(item, false)}
        <small className="agent-inbox-time">{new Date(item.createdAt).toLocaleString()}{item.attachments.length ? ` · ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}` : ""}</small>
        <AssistantMessage value={item.response} className="agent-inbox-response" />
        {renderApproval(item)}
        {renderReceipt(item)}
      </article>)}</div></details>}
    </div> : <div className="agent-inbox-empty"><span className="empty-icon">◎</span><p>AI-created mandates, invoices, and payment requests will appear here before anything reaches the wallet.</p></div>}
  </section>;
}

function AssistantPanel({ prompt, setPrompt, reply, thinking, listening, agentToolsUsed, inbox, approvalStatuses, approvalErrors, attachments, attachmentError, stablecoinOptions, mandateDecimals, onAsk, onVoice, onLoadDemoInvoice, onApprove, onAddAttachments, onRemoveAttachment, onOpenReceipts }: { prompt: string; setPrompt: (value: string) => void; reply: string; thinking: boolean; listening: boolean; agentToolsUsed: string[]; inbox: AgentInboxItem[]; approvalStatuses: Record<string, ApprovalStatus>; approvalErrors: Record<string, string>; attachments: AgentAttachment[]; attachmentError: string; stablecoinOptions: StablecoinOption[]; mandateDecimals: number | null; onAsk: () => void; onVoice: () => void; onLoadDemoInvoice: () => void; onApprove: (id: string) => Promise<void>; onAddAttachments: (files: FileList | File[]) => Promise<void>; onRemoveAttachment: (name: string) => void; onOpenReceipts: () => void }) {
  return <section className="assistant-layout"><div className="assistant-card dashboard-card"><div className="assistant-visual"><span className="assistant-caption">{listening ? "Listening…" : thinking ? "ChainPay agent is thinking…" : "ChainPay agent"}</span><span className="overview-agent-state"><i /> Online</span></div><div className="assistant-flow-intro"><span className="section-kicker">WALLET CONTROL</span><h2>AI prepares the payment.</h2><p>Paste an invoice or describe the payment in plain language. ChainPay verifies it, checks your mandate, prepares the transaction, and leaves approval with you.</p><AgentFlowRail stage={inbox[0]?.stage ?? "received"} /><div className="assistant-guardrails"><span className="soft-label">CHECKS BEFORE APPROVAL</span><div><span>Limits</span><span>Token</span><span>Recipient</span><span>Expiry</span><span>Policy</span></div></div></div><div className="assistant-log"><span className="soft-label">LIVE RESPONSE</span><AssistantMessage value={reply} className="assistant-response" />{agentToolsUsed.length > 0 && <div className="assistant-tools-used"><span className="soft-label">TOOLS USED</span>{agentToolsUsed.map((tool, index) => <span className="tool-call-chip" key={`${tool}-${index}`}>{tool}</span>)}</div>}</div><div className="assistant-attachments">{attachments.map((attachment) => <span className="assistant-attachment-chip" key={attachment.name}><span>{attachment.kind === "image" ? "▧" : "▤"} {attachment.name}</span><button type="button" onClick={() => onRemoveAttachment(attachment.name)} aria-label={`Remove ${attachment.name}`}>×</button></span>)}</div>{attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}<div className="assistant-input"><input value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onAsk(); }} aria-label="Ask ChainPay" placeholder="Ask about a mandate, invoice, or payment" /><label className="attachment-button" title="Attach an image or invoice"><input type="file" accept="image/*,.pdf,.csv,.json,.txt,.md" multiple onChange={(event) => { if (event.target.files) void onAddAttachments(event.target.files); event.currentTarget.value = ""; }} />＋ Attach</label><button className={listening ? "voice-button listening" : "voice-button"} onClick={onVoice} aria-label={listening ? "Stop voice input" : "Use voice input"}>{listening ? "■" : "●"}</button><button className="button button-primary ask-button" onClick={onAsk} disabled={thinking}>Ask <Arrow /></button></div><small className="assistant-note">The AI can receive images and invoice text, prepare mandates, check policy, and route payments. Your wallet stays in control and ChainPay never receives your private key.</small><AgentInboxPanel inbox={inbox} approvalStatuses={approvalStatuses} approvalErrors={approvalErrors} stablecoinOptions={stablecoinOptions} mandateDecimals={mandateDecimals} onApprove={onApprove} onOpenReceipts={onOpenReceipts} /></div><div className="assistant-side"><div className="dashboard-card"><span className="section-kicker">DEMO PAYMENT</span><h2>Test the complete flow.</h2><p>Create a fresh signed Devnet request, then send it through verification and wallet approval.</p><button className="button button-dark full-button" onClick={onLoadDemoInvoice} disabled={thinking}>{thinking ? "Preparing demo…" : "Create signed demo request"}</button></div><div className="dashboard-card"><span className="section-kicker">VOICE INPUT</span><h2>Give your agent a voice.</h2><p>Speak naturally. ChainPay verifies the request and shows any wallet approval before an action can continue.</p><button className="button button-secondary-light full-button" onClick={onVoice}>{listening ? "Stop listening" : "Start voice command"}</button></div><div className="dashboard-card safety-card"><Shield /><div><b>Safe by default</b><p>Payment execution stays behind the approved mandate and signer boundary.</p></div></div></div></section>;
}

function AgentApprovalCard({ approval, status, error, stablecoinOptions, decimals, onApprove }: { approval: AgentApproval; status: ApprovalStatus; error: string; stablecoinOptions: StablecoinOption[]; decimals: number | null; onApprove: () => Promise<void> }) {
  const instructionNames = approval.transaction?.instructions?.map((instruction) => instruction.name).join(" + ") || "mandate transaction";
  const isPayment = approval.kind === "payment";
  const payment = approval.payment;
  const amount = typeof payment?.amount === "string" ? payment.amount : undefined;
  const tokenMint = typeof payment?.mint === "string" ? payment.mint : undefined;
  const tokenLabel = stablecoinOptions.find((option) => option.mint === tokenMint)?.label ?? "token";
  let displayAmount = "See wallet";
  if (amount) {
    try {
      displayAmount = decimals === null
        ? `${amount} base units`
        : `${formatTokenAmount(BigInt(amount), decimals)} ${tokenLabel}`;
    } catch {
      displayAmount = `${amount} base units`;
    }
  }
  return <div className="agent-approval-card"><div className="agent-approval-heading"><div><span className="section-kicker">WALLET APPROVAL</span><h3>{isPayment ? "Approve payment" : "Approve this mandate once"}</h3></div><span className={`simulation-pill ${status === "error" ? "failed" : status === "success" ? "ok" : ""}`}><i /> {status === "signing" ? "Waiting" : status === "success" ? "Approved" : status === "error" ? "Needs attention" : "Ready"}</span></div><p>{isPayment ? "Review the amount, recipient, and policy checks below. Approve in your wallet to complete the payment." : "The AI prepared this spending policy. Approve it once; future policy-compliant payments can settle without another wallet prompt."}</p><div className="agent-approval-details">{isPayment ? <><span><b>Amount</b><code>{displayAmount}</code></span><span><b>Recipient</b>{typeof payment?.recipient === "string" ? <code>{shortAddress(payment.recipient)}</code> : "See wallet"}</span><span><b>Receipt</b>{approval.receiptAddress && typeof approval.receiptAddress === "string" ? <code>{shortAddress(approval.receiptAddress)}</code> : "Prepared"}</span></> : <><span><b>Mandate</b>{approval.mandateAddress ? <code>{shortAddress(approval.mandateAddress)}</code> : "New policy"}</span><span><b>Instructions</b>{instructionNames}</span><span><b>Wallet</b>{approval.transaction?.feePayer ? <code>{shortAddress(approval.transaction.feePayer)}</code> : "Connected owner"}</span></>}</div>{error && <div className="builder-error"><b>Approval blocked</b><span>{error}</span></div>}<button className="button button-dark full-button" onClick={() => void onApprove()} disabled={status === "signing" || status === "success"}>{status === "signing" ? "Waiting for wallet…" : status === "success" ? "Approved" : isPayment ? "Approve payment in wallet" : "Approve wallet once"} <Arrow /></button></div>;
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

const aiConnectionSteps = [
  { number: "01", title: "Connect one endpoint", detail: "Give the AI one MCP URL for policy, wallet authorization, routing, settlement, and receipts." },
  { number: "02", title: "Read the invoice", detail: "An invoice connector supplies the PNG or QR context and turns it into a structured payment request." },
  { number: "03", title: "Verify + quote", detail: "The AI calls verify_payment_request, then quote_payment. Fixed and variable pricing stay explicit." },
  { number: "04", title: "Sign once", detail: "Your wallet authorizes the mandate and its limits. The AI never receives a private key or passphrase." },
  { number: "05", title: "Settle + receipt", detail: "After approval, execute_payment relays the transaction and get_payment returns the receipt and Explorer link." },
];

function AiConnectionFlow() {
  return <div className="dashboard-card ai-connection-flow">
    <div className="dashboard-card-heading"><div><span className="section-kicker">AI PAYMENT FLOW</span><h2>Sign once. Let the AI coordinate.</h2></div><span className="chip chip-blue">Solana first</span></div>
    <p className="builder-intro">One MCP endpoint makes the payment path visible to the AI while your wallet stays the approval boundary.</p>
    <div className="ai-connection-steps">{aiConnectionSteps.map((step) => <div className="ai-connection-step" key={step.number}><span className="ai-connection-step-number">{step.number}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></div>)}</div>
    <div className="ai-visible-context"><span className="soft-label">AI SEES</span><div><span>merchant</span><span>amount + pricing</span><span>mint + recipient</span><span>mandate limits</span><span>receipt + Explorer</span></div></div>
    <div className="connection-safety-note"><Shield /><span>Current browser payments still request an explicit wallet signature for each settlement. Autonomous signing requires a separate approved-agent signer; no private key belongs in the AI connection.</span></div>
  </div>;
}

function ConnectMcpPanel({ serverUrl, wallet, connections, onConnected, onRevoked }: { serverUrl: string; wallet: string; connections: AgentConnection[]; onConnected: (connection: AgentConnection) => void; onRevoked: (id: string) => Promise<void> }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [scope, setScope] = useState("Unscoped");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [connectionToken, setConnectionToken] = useState("");
  const [configCopied, setConfigCopied] = useState(false);
  const config = buildMcpClientConfig(serverUrl, connectionToken || undefined);

  function copyConfig() {
    copyValue(config);
    setConfigCopied(true);
    window.setTimeout(() => setConfigCopied(false), 2200);
  }

  async function createConnection() {
    if (!agentName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const createdAgentName = agentName.trim();
      const result = await registerMcpConnection(wallet, createdAgentName, scope);
      onConnected({ ...result.connection, mandates: result.connection.scope === "Current mandate" ? 1 : 0 });
      setConnectionId(result.connection.id);
      setConnectionName(createdAgentName);
      setConnectionToken(result.token);
      setConfigCopied(false);
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
    <AiConnectionFlow />
    <div className="dashboard-card connection-config-card"><div className="dashboard-card-heading"><div><span className="section-kicker">CONNECTION CONFIG</span><h2>One MCP endpoint</h2></div><span className="mcp-badge"><span /> MCP · Devnet</span></div><p className="builder-intro">Copy the endpoint into any MCP-compatible AI. Create a named connection to issue a private bearer token and let the AI discover the full ChainPay payment flow.</p><div className="copy-row"><span className="mono">{serverUrl}</span><button className="btn-icon" onClick={() => copyValue(serverUrl)} aria-label="Copy server URL">⧉</button></div>{connectionToken && <div className="token-once"><div className="token-once-heading"><span className="status-pill"><i /> Connection ready</span><span className="chip chip-blue">{connectionName}</span></div><p>Copy the secure config now. The bearer token authenticates this client; the on-chain mandate still enforces mint, amount, recipient, expiry, and total limits.</p></div>}<div className="config-code-wrap"><button className="button button-secondary-light copy-config" onClick={copyConfig}>{configCopied ? "Copied" : connectionToken ? "Copy secure config" : "Copy config"}</button><pre className="schema-block">{config}</pre></div></div>
    <div className="dashboard-card connected-clients-card"><div className="dashboard-card-heading"><div><span className="section-kicker">CONNECTED CLIENTS</span><h2>Agent connections</h2></div><button className="button button-primary" onClick={() => setDialogOpen(true)}>New connection <Arrow /></button></div>{connections.length ? <div className="connection-list">{connections.map((connection) => <div className="connection-row" key={connection.id}><div><strong>{connection.agentName}</strong><small className="mono">Owner · {shortAddress(connection.wallet)}</small></div><span className="chip chip-muted">{connection.scope}</span><span className="t-body-sm">{connectionSeenLabel(connection.lastSeenAt)}</span><button className="btn-icon" onClick={() => setRevokeId(connection.id)} aria-label={`Revoke ${connection.agentName}`}>×</button><div className="connection-tools">{connection.toolsCalled.length ? connection.toolsCalled.map((tool) => <span className="tool-call-chip" key={tool.name}>{tool.name} <b>×{tool.count}</b></span>) : <span>No tools called yet.</span>}</div></div>)}</div> : <div className="page-empty compact-empty"><p>No agents connected yet.</p><button className="button button-primary" onClick={() => setDialogOpen(true)}>New connection <Arrow /></button></div>}</div>
    {dialogOpen && <div className="app-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialogOpen(false); }}><div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title"><div className="app-dialog-heading"><span className="section-kicker">NEW CONNECTION</span><h2 id="connection-dialog-title">Pair an agent</h2></div><p>Give this client one endpoint and a private bearer token. It can coordinate policy checks and payment requests, but it never receives your wallet key.</p><label className="field"><span>Agent name</span><input autoFocus value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Invoice agent" /></label><label className="field"><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option>Unscoped</option><option disabled={!connections.length}>Current mandate{connections.length ? "" : " · create a connection first"}</option></select></label>{error && <p className="builder-error"><b>Connection failed</b><span>{error}</span></p>}<div className="app-dialog-actions"><button className="button button-secondary-light" onClick={() => setDialogOpen(false)}>Cancel</button><button className="button button-primary" onClick={() => void createConnection()} disabled={!agentName.trim() || creating}>{creating ? "Creating…" : "Create connection"} <Arrow /></button></div></div></div>}
    <ConfirmDialog open={Boolean(revokeId)} title="Revoke this connection?" description="This agent will no longer be able to call ChainPay tools with this connection." confirmLabel="Revoke connection" onClose={() => setRevokeId(null)} onConfirm={() => { const id = revokeId; setRevokeId(null); if (id) void onRevoked(id).then(() => { if (id === connectionId) { setConnectionId(""); setConnectionName(""); setConnectionToken(""); } }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} />
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
      if (!nextSimulation.ok) setError("The protocol setup checks could not approve this change.");
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
        {config ? <div className="protocol-authority"><span>Authority</span><strong className="mono">{shortAddress(config.authority)}</strong><small>{isAuthority ? "Connected wallet can manage this config." : "Connect the authority wallet to manage this config."}</small></div> : <div className="builder-actions"><button className="button button-primary" onClick={() => void buildPreview()} disabled={status === "building" || status === "signing"}>{status === "building" ? "Checking setup…" : "Preview initializer"} <Arrow /></button><span className="builder-safety"><Shield /> Wallet approval required</span></div>}
        {error && <div className="builder-error"><b>Needs attention</b><span>{error}</span></div>}
      </div>

      <div className="dashboard-card protocol-review-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">SUPPORTED ASSETS</span><h2>{config ? `${assets.length} configured mint${assets.length === 1 ? "" : "s"}` : "Review transaction"}</h2></div>{config && <span className="network-chip"><i /> Devnet</span>}</div>
        {config ? <div className="asset-status-list">{assets.length ? assets.map((asset) => <div className="asset-status-row" key={asset.mint}><span className="asset-status-icon">{asset.enabled ? "✓" : "!"}</span><span><strong>{shortAddress(asset.mint)}</strong><small>{asset.tokenProgram ? (asset.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "Classic SPL Token") : "Not registered"}{asset.decimals === undefined ? "" : ` · ${asset.decimals} decimals`}</small></span><em className={asset.enabled ? "asset-enabled" : "asset-disabled"}>{asset.enabled ? "Enabled" : asset.registered ? "Disabled" : "Not registered"}</em></div>) : <div className="review-empty"><div className="empty-icon">◌</div><p>Reading asset registry…</p></div>}</div> : prepared ? <><div className="review-list"><div><span>Protocol settings</span><strong className="mono">{shortAddress(deriveConfigAddress(PROGRAM_ID))}</strong></div><div><span>Setup actions</span><strong>{prepared.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="simulation-box"><pre>{simulation?.logs.length ? simulation.logs.join("\n") : simulation?.error ?? "No setup details returned."}</pre></div><button className="button button-dark full-button" onClick={() => void signAndInitialize()} disabled={!simulation?.ok || status === "signing" || !walletSigner}>{status === "signing" ? "Waiting for wallet…" : "Approve setup"} <Arrow /></button>{signature && <div className="success-box"><span>✓</span><div><b>Protocol initialized</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a></div></div>}</> : <div className="review-empty"><div className="empty-icon">◌</div><p>Preview the mint list and setup details before approving this change.</p></div>}
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

function MandateBuilder({ wallet, walletSigner, stablecoinOptions, protocolConfig, onCreated, onOpenPayments }: { wallet: string; walletSigner?: (transaction: Transaction) => Promise<Transaction>; stablecoinOptions: StablecoinOption[]; protocolConfig: ProtocolConfig | null; onCreated: (mandateAddress: string) => Promise<void>; onOpenPayments: () => void }) {
  const defaultStablecoin = stablecoinOptions.find((option) => option.value === "usdc" && option.mint)
    ?? stablecoinOptions.find((option) => option.value === "token-2022" && option.mint)
    ?? stablecoinOptions[0];
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
  const [pdaCopied, setPdaCopied] = useState(false);
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
      if (!simulation.ok) throw new Error("The payment wallet could not be prepared. Try again or review the wallet details.");
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
      if (!nextSimulation.ok) setError("The payment policy check failed. Review the network details below.");
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
      setPdaCopied(false);
      await onCreated(prepared.mandateAddress);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function copyMandatePda() {
    if (!prepared) return;
    copyValue(prepared.mandateAddress);
    setPdaCopied(true);
    window.setTimeout(() => setPdaCopied(false), 2200);
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
        <div className="dashboard-card-heading"><div><span className="section-kicker">REVIEW</span><h2>{prepared ? "Ready for approval" : "Your mandate"}</h2></div><span className={`simulation-pill ${simulation?.ok ? "ok" : simulation ? "failed" : ""}`}><i /> {simulation ? (simulation.ok ? "Ready to approve" : "Needs attention") : "Waiting"}</span></div>
        {prepared ? <>
          <div className="mandate-summary"><div><span>Agent</span><strong className="mono">{shortAddress(form.approvedAgent)}</strong></div><div><span>Stablecoin</span><strong>{selectedStablecoin.label} <small>{selectedStablecoin.detail}</small></strong></div><div><span>Recipient</span><strong>Chosen per payment</strong></div><div><span>Max per payment</span><strong>{form.maxPerPayment}</strong></div><div><span>Total spend limit</span><strong>{form.totalLimit}</strong></div><div><span>Expires in</span><strong>{form.expiresInDays} days</strong></div></div>
          <details className="technical-details"><summary>Transaction details</summary><div className="review-list"><div><span>Mandate address</span><strong className="mono">{shortAddress(prepared.mandateAddress)}</strong></div><div><span>Policy actions</span><strong>{prepared.transaction.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="simulation-box"><pre>{simulation?.logs.length ? simulation.logs.join("\n") : simulation?.error ?? "No transaction details returned."}</pre></div></details>
          <button className="button button-dark full-button" onClick={() => void signAndCreate()} disabled={!simulation?.ok || status === "signing" || status === "success"}>{status === "signing" ? "Waiting for wallet…" : status === "success" ? "Mandate created" : "Approve & create mandate"} <Arrow /></button>
          {signature && <div className="mandate-created-callout"><div className="mandate-created-heading"><span>✓</span><div><b>Mandate created on Devnet</b><small>Your policy is active and ready to use for payment.</small></div></div><div className="mandate-pda-row"><div><span>Mandate PDA</span><strong>{prepared.mandateAddress}</strong></div><button type="button" className="button button-secondary-light button-small" onClick={copyMandatePda}>{pdaCopied ? "Copied" : "Copy PDA"}</button></div><div className="mandate-created-actions"><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a><button type="button" className="button button-primary button-small" onClick={onOpenPayments}>Pay with this mandate <Arrow /></button></div></div>}
        </> : <div className="review-empty"><div className="empty-icon">◇</div><p>Review the mandate before signing.</p></div>}
      </div>
    </section>
  );
}

export default App;
