import { beginSettlement, awaitSettlement, forgetUnsentOperation, rejectBeforeSubmission, publishSettlement, PendingSettlementError, type Operation, type Settlement } from "../settlement";
import { authorizedFetch, RequestNotSentError, type WalletBinding } from "../session";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, buildCreateAssociatedTokenAccountInstruction, bytesToHex, createMandateNonce, deriveAssociatedTokenAddress, deriveConfigAddress, deriveMandateAddress, deriveVersionedMandateAddress, toWeb3Transaction } from "@chainpay/sdk";
import type { ChainPayInstruction, Mandate, PaymentReceipt, PreparedMandate, PreparedPayment, PreparedTransaction, SupportedAsset, TokenProgram } from "@chainpay/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";
import { AGENT_URL, BACKEND_URL, DEVNET_PYUSD_TOKEN_2022_MINT, DEVNET_USDC_MINT, MCP_URL, PROGRAM_ID } from "../config/public";
import { chainpayClient } from "../config/client";
import { tokenProgramAccountType } from "./tokenAccounts";
import { settlementKey } from "./settlementKey";
import { assetOrder, knownAsset } from "../config/knownAssets";

export type Action = "Send" | "Receive" | "Approve mandate" | "Receipts";
export type Range = "1H" | "1D" | "1W" | "1M" | "1Y" | "All";

export type SolanaProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect?: () => Promise<{ publicKey: { toString(): string } }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signMessage?: (message: Uint8Array, display?: "utf8" | "hex") => Promise<{ signature: Uint8Array }>;
  on?: (event: "accountChanged", listener: (publicKey: { toString(): string } | null) => void) => void;
  removeListener?: (event: "accountChanged", listener: (publicKey: { toString(): string } | null) => void) => void;
};

