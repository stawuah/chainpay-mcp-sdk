import { useSettlementFormStatus, settlementPendingEvent, settlementTerminalEvent, type Operation, isPendingSettlement } from "../settlement";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, buildCreateAssociatedTokenAccountInstruction, bytesToHex, createMandateNonce, deriveAssociatedTokenAddress, deriveConfigAddress, deriveMandateAddress, deriveReceiptAddress, deriveVersionedMandateAddress, formatExactTokenAmount, toWeb3Transaction } from "@chainpay/sdk";
import type { Mandate, PaymentReceipt, PreparedMandate, PreparedPayment, PreparedTransaction, TokenProgram } from "@chainpay/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";
import solWalletImage from "../assets/your-sol.jpg";
import usdcWalletImage from "../assets/your-usdc.jpg";
import pyusdWalletImage from "../assets/yourpyusd.png";
import type { DashboardTab } from "../routing/paths";
import { InboxReceipt, LoadedReceiptCard } from "../receipts/InboxReceipt";
import { receiptViewFromSettledPayment, tokenLabelForMint } from "../receipts/load";
import { amountLabel, publicReceiptPath } from "../receipts/model";
import { sharePublicReceipt, shareStatusCopy } from "../receipts/share";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Arrow, Shield, shortAddress } from "../ui/marks";
import { reviewExactAmount } from "../owner/amounts";
import { buildConnectionScope, ownedMandateAddresses } from "../owner/connectionScope";
import { EmptyOwnerOverview } from "../owner/EmptyOwnerOverview";
import { configuredDemoReceiptPath, FIRST_MANDATE_TITLE, LOGIN_VS_APPROVAL } from "../owner/onboarding";
import { estimatedSlotsForDays, mandateExpiryLabel, parseExpirySlot } from "../owner/slotEstimate";
import { useOwnerSignIn } from "../owner/useOwnerSignIn";
import { useSlotEstimate } from "../owner/useSlotEstimate";
import {
  AGENT_URL,
  BACKEND_URL,
  DEVNET_PYUSD_TOKEN_2022_MINT,
  DEVNET_USDC_MINT,
  MCP_URL,
  PROGRAM_ID,
  chainpayClient,
  MAX_MANDATES_VISIBLE,
  MAX_PAYMENT_MANDATES,
  type StablecoinOption,
  type McpTool,
  type McpToolResponse,
  type AgentHistoryItem,
  type AgentAttachment,
  type AgentApproval,
  type AgentRequirements,
  type AgentResponse,
  type AgentInboxStage,
  type AgentInboxItem,
  type ApprovalStatus,
  type ProtocolConfig,
  type MandateTableStatus,
  type MandateAction,
  type AgentConnection,
  type ManagedSigner,
  type AgentCheck,
  connectionScopeDetails,
  fetchMcpConnections,
  registerMcpConnection,
  revokeMcpConnection,
  callMcpTool,
  loadAgentInbox,
  persistAgentInbox,
  attachmentPreview,
  inboxSource,
  inboxTitle,
  paymentRequestFromAttachments,
  paymentRequestFromMessage,
  paymentRequestFromPastedText,
  pastedPaymentDetails,
  asksAgentToCreatePaymentRequest,
  demoPaymentRequestArguments,
  pastedPaymentResponse,
  inboxStageForResult,
  preparedTransactionFromAgentApproval,
  provisionManagedSigner,
  toolText,
  parseTokenAmount,
  formatTokenAmount,
  getAccountInfoOrNull,
  tokenAccountValidationError,
  isPaymentMandateUsable,
  resolvePaymentDestination,
  copyValue,
  callChainPayAgent,
  submitSignedTransaction,
  compareMandatesByCreation,
  mandateDisplayName,
  mandateCreatedLabel,
  buildStablecoinOptions,
  readAgentAttachment,
  connectionSeenLabel,
  type SpeechRecognitionLike,
  stablecoinOrder,
  sha256Hex,
  readTokenAccountDelegate,
  readTokenAccountDelegatedAmount,
  agentStageIndex,
  agentFlowSteps,
  coreToolReferences,
  buildMcpClientConfig,
} from "../owner/runtime";

const demoReceiptHref = configuredDemoReceiptPath(import.meta.env.VITE_CHAINPAY_DEMO_RECEIPT_PDA);

export type DashboardProps = {
  wallet: string;
  walletName: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  walletMessageSigner?: (message: Uint8Array) => Promise<Uint8Array>;
  mandateAddress?: string;
  mandate: Mandate | null;
  mandates: Mandate[];
  protocolConfig: ProtocolConfig | null;
  stablecoinOptions: StablecoinOption[];
  mcpTools: McpTool[];
  mcpResult: McpToolResponse | null;
  integrationStatus: "idle" | "loading" | "ready" | "error";
  integrationError: string;
  switchingWalletAccount: boolean;
  tab: DashboardTab;
  mandateBuilder?: boolean;
  onTabChange: (tab: DashboardTab, options?: { mandateBuilder?: boolean }) => void;
  onNavigateHome: () => void;
  onRefresh: (preferredMandateAddress?: string) => Promise<void>;
  onSelectMandate: (mandate: Mandate) => void;
  onChangeAccount: () => void;
  onDisconnect: () => void;
  onChangeWallet: () => void;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
};

type WalletAssetSummary = {
  symbol: "SOL" | "USDC" | "PYUSD";
  address: string;
  balance: string;
  exists: boolean;
  loading: boolean;
};

const walletAssetDefinitions: Array<{ symbol: "USDC" | "PYUSD"; mint: string; tokenProgram: TokenProgram }> = [
  { symbol: "USDC", mint: DEVNET_USDC_MINT, tokenProgram: "spl-token" },
  { symbol: "PYUSD", mint: DEVNET_PYUSD_TOKEN_2022_MINT, tokenProgram: "token-2022" },
];

const walletAssetImages = {
  SOL: solWalletImage,
  USDC: usdcWalletImage,
  PYUSD: pyusdWalletImage,
} as const;