export type SpeechRecognitionResult = { 0: { transcript: string } };
export type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: { 0: SpeechRecognitionResult } }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};
export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export function shortAddress(value: string) {
  // Without the length guard a short value repeats its own characters: an
  // 8-character id rendered as "AgEn…T111", which reads as a truncation of
  // something longer and is not reversible by eye.
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function connectionSeenLabel(value: string | null) {
  if (!value) return "Registered · waiting for first call";
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Active just now";
  if (minutes === 1) return "Active 1m ago";
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Last seen ${hours}h ago`;
}

export const MAX_MANDATES_VISIBLE = 50;
export const MAX_PAYMENT_MANDATES = 5;
export type StablecoinOption = {
  value: string;
  label: string;
  detail: string;
  mint: string;
  tokenProgram: TokenProgram;
};

export function buildStablecoinOptions(assets: SupportedAsset[]): StablecoinOption[] {
  return assets
    .filter((asset) => asset.enabled && (asset.tokenProgram === SPL_TOKEN_PROGRAM_ID || asset.tokenProgram === TOKEN_2022_PROGRAM_ID))
    .map((asset) => ({
      value: asset.mint,
      label: knownAsset(asset.mint)?.label ?? `Token ${shortAddress(asset.mint)}`,
      detail: asset.tokenProgram === TOKEN_2022_PROGRAM_ID ? "Token-2022 · capability checked at payment" : "Classic SPL Token",
      mint: asset.mint,
      tokenProgram: asset.tokenProgram === TOKEN_2022_PROGRAM_ID ? "token-2022" as const : "spl-token" as const,
    }))
    .sort((left, right) => assetOrder(left.mint) - assetOrder(right.mint) || left.label.localeCompare(right.label));
}

export function mandateDisplayName(mandate: Mandate, mandates: Mandate[], stablecoinOptions: StablecoinOption[]) {
  const option = stablecoinOptions.find((candidate) => candidate.mint === mandate.allowedMint);
  const tokenLabel = option?.label ?? (mandate.tokenProgram === "token-2022" ? "Token-2022" : "SPL Token");
  const sameToken = mandates
    .filter((candidate) => candidate.allowedMint === mandate.allowedMint)
    .sort(compareMandatesByCreation)
    .map((candidate) => candidate.address);
  const policyNumber = sameToken.indexOf(mandate.address) + 1;
  return `${tokenLabel} spending permission ${policyNumber > 0 ? policyNumber : ""}`.trim();
}

export function compareMandatesByCreation(left: Mandate, right: Mandate) {
  const createdAtDifference = (right.createdAt ?? 0) - (left.createdAt ?? 0);
  return createdAtDifference || right.address.localeCompare(left.address);
}

export function mandateCreatedLabel(mandate: Mandate) {
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

export type McpTool = { name: string; description?: string; inputSchema?: unknown };
export type McpToolResponse = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
export type AgentHistoryItem = { role: "user" | "assistant"; content: string };
export type AgentAttachment = {
  name: string;
  mimeType: string;
  kind: "image" | "document";
  size: number;
  dataUrl?: string;
  text?: string;
};
export type AgentAttachmentPreview = Pick<AgentAttachment, "name" | "mimeType" | "kind" | "size"> & { previewUrl?: string; textPreview?: string };
export type AgentApproval = {
  kind: "mandate" | "token_account" | "payment";
  action: string;
  mandateAddress?: string;
  configAddress?: string;
  tokenAccount?: string;
  mint?: string;
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
export type AgentOutcome = {
  kind: "mandate_approval_required" | "token_account_approval_required" | "payment_approval_required" | "payment_settled" | "payment_blocked" | "details_required" | "payment_pending";
  receiptAddress?: string;
  signature?: string;
  status?: string;
  paymentId?: string;
  resourceStatus?: string;
  receiptUrl?: string;
};
export type AgentCheck = {
  key: "limits" | "token" | "recipient" | "expiry" | "policy";
  label: string;
  status: "pass" | "fail" | "missing" | "pending";
  detail: string;
};
export type AgentRequirements = {
  status: "ready" | "needs_details" | "blocked";
  missing: string[];
  checks: AgentCheck[];
};
export type AgentResponse = { message: string; toolCalls?: string[]; approval?: AgentApproval; outcome?: AgentOutcome; requirements?: AgentRequirements; error?: string };
export type AgentInboxStage = "received" | "understood" | "mandate_prepared" | "policy_checked" | "needs_details" | "waiting_for_approval" | "approved" | "receipt_ready" | "blocked";
export type AgentInboxItem = {
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
  archivedAt?: string;
};

export { archiveInboxItem, isInboxItemArchived, restoreInboxItem } from "./inboxArchive";
export type ApprovalStatus = "idle" | "signing" | "pending" | "success" | "error";
export type ProtocolConfig = {
  address?: string;
  authority: string;
  supportedMints: string[];
  bump: number;
};

export type MandateTableStatus = "active" | "paused" | "revoked";
export type MandateUpdateFields = {
  maxPerPayment: bigint;
  totalLimit: bigint;
  expiresAtSlot: bigint;
  maxPaymentCount: bigint;
  cooldownSlots: bigint;
};

export type MandateAction = "pause" | "resume" | "revoke" | "update";
export type ConnectionToolCall = { name: string; count: number; lastCalledAt: string };
export type AgentConnection = { id: string; wallet: string; agentName: string; scope: string; connectedAt: string; lastSeenAt: string | null; totalCalls: number; toolsCalled: ConnectionToolCall[]; mandates: number };
export type ServerAgentConnection = Omit<AgentConnection, "mandates">;

export const coreToolReferences = [
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
    name: "get_spend_overview",
    description: "Show spend, remaining allowance, and recent receipts for the connected wallet.",
    inputSchema: { type: "object", properties: { owner: { type: "string" }, mandate: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "get_mandate",
    description: "Read an on-chain ChainPay payment mandate and its current status.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Mandate PDA address" } }, required: ["address"], additionalProperties: false },
  },
  {
    name: "get_supported_assets",
    description: "List every mint in the on-chain SupportedAsset settlement registry.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "prepare_token_accounts",
    description: "Inspect enabled registry assets and prepare the next missing associated token account for owner wallet approval.",
    inputSchema: { type: "object", properties: { owner: { type: "string" }, mint: { type: "string" } }, required: ["owner"], additionalProperties: false },
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
    description: "Settle through an explicit human or delegated signing path.",
    inputSchema: { type: "object", properties: { mandate: { type: "string" }, agent: { type: "string" }, recipient: { type: "string" }, amount: { type: "string" }, signingMode: { type: "string", enum: ["human", "delegated"] }, signedTransaction: { type: "string" } }, required: ["mandate", "agent", "recipient", "amount", "signingMode"], additionalProperties: false },
  },
  {
    name: "list_receipts",
    description: "List recent on-chain receipts for the connected wallet or one permission.",
    inputSchema: { type: "object", properties: { owner: { type: "string" }, mandate: { type: "string" }, limit: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "get_payment",
    description: "Fetch an on-chain ChainPay receipt and its persisted Axum transaction signature.",
    inputSchema: { type: "object", properties: { receiptAddress: { type: "string" }, mandate: { type: "string" }, invoiceHash: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "prepare_x402_payment",
    description: "Normalize a Solana x402 challenge and prepare a mandate-checked payment transaction.",
    inputSchema: { type: "object", properties: { challenge: { type: "object", description: "x402 exact payment challenge" }, mandate: { type: "string" }, agent: { type: "string" } }, required: ["challenge", "mandate", "agent"], additionalProperties: false },
  },
  {
    name: "execute_x402_payment",
    description: "Run a live x402 challenge, settlement, receipt verification, and resource retry flow.",
    inputSchema: { type: "object", properties: { resource: { type: "string" }, mandate: { type: "string" }, agent: { type: "string" }, signingMode: { type: "string", enum: ["human", "delegated"] }, signedTransaction: { type: "string" } }, required: ["resource", "mandate", "agent", "signingMode"], additionalProperties: false },
  },
] as const;

export async function copyValue(value: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the browser copy fallback below.
  }

  const copyField = document.createElement("textarea");
  copyField.value = value;
  copyField.setAttribute("readonly", "");
  copyField.style.position = "fixed";
  copyField.style.opacity = "0";
  document.body.appendChild(copyField);
  copyField.select();
  try {
    return document.execCommand("copy");
  } finally {
    copyField.remove();
  }
}

export function connectionScopeDetails(scope: string) {
  try {
    const parsed = JSON.parse(scope) as { mandates?: string[]; tools?: string[] };
    const count = parsed.mandates?.length ?? 0;
    return { count, label: `${count} mandate${count === 1 ? "" : "s"} · ${parsed.tools?.some(tool => ["execute_payment", "execute_x402_payment"].includes(tool)) ? "Payments permitted" : "Read and prepare"}` };
  } catch { return { count: 0, label: "Reconnect to select permissions" }; }
}

export function mcpConnectionsUrl(wallet: string) {
  return `${MCP_URL.replace(/\/mcp\/?$/, "")}/connections?wallet=${encodeURIComponent(wallet)}`;
}

export {
  buildMcpClientConfig,
  buildMcpFirstPrompt,
  connectionAccessLabel,
  type McpConnectionHandoff,
} from "./mcpHandoff.js";

export async function fetchMcpConnections(wallet: string): Promise<AgentConnection[]> {
  const response = await authorizedFetch(mcpConnectionsUrl(wallet), {}, undefined, "passive");
  const payload = await response.json() as { connections?: ServerAgentConnection[]; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `MCP connections request failed (${response.status})`);
  return (payload.connections ?? []).map((connection) => ({ ...connection, mandates: connectionScopeDetails(connection.scope).count }));
}

export async function registerMcpConnection(wallet: string, agentName: string, scope: string) {
  const endpoint = mcpConnectionsUrl(wallet).replace(/\?.*$/, "");
  const response = await authorizedFetch(endpoint, {
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

export async function revokeMcpConnection(wallet: string, id: string) {
  const endpoint = `${MCP_URL.replace(/\/mcp\/?$/, "")}/connections/${encodeURIComponent(id)}?wallet=${encodeURIComponent(wallet)}`;
  const response = await authorizedFetch(endpoint, { method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json() as { error?: string };
    throw new Error(payload.error ?? `MCP connection revoke failed (${response.status})`);
  }
}

export async function mcpRequest<T>(method: string, params?: Record<string, unknown>, binding?: WalletBinding, mode: "interactive" | "passive" = "interactive"): Promise<T> {
  const response = await authorizedFetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    // Allow the relay's 90s cold-start budget plus preparation, but do not leave
    // a browser waiting forever for an MCP response that never arrives.
    signal: AbortSignal.timeout(120_000),
  }, binding, mode);
  let payload: { result?: T; error?: string | { message?: string } };
  try { payload = await response.json(); }
  catch { throw new Error(`MCP returned an unreadable response (HTTP ${response.status})`); }
  if (!payload || typeof payload !== "object") throw new Error(`MCP returned an invalid response (HTTP ${response.status})`);
  if (!response.ok || payload.error) {
    const reason = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(reason || `MCP request failed (HTTP ${response.status})`);
  }
  if (payload.result === undefined || payload.result === null) throw new Error("MCP response did not include a result");
  return payload.result as T;
}

/** The clearest sentence a failed tool result offers, for the owner to read. */
function toolFailureReason(result: McpToolResponse): string {
  const structured = result.structuredContent as { error?: unknown; message?: unknown; action?: unknown } | undefined;
  for (const candidate of [structured?.error, structured?.message, structured?.action]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const text = result.content?.map((part) => part.text ?? "").join(" ").trim();
  return text || "the agent tool reported an error without a reason";
}

function unresolvedPayment(operation: Operation, reason: string, first?: Settlement): never {
  const error = `Payment outcome is unknown: ${reason}. Use Check status to reconcile the original approval. Do not approve a replacement.`;
  publishSettlement(operation, { ...first, status: "unknown", error });
  // End the submit handler so the form can display the error now. Recovery
  // retains the operation and signed bytes and updates the original form later.
  throw new PendingSettlementError(error);
}

export async function callMcpTool(name: string, args: Record<string, unknown>) {
  if (name !== "execute_payment" || (!args.signedTransaction && args.signingMode !== "delegated")) return mcpRequest<McpToolResponse>("tools/call", { name, arguments: args });
  const operation = await beginSettlement(BACKEND_URL, "payments", settlementKey(String(args.mandate), String(args.invoiceHash)), typeof args.signedTransaction === "string" ? args.signedTransaction : undefined);
  let result: McpToolResponse;
  try { result = await mcpRequest<McpToolResponse>("tools/call", { name, arguments: args }, operation); }
  catch (error) {
    if (error instanceof RequestNotSentError) { forgetUnsentOperation(operation); throw error; }
    unresolvedPayment(operation, error instanceof Error ? error.message : "No response from MCP");
  }
  const first = result.structuredContent as Settlement | undefined;
  if (first?.payment_id !== operation.id) {
    const details = result.structuredContent as { action?: string; httpStatus?: number } | undefined;
    const rejectedBeforeRelay = ["rejected_by_preflight", "agent_identity_mismatch", "backend_required", "managed_backend_required", "delegated_signature_rejected"].includes(String(details?.action));
    const rejectedByRelay = ["backend_rejected", "managed_backend_rejected"].includes(String(details?.action)) && [400, 401, 403, 404, 422].includes(Number(details?.httpStatus));
    if (result.isError && (rejectedBeforeRelay || rejectedByRelay)) {
      rejectBeforeSubmission(operation, toolFailureReason(result));
      return result;
    }
    // A tool exception may occur while decoding the relay response after it
    // accepted the payment. A missing/mismatched ID is not proof of non-submission.
    unresolvedPayment(operation, result.isError ? toolFailureReason(result) : "MCP did not identify this payment operation");
  }
  if (first.status === "unknown" || (result.isError && first.status !== "failed")) {
    unresolvedPayment(operation, toolFailureReason(result), first);
  }
  const settled = await awaitSettlement(operation, first);
  return { ...result, isError: false, structuredContent: { ...(result.structuredContent as Record<string, unknown>), ...settled, receiptAddress: settled.receipt_address ?? (result.structuredContent as { receiptAddress?: string })?.receiptAddress } };
}

export const AGENT_INBOX_STORAGE_KEY = "chainpay.ai-inbox.v1";
export const MAX_AGENT_ATTACHMENT_BYTES = 500_000;
export const MAX_AGENT_ATTACHMENT_TEXT = 12_000;
export const agentFlowSteps = ["AI receives", "Understands", "Creates mandate", "Checks policy", "Routes", "You approve", "Settles", "Receipts"] as const;

export function agentInboxKey(wallet: string) {
  return `${AGENT_INBOX_STORAGE_KEY}:${wallet}`;
}

export function loadAgentInbox(wallet: string): AgentInboxItem[] {
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

export function persistAgentInbox(wallet: string, items: AgentInboxItem[]) {
  if (!wallet || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(agentInboxKey(wallet), JSON.stringify(items.slice(0, 30)));
  } catch {
    // The inbox remains usable for this session if local storage is unavailable.
  }
}

export function attachmentKind(file: File): AgentAttachment["kind"] {
  return file.type.startsWith("image/") ? "image" : "document";
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(`Could not read ${file.name}.`));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export async function readAgentAttachment(file: File): Promise<AgentAttachment> {
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

export function attachmentPreview(attachment: AgentAttachment): AgentAttachmentPreview {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.size,
    ...(attachment.dataUrl ? { previewUrl: attachment.dataUrl } : {}),
    ...(attachment.text ? { textPreview: attachment.text.slice(0, 180) } : {}),
  };
}

export function inboxSource(prompt: string, attachments: AgentAttachment[]) {
  if (attachments.length > 0 || /invoice|receipt|bill|image|document|pdf/i.test(prompt)) return "invoice" as const;
  if (/mandate|policy|allowance|spend limit/i.test(prompt)) return "mandate" as const;
  return "message" as const;
}

export function inboxTitle(prompt: string, attachments: AgentAttachment[]) {
  if (attachments.length) return `AI received ${attachments[0].name}${attachments.length > 1 ? ` + ${attachments.length - 1} more` : ""}`;
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact || "AI request";
}

export function paymentRequestFromAttachments(attachments: AgentAttachment[]) {
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

export function paymentRequestFromMessage(message: string): Record<string, unknown> | undefined {
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

export function paymentRequestFromPastedText(message: string): Record<string, unknown> | undefined {
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

export type PastedPaymentDetails = {
  mandate?: string;
  agent?: string;
  mint?: string;
  tokenProgram?: "spl-token" | "token-2022";
  recipient?: string;
  amount?: string;
};

export const SOLANA_ADDRESS_PATTERN = "[1-9A-HJ-NP-Za-km-z]{32,44}";

export function pastedField(message: string, label: string) {
  return message.match(new RegExp(`${label}\\s*:\\s*(${SOLANA_ADDRESS_PATTERN})`, "i"))?.[1];
}

export function pastedPaymentDetails(message: string): PastedPaymentDetails | null {
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

export function asksAgentToCreatePaymentRequest(message: string) {
  return /\b(?:create|generate|make)\b[\s\S]{0,160}\b(?:signed\s+)?(?:devnet\s+)?(?:demo\s+)?(?:payment\s+request|invoice)\b/i.test(message);
}

export function demoPaymentRequestArguments(message: string): Record<string, unknown> | undefined {
  const invoice = message.match(/Invoice\s*:\s*([^\n]+)/i)?.[1]?.trim();
  const mint = message.match(new RegExp(`(?:Token mint|Mint)\\s*:\\s*(${SOLANA_ADDRESS_PATTERN})`, "i"))?.[1];
  const recipient = message.match(new RegExp(`Recipient\\s+token\\s+account\\s*:\\s*(${SOLANA_ADDRESS_PATTERN})`, "i"))?.[1];
  const amount = message.match(/Amount\s*:\s*([0-9]+)/i)?.[1];
  const tokenProgramText = message.match(/Token program\s*:\s*([^\n]+)/i)?.[1] ?? "";
  const tokenProgram = /token[- ]?2022/i.test(tokenProgramText) ? "token-2022" : /spl[- ]?token|classic\s+spl/i.test(tokenProgramText) ? "spl-token" : undefined;
  if (!invoice || !mint || !recipient || !amount || !tokenProgram) return undefined;
  return { invoice, mint, recipient, amount, tokenProgram };
}

export function pastedPaymentResponse(details: PastedPaymentDetails): AgentResponse {
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

export function inboxStageForResult(result: AgentResponse): AgentInboxStage {
  if (result.outcome?.kind === "payment_settled") return "receipt_ready";
  if (result.outcome?.kind === "details_required" || result.requirements?.status === "needs_details") return "needs_details";
  if (result.outcome?.kind === "payment_blocked" || result.requirements?.status === "blocked") return "blocked";
  if (result.outcome?.kind === "payment_pending") return "approved";
  if (result.approval) return "waiting_for_approval";
  if (result.toolCalls?.includes("create_mandate")) return "mandate_prepared";
  if (result.toolCalls?.some((tool) => ["quote_payment_request", "quote_payment", "find_compatible_mandate", "verify_payment_request"].includes(tool))) return "policy_checked";
  return result.toolCalls?.length ? "understood" : "received";
}

export function agentStageIndex(stage: AgentInboxStage) {
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

export async function callChainPayAgent(
  message: string,
  context: { wallet: string; mandateAddress?: string; history: AgentHistoryItem[]; paymentRequest?: Record<string, unknown>; attachments?: AgentAttachment[] },
): Promise<AgentResponse> {
  const response = await authorizedFetch(AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message, wallet: context.wallet, mandateAddress: context.mandateAddress, history: context.history, paymentRequest: context.paymentRequest, attachments: context.attachments }),
  });
  const payload = await response.json() as AgentResponse;
  if (!response.ok) throw new Error(payload.error ?? `AI agent request failed (${response.status})`);
  return payload;
}

export function preparedTransactionFromAgentApproval(approval: AgentApproval): PreparedTransaction {
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

export async function submitSignedTransaction(idempotencyKey: string, signedTransaction: Uint8Array) {
  if (!BACKEND_URL) throw new Error("VITE_CHAINPAY_BACKEND_URL is not configured.");
  const operation = await beginSettlement(BACKEND_URL, "transactions", idempotencyKey, Buffer.from(signedTransaction).toString("base64"));
  let response: Response;
  try {
    response = await authorizedFetch(`${BACKEND_URL.replace(/\/$/, "")}/v1/transactions/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      signed_transaction: Buffer.from(signedTransaction).toString("base64"),
    }),
  }, operation);
  } catch (error) {
    if (error instanceof RequestNotSentError) { forgetUnsentOperation(operation); throw error; }
    return awaitSettlement(operation, undefined, 0);
  }
  const payload = await response.json() as Settlement;
  if (!response.ok) {
    if ([400, 401, 403, 404, 422].includes(response.status)) rejectBeforeSubmission(operation);
    if ([400, 401, 403, 404, 422].includes(response.status)) throw new Error(payload.error ?? "Request rejected before submission");
    return awaitSettlement(operation, undefined, 0);
  }
  return awaitSettlement(operation, payload);
}