export function Dashboard({
  wallet,
  walletName,
  walletSigner,
  walletMessageSigner,
  mandateAddress,
  mandate,
  mandates,
  protocolConfig,
  stablecoinOptions,
  mcpTools,
  mcpResult,
  integrationStatus,
  integrationError,
  switchingWalletAccount,
  onRefresh,
  onSelectMandate,
  onChangeAccount,
  onDisconnect,
  onChangeWallet,
  onCallMcp,
  tab,
  mandateBuilder = false,
  onTabChange,
  onNavigateHome,
}: DashboardProps) {
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
  const ownerSignIn = useOwnerSignIn();
  const [mandateCreateOpen, setMandateCreateOpen] = useState(Boolean(mandateBuilder));
  useEffect(() => {
    setMandateCreateOpen(Boolean(mandateBuilder));
  }, [mandateBuilder]);
  const [demoPaymentRequest, setDemoPaymentRequest] = useState<Record<string, unknown> | undefined>();
  const [agentInbox, setAgentInbox] = useState<AgentInboxItem[]>([]);
  const [agentAttachments, setAgentAttachments] = useState<AgentAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [approvalStatuses, setApprovalStatuses] = useState<Record<string, ApprovalStatus>>({});
  useEffect(() => {
    const pending = (event: Event) => {
      if ((event as CustomEvent<Operation>).detail.wallet !== wallet) return;
      setApprovalStatuses((current) => Object.fromEntries(Object.entries(current).map(([id,status]) => [id,status === "signing" ? "pending" : status])));
    };
    const settled = (event: Event) => {
      const operation = (event as CustomEvent<Operation>).detail;
      if (operation.wallet !== wallet || operation.status !== "confirmed") return;
      const result = operation.result;
      if (result?.receipt_address && result.signature) setAgentInbox((current) => current.map((item) => item.approval?.receiptAddress === result.receipt_address ? { ...item, approval: undefined, stage: "receipt_ready", response: "The original payment is finalized. Its receipt is ready.", outcome: { kind: "payment_settled", signature: result.signature!, receiptAddress: result.receipt_address!, status: "confirmed" } } : item));
      void onRefresh();
    };
    window.addEventListener(settlementPendingEvent, pending);
    window.addEventListener(settlementTerminalEvent, settled);
    return () => { window.removeEventListener(settlementPendingEvent, pending); window.removeEventListener(settlementTerminalEvent, settled); };
  }, [wallet, onRefresh]);

  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [walletAssets, setWalletAssets] = useState<WalletAssetSummary[]>([]);
  const [copiedWalletAddress, setCopiedWalletAddress] = useState("");
  const walletMenuRef = useRef<HTMLDivElement | null>(null);
  const walletCopyTimer = useRef<number | null>(null);

  const spent = mandate ? formatTokenAmount(mandate.amountSpent, mandateDecimals) : "—";
  const solWalletAsset = walletAssets.find((asset) => asset.symbol === "SOL");
  const tokenWalletAssets = walletAssets.filter((asset) => asset.symbol !== "SOL");
  const walletAssetSourceKey = mandates
    .filter((item) => item.owner === wallet)
    .map((item) => `${item.allowedMint}:${item.sourceTokenAccount}`)
    .sort()
    .join("|");

  useEffect(() => {
    setAgentInbox(wallet ? loadAgentInbox(wallet) : []);
    setAgentAttachments([]);
    setApprovalStatuses({});
    setApprovalErrors({});
  }, [wallet]);

  useEffect(() => {
    if (!walletMenuOpen) return;
    const closeWalletMenu = (event: PointerEvent) => {
      if (!walletMenuRef.current?.contains(event.target as Node)) setWalletMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeWalletMenu);
    return () => document.removeEventListener("pointerdown", closeWalletMenu);
  }, [walletMenuOpen]);

  useEffect(() => () => {
    if (walletCopyTimer.current !== null) window.clearTimeout(walletCopyTimer.current);
  }, []);

  useEffect(() => {
    if (!walletMenuOpen) return;
    let active = true;
    const sourceByMint = new Map(
      mandates
        .filter((item) => item.owner === wallet)
        .map((item) => [item.allowedMint, item.sourceTokenAccount] as const),
    );
    const initialAssets: WalletAssetSummary[] = [
      { symbol: "SOL", address: wallet, balance: "—", exists: true, loading: true },
      ...walletAssetDefinitions.map((asset) => ({
        symbol: asset.symbol,
        address: sourceByMint.get(asset.mint) ?? deriveAssociatedTokenAddress(wallet, asset.mint, asset.tokenProgram),
        balance: "—",
        exists: false,
        loading: true,
      })),
    ];
    setWalletAssets(initialAssets);

    async function loadWalletAssets() {
      const solPromise = chainpayClient.connection.getBalance(new PublicKey(wallet), "confirmed")
        .then((lamports): WalletAssetSummary => ({
          symbol: "SOL",
          address: wallet,
          balance: formatTokenAmount(BigInt(lamports), 9),
          exists: true,
          loading: false,
        }));
      const tokenPromises = walletAssetDefinitions.map(async (asset): Promise<WalletAssetSummary> => {
        const address = sourceByMint.get(asset.mint) ?? deriveAssociatedTokenAddress(wallet, asset.mint, asset.tokenProgram);
        const account = await getAccountInfoOrNull(new PublicKey(address));
        if (!account || tokenAccountValidationError(account, asset.mint, wallet, asset.tokenProgram)) {
          return { symbol: asset.symbol, address, balance: "0", exists: false, loading: false };
        }
        const balance = await chainpayClient.connection.getTokenAccountBalance(new PublicKey(address), "confirmed");
        return { symbol: asset.symbol, address, balance: balance.value.uiAmountString ?? balance.value.amount, exists: true, loading: false };
      });
      const states = await Promise.allSettled([solPromise, ...tokenPromises]);
      if (!active) return;
      setWalletAssets(states.map((state, index) => state.status === "fulfilled" ? state.value : {
        ...initialAssets[index],
        balance: "Unavailable",
        loading: false,
      }));
    }
    void loadWalletAssets();
    return () => { active = false; };
  }, [wallet, walletAssetSourceKey, walletMenuOpen]);

  useEffect(() => {
    if (wallet) persistAgentInbox(wallet, agentInbox);
  }, [agentInbox, wallet]);

  async function copyWalletAddress(address: string) {
    if (!await copyValue(address)) return;
    setCopiedWalletAddress(address);
    if (walletCopyTimer.current !== null) window.clearTimeout(walletCopyTimer.current);
    walletCopyTimer.current = window.setTimeout(() => {
      setCopiedWalletAddress((current) => current === address ? "" : current);
      walletCopyTimer.current = null;
    }, 1800);
  }

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
          mandates: connectionScopeDetails(connection.scope).count,
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
        ? `${result.message.trim() || "The payment settled successfully."}\n\nThe receipt is on this page.`
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
          signingMode: "human",
          signedTransaction: Buffer.from(signed.serialize()).toString("base64"),
        });
        const settled = paymentResult.structuredContent as { status?: string; signature?: string; error?: string; receiptAddress?: string } | undefined;
        if (paymentResult.isError || settled?.status === "failed") {
          throw new Error(settled?.error ?? toolText(paymentResult));
        }
        if (settled?.status !== "confirmed" || !settled.signature || !settled.receiptAddress) {
          throw new Error("Axum did not return a finalized signature and verified receipt.");
        }
        const response = `The payment settled. Transaction ${shortAddress(settled.signature)}. The receipt is on this page.`;
        setApprovalStatuses((current) => ({ ...current, [inboxId]: "success" }));
        setReply(response);
        updateAgentInboxItem(inboxId, { response, stage: "receipt_ready", approval: undefined, outcome: { kind: "payment_settled", signature: settled.signature, receiptAddress: settled.receiptAddress, status: settled.status } });
        setAgentToolsUsed((current) => [...current, "wallet_approval", "execute_payment"]);
        await onRefresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApprovalStatuses((current) => ({ ...current, [inboxId]: isPendingSettlement(error) ? "pending" : "error" }));
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

  function selectTab(nextTab: DashboardTab, options?: { mandateBuilder?: boolean }) {
    setMobileNav(false);
    if (nextTab !== "mandates") setMandateCreateOpen(false);
    else if (options?.mandateBuilder !== undefined) setMandateCreateOpen(options.mandateBuilder);
    onTabChange(nextTab, options);
  }

  function openMandateCreate() {
    setMandateCreateOpen(true);
    selectTab("mandates", { mandateBuilder: true });
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
          <button className="side-link muted sidebar-back" onClick={onNavigateHome}><span className="sidebar-glyph" aria-hidden="true">‹</span><span>Back to site</span></button>
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
            <div className="dashboard-top-actions">
              <span className="dashboard-network"><i /> Solana Devnet</span>
              <div className="wallet-menu" ref={walletMenuRef}>
                <button type="button" className="wallet-chip" title="Open wallet balances and transfer accounts" onClick={() => setWalletMenuOpen((open) => !open)} aria-haspopup="dialog" aria-expanded={walletMenuOpen}>
                  <span className="wallet-avatar"><img src={walletAssetImages.SOL} alt="Solana" /></span>{switchingWalletAccount ? `Opening ${walletName}…` : `${walletName} · ${shortAddress(wallet)}`}<span className="wallet-chip-chevron" aria-hidden="true">⌄</span>
                </button>
                {walletMenuOpen && <section className="wallet-asset-popover" role="dialog" aria-label="Connected wallet assets">
                  <div className="wallet-asset-header"><div><span className="soft-label">CONNECTED WALLET</span><strong>{walletName}</strong></div><span className="wallet-network-pill"><i /> Devnet</span></div>
                  <button type="button" className="wallet-owner-address" onClick={() => void copyWalletAddress(wallet)} title="Copy connected wallet address"><span className="wallet-asset-tree-root"><img src={walletAssetImages.SOL} alt="SOL" /></span><span><strong>{shortAddress(wallet)}</strong><small>Holds SOL directly</small></span><span className="wallet-owner-balance">{solWalletAsset?.loading ? "…" : solWalletAsset?.balance ?? "—"}<small>SOL</small></span><em aria-live="polite">{copiedWalletAddress === wallet ? "Copied ✓" : "Copy"}</em></button>
                  <div className="wallet-asset-list">{tokenWalletAssets.map((asset, index) => <div className={`wallet-asset-row ${asset.symbol.toLowerCase()}`} key={asset.symbol}>
                    <span className="wallet-asset-branch" aria-hidden="true">{index === tokenWalletAssets.length - 1 ? "└" : "├"}</span>
                    <span className="wallet-asset-symbol"><img src={walletAssetImages[asset.symbol]} alt={`${asset.symbol} token`} /></span>
                    <span className="wallet-asset-copy"><strong>{asset.symbol}</strong><small>{asset.exists ? `Your ${asset.symbol} account for transferring funds` : `Your ${asset.symbol} transfer account is not created yet`}</small><button type="button" onClick={() => void copyWalletAddress(asset.address)} title={`Copy your ${asset.symbol} transfer account`}><span>{shortAddress(asset.address)}</span><em aria-live="polite">{copiedWalletAddress === asset.address ? "Copied ✓" : "Copy"}</em></button></span>
                    <span className="wallet-asset-balance">{asset.loading ? "…" : asset.balance}<small>{asset.symbol}</small></span>
                  </div>)}</div>
                  <div className="wallet-asset-actions"><button type="button" className="button button-secondary-light button-small" onClick={() => { setWalletMenuOpen(false); onChangeAccount(); }} disabled={switchingWalletAccount}>{switchingWalletAccount ? "Opening wallet…" : "Change account"}</button><button type="button" className="button button-secondary-light button-small" onClick={() => { setWalletMenuOpen(false); onChangeWallet(); }}>Change wallet</button></div>
                </section>}
              </div>
            </div>
          </header>
          <div className="dashboard-page">
          <div className="dashboard-heading"><div><span className="section-kicker">{tab === "mandates" ? "POLICY CONTROL" : tab === "assistant" ? "AI ORCHESTRATION" : "CONTROL CENTER"}</span><h1 className="t-xl">{tab === "assistant" ? "AI inbox." : tab === "protocol" ? "Protocol setup." : tab === "mandates" ? "Mandates." : tab === "payments" ? "Route a payment." : tab === "agents" ? "Agents." : tab === "receipts" ? "Receipts." : tab === "tools" ? "Tools." : tab === "connect-mcp" ? "Connect MCP." : tab === "settings" ? "Settings." : mandates.length === 0 ? `${FIRST_MANDATE_TITLE}.` : "Good to see you."}</h1><p>{tab === "assistant" ? "Bring an invoice or payment request here. The AI checks it against your mandate and leaves only the final wallet approval for you." : tab === "protocol" ? "Initialize the protocol asset list from the authority wallet." : tab === "mandates" ? (mandateCreateOpen ? "Create a policy for an agent to follow before a payment can be signed." : "Review the spending rules an agent must follow before a payment can be signed.") : tab === "payments" ? "Check the request, then approve the payment in your wallet." : tab === "agents" ? "Agents connected to ChainPay and the scopes they hold." : tab === "receipts" ? "Preview, verify, and send durable proof for every confirmed settlement." : tab === "tools" ? "The exact tools agents can call. Nothing else is exposed." : tab === "connect-mcp" ? "One MCP endpoint for policy enforcement, wallet authorization, routing, stablecoin settlement, and receipts. It never gets your wallet key." : tab === "settings" ? "Solana Devnet status, wallet controls, and account actions." : mandates.length === 0 ? "Connect wallet → Sign in → Review mandate → Approve in wallet." : "Your agent permissions and settlement activity at a glance."}</p></div>{tab === "overview" || tab === "mandates" ? (mandateCreateOpen ? <button className="refresh-button btn btn-secondary-light" onClick={() => setMandateCreateOpen(false)}>← Back to mandates</button> : <button className="button button-primary overview-new-mandate" onClick={openMandateCreate}>{mandates.length === 0 ? FIRST_MANDATE_TITLE : "＋ New mandate"}</button>) : <button className="refresh-button btn btn-secondary-light" onClick={() => void onRefresh()} disabled={integrationStatus === "loading"}>↻ Refresh</button>}</div>

          <div className="integration-strip"><span className={`connection-dot ${integrationStatus}`} /> <b>{integrationStatus === "loading" ? "Syncing" : integrationStatus === "error" ? "Needs attention" : "Connected"}</b><span>Network · Solana Devnet</span><span className="integration-divider" /><b>PAYMENT TOOLS</b><span>{mcpTools.length ? `${mcpTools.length} available` : "Loading"}</span><span className="integration-divider" /><b>AGENTS</b><span>{connections.length ? `${connections.length} connected` : "None connected"}</span>{integrationError && <small title={integrationError}>Check connection</small>}</div>

          <div>{tab === "assistant" ? <AssistantPanel prompt={prompt} setPrompt={setPrompt} reply={reply} thinking={thinking} listening={listening} agentToolsUsed={agentToolsUsed} inbox={agentInbox} approvalStatuses={approvalStatuses} approvalErrors={approvalErrors} attachments={agentAttachments} attachmentError={attachmentError} stablecoinOptions={stablecoinOptions} mandateDecimals={mandateDecimals} onAsk={() => void askChainPay()} onVoice={startVoice} onLoadDemoInvoice={() => void loadDemoPaymentRequest()} onApprove={approveAgentRequest} onAddAttachments={addAgentAttachments} onRemoveAttachment={removeAgentAttachment} onOpenReceipts={() => selectTab("receipts")} /> : tab === "protocol" ? <ProtocolPanel wallet={wallet} walletSigner={walletSigner} config={protocolConfig} onCreated={onRefresh} /> : tab === "mandates" ? <MandatesPanel wallet={wallet} walletSigner={walletSigner} walletMessageSigner={walletMessageSigner} mandates={mandates} mandate={mandate} mandateDecimals={mandateDecimals} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} createOpen={mandateCreateOpen} onCreateOpenChange={setMandateCreateOpen} onMandateAction={runMandateAction} onSelectMandate={onSelectMandate} onOpenPayments={() => selectTab("payments")} onRefresh={onRefresh} /> : tab === "payments" ? <PaymentPanel wallet={wallet} walletSigner={walletSigner} mandates={mandates} mandate={mandate} stablecoinOptions={stablecoinOptions} onSelectMandate={onSelectMandate} onCallMcp={onCallMcp} onAskAgent={(message) => void askChainPay(message)} onRefresh={onRefresh} /> : tab === "agents" ? <AgentsPanel connections={connections} onConnect={() => selectTab("connect-mcp")} onOpenAssistant={() => selectTab("assistant")} /> : tab === "receipts" ? <ReceiptPanel mandates={mandates} stablecoinOptions={stablecoinOptions} onCallMcp={onCallMcp} /> : tab === "tools" ? <ToolsPanel mcpTools={mcpTools} /> : tab === "connect-mcp" ? <ConnectMcpPanel serverUrl={MCP_URL} wallet={wallet} mandates={mandates} stablecoinOptions={stablecoinOptions} connections={connections} onConnected={(connection) => setConnections((current) => [connection, ...current])} onRevoked={async (id) => { await revokeMcpConnection(wallet, id); setConnections((current) => current.filter((connection) => connection.id !== id)); }} onCreateMandate={openMandateCreate} /> : tab === "settings" ? <SettingsPanel wallet={wallet} activeMandateCount={mandates.filter((value) => value.status === "active").length} dangerStatus={dangerStatus} onRevokeAll={() => void revokeAllMandates()} onDisconnect={onDisconnect} onChangeWallet={onChangeWallet} /> : (
            <>
              {mandates.length === 0 ? (
                <EmptyOwnerOverview
                  walletConnected
                  signedIn={ownerSignIn.status === "ready"}
                  signingIn={ownerSignIn.status === "signing"}
                  signInError={ownerSignIn.error}
                  onSignIn={() => void ownerSignIn.signIn()}
                  onReviewMandate={openMandateCreate}
                  demoReceiptHref={demoReceiptHref}
                />
              ) : (
                <>
                  <section className="dashboard-stat-grid"><div className="dashboard-stat"><span className="soft-label">ACTIVE MANDATES</span><strong>{mandates.filter((value) => value.status === "active").length}</strong><small>{`${mandates.length} policy account${mandates.length === 1 ? "" : "s"} found on-chain`}</small></div><div className="dashboard-stat"><span className="soft-label">SELECTED SPEND</span><strong className="mono">{spent}</strong><small>{mandateDecimals === null ? "Reading token decimals" : "Selected mandate · Devnet"}</small></div><div className="dashboard-stat"><span className="soft-label">PENDING PAYMENTS</span><strong>0</strong><small>Nothing waiting for approval</small></div><div className="dashboard-stat"><span className="soft-label">AGENTS CONNECTED</span><strong>{connections.length}</strong><small>{connections.length ? "Scoped MCP access" : "Connect an agent to begin"}</small></div></section>
                  <section className="dashboard-overview overview-agent-section"><OverviewAssistant prompt={prompt} setPrompt={setPrompt} reply={reply} thinking={thinking} listening={listening} onAsk={() => void askChainPay()} onVoice={startVoice} /></section>
                  <section className="dashboard-card activity-feed-card"><div className="dashboard-card-heading"><div><span className="section-kicker">ACTIVITY</span><h2>This wallet</h2></div></div><p className="owner-activity-empty">No payments for this wallet yet.</p>{demoReceiptHref && <p className="owner-demo-link"><span>Separate demo evidence</span><a href={demoReceiptHref}>View demo receipt</a></p>}</section>
                </>
              )}
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

function MandatesPanel({
  wallet,
  walletSigner,
  walletMessageSigner,
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
  walletMessageSigner?: (message: Uint8Array) => Promise<Uint8Array>;
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
  const { estimate: slotEstimate } = useSlotEstimate();
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
  const expandedMandateExpiry = expandedMandate
    ? mandateExpiryLabel(expandedMandate.expiresAtSlot, currentSlot, slotEstimate)
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
      `Source token account: ${expandedMandate.sourceTokenAccount}`,
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
        <MandateBuilder wallet={wallet} walletSigner={walletSigner} walletMessageSigner={walletMessageSigner} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} onCreated={(address) => onRefresh(address)} onOpenPayments={onOpenPayments} />
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
                const expiry = mandateExpiryLabel(value.expiresAtSlot, currentSlot, slotEstimate);
                return (
                  <tr key={value.address} className={selected ? "is-selected" : undefined} onClick={() => { onSelectMandate(value); setExpandedMandateAddress(value.address); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectMandate(value); setExpandedMandateAddress(value.address); } }} tabIndex={0} aria-expanded={expandedMandateAddress === value.address}>
                    <td data-label="Agent">
                      <div className="mandate-agent-cell">
                        <span className="mandate-agent-avatar">{value.approvedAgent.slice(0, 2)}</span>
                        <span><strong>{mandateDisplayName(value, mandates, stablecoinOptions)}{selected ? " · Selected" : ""}</strong><small className="mono">Agent {shortAddress(value.approvedAgent)} · Mandate {shortAddress(value.address)}</small></span>
                      </div>
                    </td>
                    <td data-label="Date"><div className="mandate-date-cell"><strong>{mandateCreatedLabel(value)}</strong><small className="mono">{expiry}</small></div></td>
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
          <div><span>{expandedMandateAsset?.label ?? "Token"} account</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.sourceTokenAccount)} title={`Copy your ${expandedMandateAsset?.label ?? "token"} transfer account`}>{expandedMandate.sourceTokenAccount} ⧉</button><small>Your {expandedMandateAsset?.label ?? "token"} account for transferring funds</small></div>
          <div><span>Recipient rule</span><strong>{expandedMandate.legacyAllowedRecipient ?? "Chosen for each payment"}<small>{expandedMandate.legacyAllowedRecipient ? "Fixed recipient" : "Paste the recipient wallet address; ChainPay resolves its token account"}</small></strong></div>
          <div><span>Maximum per payment</span><strong>{expandedMandateDecimals === undefined ? "Loading amount…" : formatTokenAmount(expandedMandate.maxPerPayment, expandedMandateDecimals)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Total spending limit</span><strong>{expandedMandateDecimals === undefined ? "Loading amount…" : formatTokenAmount(expandedMandate.totalLimit, expandedMandateDecimals)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Already spent</span><strong>{expandedMandateDecimals === undefined ? "Loading amount…" : formatTokenAmount(expandedMandate.amountSpent, expandedMandateDecimals)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Payment count</span><strong>{expandedMandate.paymentCount.toString()}{expandedMandate.maxPaymentCount === 0n ? " · No limit" : ` of ${expandedMandate.maxPaymentCount.toString()}`}</strong></div>
          <div><span>Expiry</span><strong>{expandedMandateExpiry}<small>Slot {expandedMandate.expiresAtSlot.toString()}</small></strong></div>
        </div>
        <div className="mandate-detail-actions">
          <button type="button" className="button button-secondary-light" onClick={copyExpandedMandateDetails}>Copy details for AI</button>
          {expandedMandate.status === "active" && expandedMandate.approvedAgent === wallet && <button type="button" className="button button-primary" onClick={() => useMandateForPayment(expandedMandate)}>Use this mandate for payment <Arrow /></button>}
          {expandedMandate.status === "active" && expandedMandate.approvedAgent !== wallet && <span className="mandate-detail-note">This is an automatic-payment mandate. Axum validates every payment before the secure provider wallet signs it; the owner wallet does not receive a popup for each payment.</span>}
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
  const [mcpPreflight, setMcpPreflight] = useState("");
  const [status, setStatus] = useState<"idle" | "preparing" | "ready" | "signing" | "pending" | "success" | "error">("idle");
  useSettlementFormStatus(wallet, setStatus);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const allPaymentMandates = mandates
    .filter((candidate) => candidate.status === "active" && candidate.approvedAgent === wallet)
    .sort((left, right) => stablecoinOrder(left.allowedMint, stablecoinOptions) - stablecoinOrder(right.allowedMint, stablecoinOptions));
  const paymentMandates = allPaymentMandates.slice(0, MAX_PAYMENT_MANDATES);
  const selectedPaymentMandate = paymentMandates.find((candidate) => candidate.address === mandate?.address) ?? paymentMandates[0] ?? null;
  const representedMints = new Set(allPaymentMandates.map((candidate) => candidate.allowedMint));
  const hasDelegatedActiveMandate = mandates.some((candidate) => candidate.status === "active" && candidate.approvedAgent !== wallet);

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
            `The source token account is ready, but it has ${balance.value.uiAmountString} tokens available. ` +
            `Fund it with at least ${formatTokenAmount(rawAmount, mintDecimals)} ` +
            `before settling this payment.`,
          );
        }
      } catch (cause) {
        if (cause instanceof Error && /source token account is ready/.test(cause.message)) throw cause;
        throw new Error("The source token account could not be read. Refresh the mandate and try again.");
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
      setPrepared(nextPrepared);
      const failedChecks = nextPrepared.preflight.checks.filter((check) => !check.ok).map((check) => check.message);
      if (mcpResult.isError || !nextPrepared.preflight.valid) {
        setStatus("error");
        setError(failedChecks.join(" · ") || "The payment checks could not approve this payment.");
      } else {
        setStatus("ready");
      }
    } catch (cause) {
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function signPayment() {
    if (!prepared || !prepared.preflight.valid) return;
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
        signingMode: "human",
        ...(prepared.request.tokenProgram ? { tokenProgram: prepared.request.tokenProgram } : {}),
        signedTransaction: Buffer.from(signed.serialize()).toString("base64"),
      });
      const backendResult = mcpResult.structuredContent as { status?: string; signature?: string; receiptAddress?: string; error?: string } | undefined;
      if (mcpResult.isError || backendResult?.status === "failed") {
        throw new Error(backendResult?.error ?? toolText(mcpResult));
      }
      const nextSignature = backendResult?.signature;
      if (backendResult?.status !== "confirmed" || !nextSignature || backendResult.receiptAddress !== prepared.receiptAddress) {
        throw new Error("Axum did not return a finalized signature and the expected verified receipt.");
      }
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
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function selectPaymentMandate(address: string) {
    const nextMandate = paymentMandates.find((candidate) => candidate.address === address);
    if (nextMandate?.status === "active") onSelectMandate(nextMandate);
  }

  if (!selectedPaymentMandate) {
    return <div className="dashboard-card flow-empty"><div className="empty-icon">↗</div><h2>{hasDelegatedActiveMandate ? "No wallet-approved mandate" : "No active mandate yet"}</h2><p>{hasDelegatedActiveMandate ? "Your active mandate uses automatic payments through ChainPay's secure provider wallet. Use it from a connected agent with signingMode set to delegated, or create an “Approve each payment” mandate to pay from this browser wallet." : "Create a mandate first. Payments can only be prepared after ChainPay has an on-chain policy to check."}</p></div>;
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
        <div className="builder-grid"><label className="field field-wide"><span>Invoice or payment reference</span><input value={invoice} onChange={(event) => { setInvoice(event.target.value); setPrepared(null); setSignature(""); }} placeholder="invoice-001" /></label><label className="field"><span>Amount <small>{mintDecimals === null ? "reading mint" : `${mintDecimals} decimals`}</small></span><input inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setPrepared(null); setSignature(""); }} placeholder="1.00" /></label><label className="field"><span>Agent signer</span><input value={wallet} readOnly /></label><label className="field field-wide"><span>Recipient wallet address</span><input value={recipient} onChange={(event) => { setRecipient(event.target.value); setPrepared(null); setSignature(""); }} placeholder="Paste the recipient's Solana wallet address" /><small>ChainPay derives the recipient’s account for the selected USDC, PYUSD, or Token-2022 mint.</small></label></div>
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
      <div className="payment-review-stack"><div className="dashboard-card review-card"><div className="dashboard-card-heading"><div><span className="section-kicker">PAYMENT REVIEW</span><h2>{prepared ? "Payment review" : "Waiting for a request"}</h2></div><span className={`state-pill ${prepared?.preflight.valid ? "ok" : prepared ? "failed" : ""}`}><i /> {prepared ? (prepared.preflight.valid ? "Ready to approve" : "Needs attention") : "Waiting"}</span></div>{prepared ? <><div className="review-list payment-review-list"><div><span>Settlement amount</span><strong>{formatTokenAmount(prepared.request.amount, mintDecimals)} <small>({prepared.request.amount.toString()} base units)</small></strong></div><div><span>Stablecoin</span><strong>{stablecoinOptions.find((option) => option.mint === prepared.request.mint)?.label ?? shortAddress(prepared.request.mint)}</strong></div><div><span>Destination</span><strong className="mono">{shortAddress(prepared.request.recipient)}</strong></div><div><span>Signing wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div><div><span>Receipt</span><strong className="mono">{shortAddress(prepared.receiptAddress)}</strong></div></div><div className="check-list">{prepared.preflight.checks.map((check) => <div key={check.name} className={check.ok ? "check-row ok" : "check-row failed"}><span>{check.ok ? "✓" : "×"}</span><b>{check.name}</b><small>{check.message}</small></div>)}</div><div className="state-box payment-readiness-message"><span className="soft-label">{prepared.preflight.valid ? "PAYMENT READY" : "PAYMENT NEEDS ATTENTION"}</span><p>{prepared.preflight.valid ? "The live mandate, registry, token accounts, balance, and receipt state passed inspection. Review the payment, then approve direct Devnet submission." : "The live policy checks rejected this payment. Review the issue before trying again."}</p></div><details className="technical-details"><summary>View policy details</summary><div className="state-box"><span className="soft-label">Live policy response</span><pre>{mcpPreflight || "No policy response returned."}</pre></div></details><div className="review-gate"><Shield /><span>Signing will request approval from <b>{wallet}</b>. Axum submits the signed transaction directly and reports success only after finalized receipt verification.</span></div><button className="button button-dark full-button" onClick={() => void signPayment()} disabled={!prepared.preflight.valid || status === "signing"}>{status === "signing" ? "Waiting for wallet…" : "Approve payment"} <Arrow /></button></> : <div className="review-empty"><div className="empty-icon">↗</div><p>Enter an amount to inspect live state and prepare a direct Devnet transaction.</p></div>}</div></div>
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
  const [status, setStatus] = useState<"idle" | "checking" | "ready" | "signing" | "pending" | "success" | "error">("idle");
  useSettlementFormStatus(wallet, setStatus);
  const [error, setError] = useState("");
  const [batchPrepared, setBatchPrepared] = useState<PreparedTransaction | null>(null);
  const [signature, setSignature] = useState("");
  const [aiReviewRequested, setAiReviewRequested] = useState(false);

  async function importCsv(file?: File) {
    if (!file) return;
    setError("");
    setStatus("idle");
    setBatchPrepared(null);
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
      const { blockhash } = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const serialized = toWeb3Transaction(transaction, blockhash).serialize({ requireAllSignatures: false, verifySignatures: false });
      if (serialized.length > 1_100) throw new Error("This combined transaction is too large. Split the CSV into smaller batches.");
      setBatchPrepared(transaction);
      setStatus("ready");
    } catch (cause) {
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function approveAndSettleBatch() {
    if (!batchPrepared || !walletSigner) return;
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
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="dashboard-card batch-payments-panel" aria-labelledby="batch-payments-title">
      <div className="dashboard-card-heading">
        <div><span className="section-kicker">CSV BATCH SETTLEMENT</span><h2 id="batch-payments-title">Review once. Settle together.</h2></div>
        <span className={`state-pill ${status === "ready" || status === "success" ? "ok" : status === "error" ? "failed" : ""}`}><i /> {status === "checking" ? "Checking" : status === "ready" ? "Ready" : status === "pending" ? "Pending settlement" : status === "signing" ? "Approving" : status === "success" ? "Settled" : "Import CSV"}</span>
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
            return <article className={`batch-payment-row ${entry.status}`} key={`${entry.item.row}-${entry.item.invoice}`}><span className="batch-row-number">{entry.item.row}</span><div><strong>{entry.item.invoice}</strong><small>Mandate {shortAddress(entry.item.mandateAddress)} · Recipient {shortAddress(entry.item.recipient)}</small></div><div><strong>{entry.item.amount}</strong><small>{tokenLabel ?? (token ? shortAddress(token) : "Mandate token")}</small></div><div className="batch-row-status"><span className={`state-pill ${entry.status === "ready" || entry.status === "settled" ? "ok" : entry.status === "blocked" ? "failed" : ""}`}><i /> {entry.status === "settled" ? "Settled" : entry.status === "ready" ? "Ready" : entry.status === "blocked" ? "Blocked" : "Imported"}</span>{entry.error && <small>{entry.error}</small>}</div></article>;
          })}
        </div>
        <div className="batch-actions"><button type="button" className="button button-secondary-light" onClick={askAiToReview} disabled={status === "checking" || status === "signing"}>{aiReviewRequested ? "AI review sent" : "Ask AI to review"}</button><button type="button" className="button button-primary" onClick={() => void prepareBatch()} disabled={status === "checking" || status === "signing"}>{status === "checking" ? "Checking batch…" : "Check batch"} <Arrow /></button></div>
      </>}
      {batchPrepared && <div className="batch-readiness"><Shield /><div><b>Every row passed live policy and account checks</b><p>{batchPrepared.instructions.length} instructions will be signed and submitted directly. Finalized chain state determines whether the batch settled.</p></div><button type="button" className="button button-dark" onClick={() => void approveAndSettleBatch()} disabled={status !== "ready" || !walletSigner}>{status === "signing" ? "Waiting for wallet…" : "Approve & settle batch"} <Arrow /></button></div>}
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