export type ManagedSigner = {
  signer_id: string;
  owner_wallet: string;
  public_key: string;
  provider: "privy";
  mandate_pda: string;
  signing_mode: "delegated";
  status: "provisioning" | "active" | "suspended" | "revoked";
};

export async function readJsonResponse<T extends Record<string, unknown>>(response: Response): Promise<T> {
  const body = await response.text();
  if (!body.trim()) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    return { error: body.trim().slice(0, 500) } as unknown as T;
  }
}

export async function provisionManagedSigner(
  ownerWallet: string,
  mandatePda: string,
  mint: string,
  mandateNonce: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<ManagedSigner> {
  const challengeResponse = await authorizedFetch(`${BACKEND_URL.replace(/\/$/, "")}/v1/managed-signers/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner_wallet: ownerWallet, mandate_pda: mandatePda, mint, mandate_nonce: mandateNonce }),
  });
  const challenge = await readJsonResponse<{
    challenge_id?: string;
    message?: string;
    error?: string;
  }>(challengeResponse);
  if (!challengeResponse.ok || !challenge.challenge_id || !challenge.message) {
    throw new Error(challenge.error ?? `Managed signer challenge failed (${challengeResponse.status})`);
  }

  const signature = await signMessage(new TextEncoder().encode(challenge.message));
  const provisionResponse = await authorizedFetch(`${BACKEND_URL.replace(/\/$/, "")}/v1/managed-signers/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge_id: challenge.challenge_id,
      signature: Buffer.from(signature).toString("base64"),
    }),
  });
  const signer = await readJsonResponse<ManagedSigner & { error?: string }>(provisionResponse);
  if (!provisionResponse.ok || !signer.public_key || signer.mandate_pda !== mandatePda) {
    throw new Error(signer.error ?? `Managed signer provisioning failed (${provisionResponse.status})`);
  }
  return signer;
}

export function toolText(result: McpToolResponse | null) {
  return result?.content?.map((part) => part.text ?? "").join("\n") ?? "No tool response returned.";
}

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { formatTokenAmount, parseTokenAmount, reviewExactAmount } from "./amounts";

export function stablecoinOrder(mint: string, options: StablecoinOption[]) {
  const index = options.findIndex((option) => option.mint === mint);
  return index === -1 ? options.length : index;
}

export async function getAccountInfoOrNull(address: PublicKey) {
  try {
    return await chainpayClient.connection.getAccountInfo(address, "confirmed");
  } catch (cause) {
    if (cause instanceof Error && /accountnotfound/i.test(cause.message)) return null;
    throw cause;
  }
}

export function readTokenAccountDelegate(account: { data: Uint8Array } | null): string | null {
  if (!account || account.data.length < 108) return null;
  const delegateOption = new DataView(account.data.buffer, account.data.byteOffset + 72, 4).getUint32(0, true);
  return delegateOption === 0 ? null : new PublicKey(account.data.slice(76, 108)).toBase58();
}

export function readTokenAccountDelegatedAmount(account: { data: Uint8Array } | null): bigint {
  if (!account || account.data.length < 129) return 0n;
  return new DataView(account.data.buffer, account.data.byteOffset + 121, 8).getBigUint64(0, true);
}