type LedgerReceiptRow = {
  address: string;
  invoiceHash: string;
  recipientTokenAccount: string;
  executedAtSlot: string;
  settled: boolean;
  amountLabel: string;
  tokenLabel: string;
};

function ReceiptPanel({ mandates, stablecoinOptions, onCallMcp }: { mandates: Mandate[]; stablecoinOptions: StablecoinOption[]; onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse> }) {
  const [lookupMode, setLookupMode] = useState<"receipt" | "mandate">("receipt");
  const [receiptAddress, setReceiptAddress] = useState("");
  const [lookupMandate, setLookupMandate] = useState("");
  const [lookupInvoiceHash, setLookupInvoiceHash] = useState("");
  const [result, setResult] = useState("");
  const [lookupPda, setLookupPda] = useState("");
  const [onChainReceipts, setOnChainReceipts] = useState<LedgerReceiptRow[]>([]);
  const [selectedReceiptAddress, setSelectedReceiptAddress] = useState("");
  const [receiptLoadStatus, setReceiptLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [receiptLoadError, setReceiptLoadError] = useState("");
  const [receiptLoadVersion, setReceiptLoadVersion] = useState(0);
  const [shareMessage, setShareMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const mandateKey = mandates.map((item) => item.address).sort().join("|");
  const stablecoinKey = stablecoinOptions.map((item) => `${item.mint}:${item.label}`).join("|");
  const selectedReceipt = onChainReceipts.find((item) => item.address === selectedReceiptAddress) ?? onChainReceipts[0] ?? null;
  const settledCount = onChainReceipts.filter((item) => item.settled).length;

  useEffect(() => {
    let active = true;
    async function loadOnChainReceipts() {
      setReceiptLoadStatus("loading");
      setReceiptLoadError("");
      if (mandates.length === 0) {
        if (active) {
          setOnChainReceipts([]);
          setSelectedReceiptAddress("");
          setReceiptLoadStatus("ready");
        }
        return;
      }

      const receiptStates = await Promise.allSettled(
        mandates.map((mandate) => chainpayClient.getPaymentsByMandate(mandate.address)),
      );
      const receiptsByAddress = new Map<string, PaymentReceipt>();
      for (const state of receiptStates) {
        if (state.status !== "fulfilled") continue;
        for (const receipt of state.value) receiptsByAddress.set(receipt.address, receipt);
      }
      const receipts = [...receiptsByAddress.values()].sort((left, right) => (
        left.executedAtSlot === right.executedAtSlot
          ? right.address.localeCompare(left.address)
          : left.executedAtSlot > right.executedAtSlot ? -1 : 1
      ));
      const mints = [...new Set(receipts.map((receipt) => receipt.mint))];
      const decimalStates = await Promise.allSettled(
        mints.map(async (mint) => [mint, await chainpayClient.getMintDecimals(mint)] as const),
      );
      const decimalsByMint = new Map<string, number>();
      for (const state of decimalStates) {
        if (state.status === "fulfilled") decimalsByMint.set(state.value[0], state.value[1]);
      }
      const details = receipts.map((receipt) => {
        const view = receiptViewFromSettledPayment(receipt, decimalsByMint.get(receipt.mint) ?? null);
        const amount = formatExactTokenAmount(receipt.amount, decimalsByMint.get(receipt.mint) ?? null);
        return {
          address: receipt.address,
          invoiceHash: bytesToHex(receipt.invoiceHash),
          recipientTokenAccount: receipt.recipientTokenAccount,
          executedAtSlot: receipt.executedAtSlot.toString(),
          settled: Boolean(view),
          amountLabel: amountLabel(amount),
          tokenLabel: stablecoinOptions.find((option) => option.mint === receipt.mint)?.label ?? tokenLabelForMint(receipt.mint),
        };
      });
      if (!active) return;
      setOnChainReceipts(details);
      setSelectedReceiptAddress((current) => (
        details.some((receipt) => receipt.address === current) ? current : details[0]?.address ?? ""
      ));
      const failures = receiptStates.filter((state) => state.status === "rejected").length;
      if (failures === receiptStates.length) {
        setReceiptLoadStatus("error");
        setReceiptLoadError("ChainPay could not read receipt accounts from Devnet. Try refreshing.");
      } else {
        setReceiptLoadStatus("ready");
        if (failures > 0) setReceiptLoadError(`${failures} mandate receipt history could not be loaded.`);
      }
    }
    void loadOnChainReceipts();
    return () => { active = false; };
  }, [mandateKey, stablecoinKey, receiptLoadVersion]);

  async function sendReceipt(receipt: LedgerReceiptRow) {
    setShareMessage("");
    const result = await sharePublicReceipt({
      amountLabel: receipt.amountLabel,
      tokenLabel: receipt.tokenLabel,
      receiptPda: receipt.address,
    });
    setShareMessage(shareStatusCopy(result));
  }

  async function lookup() {
    let pda = lookupMode === "receipt" ? receiptAddress.trim() : "";
    if (lookupMode === "mandate") {
      if (!lookupMandate.trim() || !lookupInvoiceHash.trim()) return;
      try {
        pda = deriveReceiptAddress(lookupMandate.trim(), hexToBytes(lookupInvoiceHash.trim()), PROGRAM_ID);
      } catch (cause) {
        setLookupPda("");
        setResult(cause instanceof Error ? cause.message : String(cause));
        return;
      }
    }
    if (!pda) return;
    setLoading(true);
    setShareMessage("");
    setLookupPda(pda);
    try {
      const response = await onCallMcp("get_payment", lookupMode === "receipt"
        ? { receiptAddress: pda }
        : { mandate: lookupMandate.trim(), invoiceHash: lookupInvoiceHash.trim() });
      setResult(toolText(response));
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return <section className="receipt-page">
    <div className="dashboard-card onchain-receipts-card">
      <div className="dashboard-card-heading"><div><span className="section-kicker">ON-CHAIN RECEIPTS</span><h2>Settlement history</h2></div><div className="receipt-ledger-heading-actions"><span className="chip chip-muted">{settledCount} settled</span><button type="button" className="refresh-button btn btn-secondary-light" onClick={() => setReceiptLoadVersion((value) => value + 1)} disabled={receiptLoadStatus === "loading"}>↻ Refresh</button></div></div>
      <p className="builder-intro">Receipts are read directly from the ChainPay program for this wallet’s mandates. Select one to preview or share the ChainPay URL.</p>
      {receiptLoadStatus === "loading" ? <p className="receipt-ledger-empty">Reading Devnet receipts…</p> : onChainReceipts.length === 0 ? <p className="receipt-ledger-empty">No receipts yet — they appear once a payment settles.</p> : <div className="receipt-ledger-list">{onChainReceipts.map((receipt) => {
        const selected = receipt.address === selectedReceipt?.address;
        return <article className={`receipt-ledger-row ${selected ? "is-selected" : ""}`} key={receipt.address}>
          <button type="button" className="receipt-ledger-main" onClick={() => setSelectedReceiptAddress(receipt.address)} aria-label={`Preview ${receipt.tokenLabel} receipt ${receipt.address}`}>
            <span className="receipt-ledger-icon">{receipt.settled ? "·" : "?"}</span>
            <span className="receipt-ledger-payment"><strong>{receipt.amountLabel} {receipt.tokenLabel}</strong><small>Invoice {shortAddress(receipt.invoiceHash)} · to {shortAddress(receipt.recipientTokenAccount)}</small></span>
            <span className="receipt-ledger-status"><strong>{receipt.settled ? "Settled" : "Unsettled"}</strong><small>Slot {receipt.executedAtSlot}</small></span>
          </button>
          <div className="receipt-ledger-actions"><button type="button" className="btn-icon" onClick={() => setSelectedReceiptAddress(receipt.address)} aria-label={`Preview receipt ${receipt.address}`}>⌕</button><a className="btn-icon" href={publicReceiptPath(receipt.address)} aria-label={`Open public receipt ${receipt.address}`}>↗</a><button type="button" className="btn-icon" onClick={() => void sendReceipt(receipt)} aria-label={`Share receipt ${receipt.address}`}>➤</button></div>
        </article>;
      })}</div>}
      {receiptLoadError && <small className={receiptLoadStatus === "error" ? "receipt-ledger-error" : "receipt-ledger-warning"}>{receiptLoadError}</small>}
    </div>
    {selectedReceipt && <div className="dashboard-card receipt-preview-card"><div className="dashboard-card-heading"><div><span className="section-kicker">RECEIPT PREVIEW</span><h2>{selectedReceipt.amountLabel} {selectedReceipt.tokenLabel}</h2></div></div><LoadedReceiptCard receiptPda={selectedReceipt.address} shareMode="dashboard" onShare={() => void sendReceipt(selectedReceipt)} /></div>}
    {shareMessage && <div className="receipt-share-message" role="status">{shareMessage}</div>}
    <div className="dashboard-card receipt-lookup"><div className="dashboard-card-heading"><div><span className="section-kicker">VERIFY A PAYMENT</span><h2>Look up another settlement</h2></div></div><p className="builder-intro">Look up a payment by receipt PDA, or use its mandate and invoice hash. The card below is read from the finalized on-chain receipt.</p><div className="receipt-lookup-tabs" role="tablist" aria-label="Receipt lookup type"><button type="button" className={lookupMode === "receipt" ? "is-selected" : ""} onClick={() => { setLookupMode("receipt"); setLookupPda(""); setResult(""); }} role="tab" aria-selected={lookupMode === "receipt"}>Receipt address</button><button type="button" className={lookupMode === "mandate" ? "is-selected" : ""} onClick={() => { setLookupMode("mandate"); setLookupPda(""); setResult(""); }} role="tab" aria-selected={lookupMode === "mandate"}>Mandate + invoice</button></div>{lookupMode === "receipt" ? <div className="receipt-search"><input value={receiptAddress} onChange={(event) => { setReceiptAddress(event.target.value); setLookupPda(""); }} onKeyDown={(event) => { if (event.key === "Enter") void lookup(); }} placeholder="Receipt PDA address" aria-label="Receipt PDA address" /><button className="button button-primary" onClick={() => void lookup()} disabled={loading || !receiptAddress.trim()}>{loading ? "Looking up…" : "Verify"} <Arrow /></button></div> : <div className="receipt-search receipt-search-grid"><input value={lookupMandate} onChange={(event) => { setLookupMandate(event.target.value); setLookupPda(""); }} placeholder="Mandate address" aria-label="Mandate address" /><input value={lookupInvoiceHash} onChange={(event) => { setLookupInvoiceHash(event.target.value); setLookupPda(""); }} onKeyDown={(event) => { if (event.key === "Enter") void lookup(); }} placeholder="64-character invoice hash" aria-label="Invoice hash" /><button className="button button-primary" onClick={() => void lookup()} disabled={loading || !lookupMandate.trim() || !lookupInvoiceHash.trim()}>{loading ? "Looking up…" : "Verify"} <Arrow /></button></div>}{lookupPda && <LoadedReceiptCard receiptPda={lookupPda} shareMode="dashboard" />}{result && <details className="receipt-raw"><summary>View raw MCP response</summary><div className="state-box receipt-result"><pre>{result}</pre></div></details>}</div>
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
    <div className="agent-requirement-heading"><span className="soft-label">CHECKS BEFORE APPROVAL</span><span className="state-pill"><i /> {statusLabel}</span></div>
    <div className="agent-requirement-grid">{requirements.checks.map((check) => <div className={`agent-requirement-row ${check.status}`} key={check.key}><span>{check.status === "pass" ? "✓" : check.status === "fail" ? "×" : check.status === "missing" ? "!" : "·"}</span><div><b>{check.label}</b><small>{check.detail}</small></div></div>)}</div>
    {requirements.missing.length > 0 && <p className="agent-requirement-missing"><b>Please provide:</b> {requirements.missing.join(" · ")}</p>}
  </div>;
}

function AgentInboxPanel({ inbox, approvalStatuses, approvalErrors, stablecoinOptions, mandateDecimals, onApprove, onOpenReceipts }: { inbox: AgentInboxItem[]; approvalStatuses: Record<string, ApprovalStatus>; approvalErrors: Record<string, string>; stablecoinOptions: StablecoinOption[]; mandateDecimals: number | null; onApprove: (id: string) => Promise<void>; onOpenReceipts: () => void }) {
  const waitingCount = inbox.filter((item) => item.stage === "waiting_for_approval").length;
  const currentItem = inbox[0];
  const historyItems = inbox.slice(1, 12);
  const renderApproval = (item: AgentInboxItem) => item.approval && item.stage === "waiting_for_approval" && <AgentApprovalCard approval={item.approval} status={approvalStatuses[item.id] ?? "idle"} error={approvalErrors[item.id] ?? item.error ?? ""} stablecoinOptions={stablecoinOptions} decimals={mandateDecimals} onApprove={() => onApprove(item.id)} />;
  const renderReceipt = (item: AgentInboxItem) => item.stage === "receipt_ready" && <InboxReceipt receiptAddress={item.outcome?.receiptAddress} />;
  const sourceLabel = (item: AgentInboxItem) => item.source === "invoice" ? "INVOICE / DOCUMENT" : item.source === "mandate" ? "MANDATE REQUEST" : "AI REQUEST";
  const statusLabel = (item: AgentInboxItem) => item.stage === "waiting_for_approval" ? "Approval needed" : item.stage === "receipt_ready" ? "Receipt ready" : item.stage === "approved" ? "Policy active" : item.stage === "blocked" ? "Blocked" : item.stage.replaceAll("_", " ");
  const statusClass = (item: AgentInboxItem) => item.stage === "approved" ? "ok" : item.stage === "blocked" ? "failed" : "";
  const renderHeader = (item: AgentInboxItem, current: boolean) => <div className="agent-inbox-item-heading"><div><span className="agent-inbox-source">{sourceLabel(item)}</span>{current && <span className="agent-current-label">CURRENT REQUEST</span>}<h3>{item.title}</h3></div><span className={`state-pill ${statusClass(item)}`}><i /> {statusLabel(item)}</span></div>;
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
  return <div className="agent-approval-card"><div className="agent-approval-heading"><div><span className="section-kicker">WALLET APPROVAL</span><h3>{isPayment ? "Approve payment" : "Approve this mandate once"}</h3></div><span className={`state-pill ${status === "error" ? "failed" : status === "success" ? "ok" : ""}`}><i /> {status === "pending" ? "Pending settlement" : status === "signing" ? "Waiting" : status === "success" ? "Approved" : status === "error" ? "Needs attention" : "Ready"}</span></div><p>{isPayment ? "Review the amount, recipient, and policy checks below. Approve in your wallet to complete the payment." : "The AI prepared this spending policy. Approve it once; future policy-compliant payments can settle without another wallet prompt."}</p><div className="agent-approval-details">{isPayment ? <><span><b>Amount</b><code>{displayAmount}</code></span><span><b>Recipient</b>{typeof payment?.recipient === "string" ? <code>{shortAddress(payment.recipient)}</code> : "See wallet"}</span><span><b>Receipt</b>{approval.receiptAddress && typeof approval.receiptAddress === "string" ? <code>{shortAddress(approval.receiptAddress)}</code> : "Prepared"}</span></> : <><span><b>Mandate</b>{approval.mandateAddress ? <code>{shortAddress(approval.mandateAddress)}</code> : "New policy"}</span><span><b>Instructions</b>{instructionNames}</span><span><b>Wallet</b>{approval.transaction?.feePayer ? <code>{shortAddress(approval.transaction.feePayer)}</code> : "Connected owner"}</span></>}</div>{error && <div className="builder-error"><b>Approval blocked</b><span>{error}</span></div>}<button className="button button-dark full-button" onClick={() => void onApprove()} disabled={status === "signing" || status === "pending" || status === "success"}>{status === "signing" ? "Waiting for wallet…" : status === "success" ? "Approved" : isPayment ? "Approve payment in wallet" : "Approve wallet once"} <Arrow /></button></div>;
}

function AgentsPanel({ connections, onConnect, onOpenAssistant }: { connections: AgentConnection[]; onConnect: () => void; onOpenAssistant: () => void }) {
  return <section className="page-panel">
    <div className="page-panel-actions"><button className="button button-secondary-light" onClick={onOpenAssistant}>Open assistant <Arrow /></button><button className="button button-primary" onClick={onConnect}>Connect an agent <Arrow /></button></div>
    {connections.length ? <div className="agent-card-grid">{connections.map((connection) => <article className="dashboard-card agent-registry-card" key={connection.id}><div className="agent-registry-top"><span className="avatar-ring agent-avatar">{connection.agentName.slice(0, 2).toUpperCase()}</span><span className={connection.lastSeenAt ? "status-pill" : "state-pill"}><i /> {connection.lastSeenAt ? "Connected" : "Registered"}</span></div><h2>{connection.agentName}</h2><p className="mono">Owner · {shortAddress(connection.wallet)}</p><div className="agent-registry-meta"><span>{connection.mandates} active mandate{connection.mandates === 1 ? "" : "s"}</span><strong>{connectionSeenLabel(connection.lastSeenAt)}</strong></div><span className="chip chip-muted agent-scope-chip">{connectionScopeDetails(connection.scope).label}</span><div className="agent-tool-calls">{connection.toolsCalled.length ? connection.toolsCalled.map((tool) => <span className="tool-call-chip" key={tool.name}>{tool.name} <b>×{tool.count}</b></span>) : <span className="t-body-sm">No tools called yet.</span>}</div></article>)}</div> : <div className="dashboard-card page-empty"><p>No agents connected yet.</p><button className="button button-primary" onClick={onConnect}>Connect an agent <Arrow /></button></div>}
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
    <div className="connection-safety-note"><Shield /><span>Browser-approved payments still request your wallet signature. Automatic-payment mandates use their provisioned provider wallet through Axum; no private key or provider credential belongs in the AI connection.</span></div>
  </div>;
}

function ConnectMcpPanel({ serverUrl, wallet, mandates, stablecoinOptions, connections, onConnected, onRevoked, onCreateMandate }: { serverUrl: string; wallet: string; mandates: Mandate[]; stablecoinOptions: StablecoinOption[]; connections: AgentConnection[]; onConnected: (connection: AgentConnection) => void; onRevoked: (id: string) => Promise<void>; onCreateMandate: () => void }) {
  const ownedAddresses = ownedMandateAddresses(mandates, wallet);
  const mandateOptions = mandates
    .filter((mandate) => ownedAddresses.includes(mandate.address))
    .map((mandate) => ({
      value: mandate.address,
      label: mandateDisplayName(mandate, mandates, stablecoinOptions),
      description: shortAddress(mandate.address),
    }));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [scope, setScope] = useState("");
  const [allowPayments, setAllowPayments] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [connectionToken, setConnectionToken] = useState("");
  const [configCopied, setConfigCopied] = useState(false);
  const config = buildMcpClientConfig(serverUrl, connectionToken || undefined);

  const ownedKey = ownedAddresses.join(",");
  useEffect(() => {
    if (scope && !ownedKey.split(",").includes(scope)) setScope("");
  }, [ownedKey, scope]);

  function copyConfig() {
    copyValue(config);
    setConfigCopied(true);
    window.setTimeout(() => setConfigCopied(false), 2200);
  }

  function closeDialog() {
    setAllowPayments(false);
    setDialogOpen(false);
    setError("");
  }

  async function createConnection() {
    if (!agentName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const createdAgentName = agentName.trim();
      const result = await registerMcpConnection(wallet, createdAgentName, buildConnectionScope(scope, ownedAddresses, allowPayments));
      onConnected({ ...result.connection, mandates: 1 });
      setConnectionId(result.connection.id);
      setConnectionName(createdAgentName);
      setConnectionToken(result.token);
      setConfigCopied(false);
      closeDialog();
      setAgentName("");
      setScope("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  return <section className="page-panel connect-panel">
    <AiConnectionFlow />
    <div className="dashboard-card connection-config-card"><div className="dashboard-card-heading"><div><span className="section-kicker">CONNECTION CONFIG</span><h2>One MCP endpoint</h2></div><span className="mcp-badge"><span /> MCP · Devnet</span></div><p className="builder-intro">Copy the endpoint into any MCP-compatible AI. Create a named connection to issue a private bearer token and let the AI discover the full ChainPay payment flow.</p><div className="copy-row"><span className="mono">{serverUrl}</span><button className="btn-icon" onClick={() => copyValue(serverUrl)} aria-label="Copy server URL">⧉</button></div>{connectionToken && <div className="token-once"><div className="token-once-heading"><span className="status-pill"><i /> Connection ready</span><span className="chip chip-blue">{connectionName}</span></div><p>Copy the secure config now. The bearer token authenticates this client; the on-chain mandate still enforces mint, amount, recipient, expiry, and total limits.</p></div>}<div className="config-code-wrap"><button className="button button-secondary-light copy-config" onClick={copyConfig}>{configCopied ? "Copied" : connectionToken ? "Copy secure config" : "Copy config"}</button><pre className="schema-block">{config}</pre></div></div>
    <div className="dashboard-card connected-clients-card"><div className="dashboard-card-heading"><div><span className="section-kicker">CONNECTED CLIENTS</span><h2>Agent connections</h2></div><Button type="button" variant="primary" label="New connection" isDisabled={false} onClick={() => { setAllowPayments(false); setDialogOpen(true); }} /></div>{connections.length ? <div className="connection-list">{connections.map((connection) => <div className="connection-row" key={connection.id}><div><strong>{connection.agentName}</strong><small className="mono">Owner · {shortAddress(connection.wallet)}</small></div><span className="chip chip-muted">{connectionScopeDetails(connection.scope).label}</span><span className="t-body-sm">{connectionSeenLabel(connection.lastSeenAt)}</span><button className="btn-icon" onClick={() => setRevokeId(connection.id)} aria-label={`Revoke ${connection.agentName}`}>×</button><div className="connection-tools">{connection.toolsCalled.length ? connection.toolsCalled.map((tool) => <span className="tool-call-chip" key={tool.name}>{tool.name} <b>×{tool.count}</b></span>) : <span>No tools called yet.</span>}</div></div>)}</div> : <div className="page-empty compact-empty"><p>No agents connected yet.</p><Button type="button" variant="primary" label="New connection" isDisabled={false} onClick={() => { setAllowPayments(false); setDialogOpen(true); }} /></div>}</div>
    <Dialog isOpen={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }} purpose="form" width={480}>
      <Layout
        height="auto"
        header={<DialogHeader title="Pair an agent" onOpenChange={(open) => { if (!open) closeDialog(); }} />}
        content={
          <LayoutContent>
            <div className="connection-form">
              <p>Give this client one endpoint and a private bearer token. Scope it to one of your mandates. Payment execution stays off unless you enable it.</p>
              <TextInput label="Agent name" value={agentName} onChange={setAgentName} placeholder="Invoice agent" />
              {mandateOptions.length ? (
                <Selector
                  label="Owned mandate"
                  value={scope}
                  onChange={setScope}
                  options={mandateOptions}
                  description="Connections can only use a mandate this wallet owns."
                />
              ) : (
                <p className="builder-error"><b>No owned mandate</b><span>Create a mandate first. You cannot type another owner’s address.</span></p>
              )}
              <CheckboxInput
                label="Permit payments within this mandate"
                description="Off by default. The agent can read and prepare payments. This permission is required before it can execute them."
                value={allowPayments}
                onChange={setAllowPayments}
              />
              {error && <p className="builder-error"><b>Connection failed</b><span>{error}</span></p>}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <Button type="button" variant="secondary" label="Cancel" isDisabled={creating} onClick={closeDialog} />
            {mandateOptions.length ? (
              <Button type="button" variant="primary" label={creating ? "Creating…" : "Create connection"} isDisabled={!agentName.trim() || !scope.trim() || creating} onClick={() => void createConnection()} />
            ) : (
              <Button type="button" variant="primary" label="Create a mandate" isDisabled={false} onClick={() => { closeDialog(); onCreateMandate(); }} />
            )}
          </LayoutFooter>
        }
      />
    </Dialog>
    <ConfirmDialog open={Boolean(revokeId)} title="Revoke this connection?" description="This agent will no longer be able to call ChainPay tools with this connection." confirmLabel="Revoke connection" onClose={() => setRevokeId(null)} onConfirm={() => { const id = revokeId; setRevokeId(null); if (id) void onRevoked(id).then(() => { if (id === connectionId) { setConnectionId(""); setConnectionName(""); setConnectionToken(""); } }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} />
  </section>;
}

function SettingsPanel({ wallet, activeMandateCount, dangerStatus, onRevokeAll, onDisconnect, onChangeWallet }: { wallet: string; activeMandateCount: number; dangerStatus: string; onRevokeAll: () => void; onDisconnect: () => void; onChangeWallet: () => void }) {
  const [section, setSection] = useState<"general" | "notifications" | "danger">("general");
  const [confirmAction, setConfirmAction] = useState<"revoke" | "disconnect" | null>(null);
  return <section className="page-panel settings-panel">
    <div className="settings-tabs" role="tablist">{(["general", "notifications", "danger"] as const).map((item) => <button className={section === item ? "cp-tab active" : "cp-tab"} key={item} onClick={() => setSection(item)} role="tab" aria-selected={section === item}>{item === "general" ? "General" : item === "notifications" ? "Notifications" : "Danger zone"}</button>)}</div>
    {section === "general" && <div className="dashboard-card settings-card"><div className="settings-value"><span>Network</span><div><strong>Solana Devnet</strong><p className="settings-unavailable">This dashboard talks to Solana Devnet. The network cannot be switched here.</p></div></div><div className="settings-value"><span>Connected wallet</span><div className="copy-row"><span className="mono">{wallet}</span><button className="btn-icon" onClick={() => copyValue(wallet)} aria-label="Copy wallet address">⧉</button></div></div><div className="settings-wallet-action"><div><strong>Use a different wallet</strong><p>Leave this wallet’s dashboard and choose another browser wallet or account. Existing mandates stay on-chain.</p></div><Button type="button" variant="secondary" label="Change wallet" isDisabled={false} onClick={onChangeWallet} /></div></div>}
    {section === "notifications" && <div className="dashboard-card settings-card"><div className="settings-unavailable-card"><strong>Notifications unavailable</strong><p>There is no webhook or email delivery in this build. Nothing here can be saved.</p></div></div>}
    {section === "danger" && <div className="dashboard-card settings-card danger-card"><div className="danger-row"><div><strong>Revoke all mandates</strong><p>{activeMandateCount === 0 ? "There are no active mandates to revoke." : `This asks your wallet to approve revoke instructions for ${activeMandateCount} active mandate${activeMandateCount === 1 ? "" : "s"}. Settled payments stay on-chain.`}</p></div><Button type="button" variant="secondary" label="Revoke all" isDisabled={activeMandateCount === 0} onClick={() => setConfirmAction("revoke")} /></div><div className="danger-row"><div><strong>Disconnect wallet</strong><p>Return to the public ChainPay landing page. This does not revoke mandates.</p></div><Button type="button" variant="secondary" label="Disconnect" isDisabled={false} onClick={() => setConfirmAction("disconnect")} /></div>{dangerStatus && <p className="settings-status">{dangerStatus}</p>}</div>}
    <ConfirmDialog open={confirmAction === "revoke"} title="Revoke every active mandate?" description={`${activeMandateCount} active mandate${activeMandateCount === 1 ? "" : "s"} will require a wallet-approved revoke transaction. Agents will not be able to request new payments until you create new mandates.`} confirmLabel="Revoke all mandates" onClose={() => setConfirmAction(null)} onConfirm={() => { setConfirmAction(null); onRevokeAll(); }} />
    <ConfirmDialog open={confirmAction === "disconnect"} title="Disconnect this wallet?" description="You will leave the connected dashboard and return to the public site. Unsigned transactions will be discarded. Existing mandates stay on-chain." confirmLabel="Disconnect wallet" onClose={() => setConfirmAction(null)} onConfirm={() => { setConfirmAction(null); onDisconnect(); }} />
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
  const [status, setStatus] = useState<"idle" | "building" | "ready" | "signing" | "pending" | "success" | "error">("idle");
  useSettlementFormStatus(wallet, setStatus);
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
    setSignature("");
    try {
      if (config) throw new Error("The protocol is already initialized on this program.");
      const nextPrepared = chainpayClient.buildInitializeConfig(normalizedSlots(), wallet);
      setPrepared(nextPrepared);
      setStatus("ready");
    } catch (cause) {
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function signAndInitialize() {
    if (!prepared || !walletSigner) return;
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
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const isAuthority = config?.authority === wallet;

  return (
    <section className="protocol-layout">
      <div className="dashboard-card protocol-form-card">
        <div className="dashboard-card-heading">
          <div><span className="section-kicker">PROTOCOL CONFIG</span><h2>{config ? "Configuration is live" : "Initialize the protocol"}</h2></div>
          <span className={`state-pill ${config ? "ok" : ""}`}><i /> {config ? "On-chain" : "Not initialized"}</span>
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
        {config ? <div className="asset-status-list">{assets.length ? assets.map((asset) => <div className="asset-status-row" key={asset.mint}><span className="asset-status-icon">{asset.enabled ? "✓" : "!"}</span><span><strong>{shortAddress(asset.mint)}</strong><small>{asset.tokenProgram ? (asset.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "Classic SPL Token") : "Not registered"}{asset.decimals === undefined ? "" : ` · ${asset.decimals} decimals`}</small></span><em className={asset.enabled ? "asset-enabled" : "asset-disabled"}>{asset.enabled ? "Enabled" : asset.registered ? "Disabled" : "Not registered"}</em></div>) : <div className="review-empty"><div className="empty-icon">◌</div><p>Reading asset registry…</p></div>}</div> : prepared ? <><div className="review-list"><div><span>Protocol settings</span><strong className="mono">{shortAddress(deriveConfigAddress(PROGRAM_ID))}</strong></div><div><span>Setup actions</span><strong>{prepared.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="state-box"><p>This transaction will be submitted directly to Devnet after wallet approval. Success is reported only from finalized on-chain state.</p></div><button className="button button-dark full-button" onClick={() => void signAndInitialize()} disabled={status === "signing" || !walletSigner}>{status === "signing" ? "Waiting for wallet…" : "Approve setup"} <Arrow /></button>{signature && <div className="success-box"><span>✓</span><div><b>Protocol initialized</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a></div></div>}</> : <div className="review-empty"><div className="empty-icon">◌</div><p>Review the mint list before direct Devnet submission.</p></div>}
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
  expiresAtSlot: string;
  maxPaymentCount: string;
  cooldownSlots: string;
  tokenProgram: TokenProgram;
};

function MandateBuilder({ wallet, walletSigner, walletMessageSigner, stablecoinOptions, protocolConfig, onCreated, onOpenPayments }: { wallet: string; walletSigner?: (transaction: Transaction) => Promise<Transaction>; walletMessageSigner?: (message: Uint8Array) => Promise<Uint8Array>; stablecoinOptions: StablecoinOption[]; protocolConfig: ProtocolConfig | null; onCreated: (mandateAddress: string) => Promise<void>; onOpenPayments: () => void }) {
  const defaultStablecoin = stablecoinOptions.find((option) => option.mint === DEVNET_USDC_MINT)
    ?? stablecoinOptions.find((option) => option.mint === DEVNET_PYUSD_TOKEN_2022_MINT)
    ?? stablecoinOptions[0]
    ?? { value: "", label: "No enabled asset", detail: "Register and enable an asset first", mint: "", tokenProgram: "spl-token" as const };
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
    expiresAtSlot: "",
    maxPaymentCount: "0",
    cooldownSlots: "0",
    tokenProgram: defaultStablecoin.tokenProgram,
  });
  const { estimate: slotEstimate, status: slotEstimateStatus } = useSlotEstimate();
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);
  const [slotEdited, setSlotEdited] = useState(false);
  const [signingMode, setSigningMode] = useState<"human" | "delegated">("human");
  const [mandateNonce, setMandateNonce] = useState(() => createMandateNonce());
  const [managedSigner, setManagedSigner] = useState<ManagedSigner | null>(null);
  const [managedSignerStatus, setManagedSignerStatus] = useState<"idle" | "provisioning" | "ready" | "error">("idle");
  const [stablecoin, setStablecoin] = useState(defaultStablecoin.value);
  const [prepared, setPrepared] = useState<PreparedMandate | null>(null);
  const [status, setStatus] = useState<"idle" | "building" | "ready" | "signing" | "pending" | "success" | "error">("idle");
  useSettlementFormStatus(wallet, setStatus);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [pdaCopied, setPdaCopied] = useState(false);
  const [accountSignature, setAccountSignature] = useState("");
  const [accountSetup, setAccountSetup] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [mintDecimals, setMintDecimals] = useState<number | null>(null);

  useEffect(() => {
    if (!defaultStablecoin.mint || stablecoinOptions.some((option) => option.value === stablecoin)) return;
    setStablecoin(defaultStablecoin.value);
    setForm((current) => ({
      ...current,
      allowedMint: defaultStablecoin.mint,
      tokenProgram: defaultStablecoin.tokenProgram,
      sourceTokenAccount: deriveAssociatedTokenAddress(wallet, defaultStablecoin.mint, defaultStablecoin.tokenProgram),
    }));
  }, [defaultStablecoin.mint, defaultStablecoin.tokenProgram, defaultStablecoin.value, stablecoin, stablecoinOptions, wallet]);

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

  useEffect(() => {
    let active = true;
    void chainpayClient.getCurrentSlot().then((slot) => {
      if (active) setCurrentSlot(slot);
    }).catch(() => {
      if (active) setCurrentSlot(null);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (slotEdited || !currentSlot || !slotEstimate) return;
    const extra = estimatedSlotsForDays(Number(form.expiresInDays), slotEstimate);
    if (extra === null) return;
    const nextSlot = (currentSlot + extra).toString();
    setForm((current) => current.expiresAtSlot === nextSlot ? current : { ...current, expiresAtSlot: nextSlot });
  }, [currentSlot, form.expiresInDays, slotEdited, slotEstimate]);

  function updateField(field: keyof MandateForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setPrepared(null);
    setSignature("");
    if (status !== "idle") setStatus("idle");
    setError("");
  }

  function updateStablecoin(value: string) {
    const option = stablecoinOptions.find((candidate) => candidate.value === value);
    if (!option || !option.mint) {
      setError("Select an enabled mint from the ChainPay SupportedAsset registry.");
      return;
    }
    setStablecoin(option.value);
    const sourceTokenAccount = deriveAssociatedTokenAddress(wallet, option.mint, option.tokenProgram);
    setMandateNonce(createMandateNonce());
    setManagedSigner(null);
    setManagedSignerStatus("idle");
    setForm((current) => ({ ...current, approvedAgent: signingMode === "human" ? wallet : "", allowedMint: option.mint, tokenProgram: option.tokenProgram, sourceTokenAccount }));
    setAccountSetup("idle");
    setPrepared(null);
    setSignature("");
    setAccountSignature("");
    setStatus("idle");
    setError("");
  }

  function selectSigningMode(mode: "human" | "delegated") {
    setSigningMode(mode);
    setPrepared(null);
    setSignature("");
    setError("");
    setStatus("idle");
    if (mode === "human") {
      setManagedSigner(null);
      setManagedSignerStatus("idle");
      setForm((current) => ({ ...current, approvedAgent: wallet }));
      return;
    }
    setMandateNonce(createMandateNonce());
    setManagedSigner(null);
    setManagedSignerStatus("idle");
    setForm((current) => ({ ...current, approvedAgent: "" }));
  }

  async function setupManagedSigner() {
    if (!walletMessageSigner) {
      setManagedSignerStatus("error");
      setError("This wallet cannot sign the ownership message required for automatic payments. Choose a Wallet Standard wallet with message signing.");
      return;
    }
    if (!form.allowedMint.trim()) {
      setManagedSignerStatus("error");
      setError("Choose an enabled stablecoin before setting up automatic payments.");
      return;
    }
    setManagedSignerStatus("provisioning");
    setError("");
    setPrepared(null);
    try {
      const intendedMandate = deriveVersionedMandateAddress(wallet, form.allowedMint.trim(), mandateNonce, PROGRAM_ID);
      const signer = await provisionManagedSigner(wallet, intendedMandate, form.allowedMint.trim(), mandateNonce, walletMessageSigner);
      setManagedSigner(signer);
      setForm((current) => ({ ...current, approvedAgent: signer.public_key }));
      setManagedSignerStatus("ready");
    } catch (cause) {
      setManagedSignerStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
    setSignature("");
    try {
      if (mintDecimals === null) throw new Error("Token decimals are not available yet. Check the selected mint.");
      if (accountSetup !== "ready" || !form.sourceTokenAccount.trim()) throw new Error("Prepare the source token account before continuing.");
      if (signingMode === "human" && form.approvedAgent.trim() !== wallet) {
        throw new Error("The payment signer must match the connected wallet in approval mode.");
      }
      const intendedMandate = deriveVersionedMandateAddress(wallet, form.allowedMint.trim(), mandateNonce, PROGRAM_ID);
      if (signingMode === "delegated" && (
        !managedSigner
        || managedSignerStatus !== "ready"
        || managedSigner.mandate_pda !== intendedMandate
        || form.approvedAgent.trim() !== managedSigner.public_key
      )) {
        throw new Error("Set up the secure automatic-payment signer for this mandate first.");
      }
      const expirySlot = parseExpirySlot(form.expiresAtSlot);
      const latestSlot = await chainpayClient.getCurrentSlot();
      setCurrentSlot(latestSlot);
      if (expirySlot <= latestSlot) throw new Error("The expiry slot must be after the current cluster slot.");
      const input = {
        approvedAgent: form.approvedAgent.trim(),
        sourceTokenAccount: form.sourceTokenAccount.trim(),
        allowedMint: form.allowedMint.trim(),
        maxPerPayment: parseTokenAmount(form.maxPerPayment, mintDecimals),
        totalLimit: parseTokenAmount(form.totalLimit, mintDecimals),
        expiresAtSlot: expirySlot,
        maxPaymentCount: BigInt(form.maxPaymentCount),
        cooldownSlots: BigInt(form.cooldownSlots),
        tokenProgram: form.tokenProgram,
        mandateNonce,
      };
      const nextPrepared = await chainpayClient.buildCreateMandate(input, wallet);
      if (nextPrepared.mandateAddress !== intendedMandate) {
        throw new Error("Prepared mandate does not match the signer enrollment challenge.");
      }
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
      setPrepared(nextPrepared);
      setStatus("ready");
    } catch (cause) {
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function signAndCreate() {
    if (!prepared) return;
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
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function copyMandatePda() {
    if (!prepared) return;
    copyValue(prepared.mandateAddress);
    setPdaCopied(true);
    window.setTimeout(() => setPdaCopied(false), 2200);
  }

  const selectedStablecoin = stablecoinOptions.find((option) => option.value === stablecoin) ?? defaultStablecoin;

  return (
    <section className="mandate-builder-layout">
      <div className="dashboard-card mandate-builder">
        <div className="dashboard-card-heading">
          <div><span className="section-kicker">NEW MANDATE</span><h2>Set agent spending</h2></div>
          <span className="network-chip"><i /> Devnet</span>
        </div>
        <p className="builder-intro">Choose the asset, spending limits, and whether your wallet approves every payment or lets ChainPay pay automatically inside those limits.</p>
        <p className="owner-setup-distinction">{LOGIN_VS_APPROVAL} Reviewing this form does not spend funds.</p>
        <div className="mandate-mode-selector" role="radiogroup" aria-label="Payment signing mode">
          <button type="button" role="radio" aria-checked={signingMode === "human"} className={signingMode === "human" ? "is-selected" : ""} onClick={() => selectSigningMode("human")}><strong>Approve each payment</strong><small>Human signing: your connected wallet confirms every payment.</small></button>
          <button type="button" role="radio" aria-checked={signingMode === "delegated"} className={signingMode === "delegated" ? "is-selected" : ""} onClick={() => selectSigningMode("delegated")}><strong>Automatic payments</strong><small>Delegated signing: you approve the mandate once. Later payments use the provisioned signer inside these limits — not a fresh owner signature each time.</small></button>
        </div>
        <div className="builder-grid simple-mandate-grid">
          <TextInput className="field-wide" label="Payment approval" value={signingMode === "human" ? wallet : managedSigner?.public_key ?? "Set up automatic payments below"} isReadOnly description={signingMode === "human" ? "Payments will ask for confirmation in your connected wallet." : "Your wallet approves the spending rules once. ChainPay can then pay only within them."} />
          <Selector
            className="field-wide"
            label="Stablecoin"
            value={stablecoin}
            onChange={updateStablecoin}
            options={stablecoinOptions.length ? stablecoinOptions.map((option) => ({ value: option.value, label: `${option.label} · ${option.detail}` })) : [{ value: "", label: "No enabled registry assets" }]}
          />
          <TextInput label="Max per payment" value={form.maxPerPayment} onChange={(value) => updateField("maxPerPayment", value)} placeholder="10" description="Exact token amount. Extra decimal places are rejected." />
          <TextInput label="Total spend limit" value={form.totalLimit} onChange={(value) => updateField("totalLimit", value)} placeholder="11" description="Exact token amount. Extra decimal places are rejected." />
          <Selector
            className="field-wide"
            label="Expires in"
            value={form.expiresInDays}
            onChange={(value) => { setSlotEdited(false); updateField("expiresInDays", value); }}
            options={[
              { value: "1", label: "1 day" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
            description={slotEstimateStatus === "unavailable"
              ? "Slot duration estimate unavailable. Enter the exact expiry slot below."
              : "Day length is estimated from one recent cluster performance sample. Review the exact slot before approval."}
          />
          <TextInput
            className="field-wide"
            label="Exact expiry slot"
            value={form.expiresAtSlot}
            onChange={(value) => { setSlotEdited(true); updateField("expiresAtSlot", value); }}
            placeholder={currentSlot ? (currentSlot + 1n).toString() : "Current slot unavailable"}
            description={slotEstimate
              ? `Estimated from one getRecentPerformanceSamples result. Current slot ${currentSlot?.toString() ?? "unavailable"}.`
              : "Enter the exact expiry slot. Estimates are unavailable until a performance sample can be read."}
          />
        </div>
        <details className="technical-details mandate-advanced-limits">
          <summary>Advanced limits</summary>
          <div className="builder-grid simple-mandate-grid">
            <TextInput label="Maximum payment count" value={form.maxPaymentCount} onChange={(value) => updateField("maxPaymentCount", value)} description="0 means no payment-count limit." />
            <TextInput label="Cooldown slots" value={form.cooldownSlots} onChange={(value) => updateField("cooldownSlots", value)} description="Minimum slots between payments. 0 means no cooldown." />
          </div>
        </details>
        {signingMode === "delegated" && <div className="account-setup-row"><div><span>Secure automatic-payment wallet</span><small>{managedSignerStatus === "ready" ? "Created by ChainPay" : managedSignerStatus === "provisioning" ? "Waiting for wallet authorization" : "Needs setup"}</small></div><button className="inline-action" type="button" onClick={() => void setupManagedSigner()} disabled={managedSignerStatus === "provisioning" || managedSignerStatus === "ready"}>{managedSignerStatus === "provisioning" ? "Setting up…" : managedSignerStatus === "ready" ? "Ready" : "Set up securely"}</button></div>}
        {signingMode === "delegated" && managedSigner && <div className="success-box"><span>✓</span><div><b>Automatic-payment wallet ready</b><button type="button" className="copy-id" onClick={() => copyValue(managedSigner.public_key)}>Send Devnet SOL for transaction fees to {shortAddress(managedSigner.public_key)} ⧉</button></div></div>}
        <div className="account-identity-card"><div><span>Connected owner wallet</span><strong>{wallet}</strong></div><div><span>{selectedStablecoin.label} source token account</span><strong>{form.sourceTokenAccount || "Select an enabled mint"}</strong></div>{signingMode === "delegated" && <div><span>Automatic-payment wallet</span><strong>{managedSigner?.public_key ?? "Not created yet"}</strong></div>}<small>Your {selectedStablecoin.label} stays in your token account. The automatic-payment wallet holds only Devnet SOL for fees and can spend tokens only through this mandate.</small></div>
        <div className="account-setup-row"><div><span>Source token account</span><small>{accountSetup === "ready" ? "Ready" : accountSetup === "working" ? "Checking token account" : "Needs setup"}</small></div><button className="inline-action" type="button" onClick={() => void setupWalletTokenAccount()} disabled={accountSetup === "working"}>{accountSetup === "working" ? "Checking…" : accountSetup === "ready" ? "Ready" : "Prepare token account"}</button></div>
        {accountSetup === "ready" && <div className="success-box"><span>✓</span><div><b>{accountSignature ? "Source token account prepared" : "Source token account ready"}</b><a href={accountSignature ? `https://explorer.solana.com/tx/${accountSignature}?cluster=devnet` : `https://explorer.solana.com/address/${form.sourceTokenAccount}?cluster=devnet`} target="_blank" rel="noreferrer">{accountSignature ? "View account transaction" : "View token account"} <Arrow /></a></div></div>}
        <div className="builder-actions"><Button type="button" variant="primary" label={status === "building" ? "Reviewing…" : "Review mandate"} isDisabled={status === "building" || status === "signing" || (signingMode === "delegated" && managedSignerStatus !== "ready")} onClick={() => void buildPreview()} /><span className="builder-safety"><Shield /> {signingMode === "human" ? "Wallet approval per payment" : "Mandate-limited automation"}</span></div>
        {error && <div className="builder-error"><b>Needs attention</b><span>{error}</span></div>}
      </div>

      <div className="dashboard-card review-card mandate-review-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">REVIEW</span><h2>{prepared ? "Ready for approval" : "Your mandate"}</h2></div><span className={`state-pill ${prepared ? "ok" : ""}`}><i /> {prepared ? "Ready to approve" : "Waiting"}</span></div>
        {prepared ? <>
          <p className="owner-setup-distinction">This review is not a login. Approving in your wallet is the financial action that creates the mandate.</p>
          <div className="mandate-summary"><div><span>Payment approval</span><strong>{signingMode === "human" ? "Human signing · confirm each payment" : "Delegated signing · automatic within limits"}</strong></div><div><span>Connected wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div><div><span>Payment signer</span><strong className="mono">{shortAddress(form.approvedAgent)}</strong></div><div><span>Stablecoin</span><strong>{selectedStablecoin.label} <small>{selectedStablecoin.detail}</small></strong></div><div><span>Recipient</span><strong>Chosen per payment</strong></div><div><span>Max per payment</span><strong className="mono">{mintDecimals === null ? form.maxPerPayment : reviewExactAmount(form.maxPerPayment, mintDecimals)}</strong></div><div><span>Total spend limit</span><strong className="mono">{mintDecimals === null ? form.totalLimit : reviewExactAmount(form.totalLimit, mintDecimals)}</strong></div><div><span>Expires</span><strong className="mono">{slotEstimate ? `Estimated · slot ${form.expiresAtSlot}` : `Slot ${form.expiresAtSlot}`}</strong></div><div><span>Payment count / cooldown</span><strong className="mono">{form.maxPaymentCount === "0" ? "No count limit" : form.maxPaymentCount} · {form.cooldownSlots === "0" ? "No cooldown" : `${form.cooldownSlots} slots`}</strong></div></div>
          <details className="technical-details"><summary>Transaction details</summary><div className="review-list"><div><span>Mandate address</span><strong className="mono">{shortAddress(prepared.mandateAddress)}</strong></div><div><span>Policy actions</span><strong>{prepared.transaction.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="state-box"><p>After wallet approval, Axum submits this transaction directly and verifies finalized chain state.</p></div></details>
          <Button type="button" variant="primary" label={status === "signing" ? "Waiting for wallet…" : status === "success" ? "Mandate created" : "Approve & create mandate"} isDisabled={status === "signing" || status === "pending" || status === "success"} onClick={() => void signAndCreate()} />
          {signature && <div className="mandate-created-callout"><div className="mandate-created-heading"><span>✓</span><div><b>Mandate created on Devnet</b><small>{signingMode === "human" ? "Your policy is ready for a wallet-approved payment." : "Your policy is ready for autonomous agent payments inside its limits."}</small></div></div><div className="mandate-pda-row"><div><span>Mandate PDA</span><strong>{prepared.mandateAddress}</strong></div><button type="button" className="button button-secondary-light button-small" onClick={copyMandatePda}>{pdaCopied ? "Copied" : "Copy PDA"}</button></div><div className="mandate-created-actions"><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a>{signingMode === "human" && <button type="button" className="button button-primary button-small" onClick={onOpenPayments}>Pay with this mandate <Arrow /></button>}</div></div>}
        </> : <div className="review-empty"><div className="empty-icon">◇</div><p>Review the mandate before signing.</p></div>}
      </div>
    </section>
  );
}



export default function DashboardRoute(props: DashboardProps) {
  return <Dashboard {...props} />;
}