export function tokenAccountValidationError(
  account: { owner: PublicKey; data: Uint8Array } | null,
  expectedMint: string,
  expectedOwner: string,
  tokenProgram: TokenProgram,
): string | null {
  if (!account) return "Token account is not prepared yet.";

  const expectedProgram = tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  if (account.owner.toBase58() !== expectedProgram) {
    return "The token account does not match the selected token type.";
  }
  if (account.data.length < 165) {
    return "The address is not a valid token account.";
  }

  const accountMint = new PublicKey(account.data.slice(0, 32)).toBase58();
  if (accountMint !== expectedMint) {
    return "The token account belongs to a different mint.";
  }

  const accountOwner = new PublicKey(account.data.slice(32, 64)).toBase58();
  if (accountOwner !== expectedOwner) {
    return "The token account is not owned by the connected wallet.";
  }

  return null;
}

export async function isPaymentMandateUsable(value: Mandate): Promise<boolean> {
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

export async function resolvePaymentDestination(
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
    // A mint names the stablecoin; it can never receive a payment. Say so
    // before the program check, because pasting a mint is a different mistake
    // from pasting the wrong kind of token account and deserves its own words.
    if (tokenProgramAccountType(existing.data) === "mint") {
      throw new Error("That is the token's mint address, which names the stablecoin itself. Enter the recipient's wallet address instead.");
    }
    if (existing.owner.toBase58() !== expectedProgram || tokenProgramAccountType(existing.data) !== "account") {
      throw new Error("That destination does not match the selected stablecoin.");
    }
    // A token account holds exactly one mint. Sending to one opened for another
    // stablecoin fails on chain, so it is refused here with the reason.
    if (new PublicKey(existing.data.slice(0, 32)).toBase58() !== mint) {
      throw new Error("That token account belongs to a different stablecoin.");
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

export {
  AGENT_URL,
  BACKEND_URL,
  DEVNET_PYUSD_TOKEN_2022_MINT,
  DEVNET_USDC_MINT,
  MCP_URL,
  PROGRAM_ID,
  chainpayClient,
};
