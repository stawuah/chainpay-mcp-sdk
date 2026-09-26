import { SpendingAmountField } from "./SpendingAmountField";
import { TokenIcon } from "../ui/TokenIcon";
import { WalletBrandMark } from "../ui/WalletBrandMark";
import payshLogo from "../assets/brands/paysh.svg";
import x402Logo from "../assets/brands/x402-official.png";
import { ArrowLeft, ArrowRight, ArrowUpRight, Bot, Check, ChevronDown, Copy, Inbox, Menu, Plus, RefreshCw, Search, ReceiptText, Share2, ExternalLink, LogOut, CircleAlert, Settings2, ShieldCheck, Wallet, X } from "lucide-react";
import { OwnerOverview } from "./OwnerOverview";
import { TokenAddresses } from "./TokenAddresses";
import { PendingSettlements } from "../settlement";
import "./owner-dashboard.css";
import { BrandLogo } from "../brand/Brand";
import { useSidebarCollapse } from "./useSidebarCollapse";
import { useSettlementFormStatus, settlementPendingEvent, settlementTerminalEvent, listStoredOperations, type Operation, isPendingSettlement } from "../settlement";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, bytesToHex, createMandateNonce, deriveAssociatedTokenAddress, deriveConfigAddress, deriveMandateAddress, deriveReceiptAddress, deriveVersionedMandateAddress, formatExactTokenAmount, toWeb3Transaction } from "@chainpay/sdk";
import type { Mandate, PaymentReceipt, PreparedMandate, PreparedPayment, PreparedTransaction, TokenProgram } from "@chainpay/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";
import solWalletImage from "../assets/brands/solana.svg";
import { buildPath, type DashboardTab } from "../routing/paths";
import { useRoute } from "../routing/useRoute";
import { RecordDetails } from "../ui/RecordDetails";
import { InboxReceipt, LoadedReceiptCard } from "../receipts/InboxReceipt";
import { SampleReceiptOutline } from "../receipts/SampleReceiptOutline";
import { receiptViewFromSettledPayment, tokenLabelForMint } from "../receipts/load";
import { amountLabel, publicReceiptPath } from "../receipts/model";
import { sharePublicReceipt, shareStatusCopy } from "../receipts/share";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FileInput } from "@astryxdesign/core/FileInput";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Popover } from "@astryxdesign/core/Popover";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Arrow, Shield, shortAddress } from "../ui/marks";
import { DashboardMobileNav, DashboardNav } from "./DashboardNav";
import { PageHeader } from "./PageHeader";
import { SpendMeter } from "./charts/SpendMeter";
import { tabCopy } from "./tabCopy";
import { TOOL_GROUPS, requiredParams, toolGroup } from "./toolGroups";
import { reviewExactAmount } from "../owner/amounts";
import { buildConnectionScope, ownedMandateAddresses } from "../owner/connectionScope";
import { EmptyOwnerOverview } from "../owner/EmptyOwnerOverview";
import {
  attentionInboxItems,
  connectionIsLive,
  inboxAttentionCounts,
  preparedRequestReceiptAddresses,
  purchaseCardFromInboxItem,
} from "../owner/purchaseCard";
import { buildRecentActivity } from "../owner/recentActivity";
import { configuredDemoReceiptPath, FIRST_MANDATE_TITLE, LOGIN_VS_APPROVAL } from "../owner/onboarding";
import { PurchaseCard } from "./PurchaseCard";
import { describeWalletCapabilities, type WalletCapabilityReport } from "../wallet/capabilities";
import { loadWalletDrafts, saveWalletDrafts, type BatchCsvPayment } from "../wallet/draftStore";
import { chunkPreparedTransactions } from "../wallet/transactionChunks";
import { createRecipientTokenAccount, type RecipientAtaReview } from "../wallet/recipientAta";
import { estimatedSlotsForDays, mandateExpiryLabel, parseExpirySlot } from "../owner/slotEstimate";
import { retryRead } from "../owner/retryRead";
import { useOwnerSignIn } from "../owner/useOwnerSignIn";
import { useSlotEstimate } from "../owner/useSlotEstimate";
import { X402JobsPanel } from "../spend/X402JobsPanel";
import { catalogQuoteForProvider, fetchPayshCatalog, type PayshCatalogProvider } from "../spend/payshCatalog";
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
  type MandateAction,
  type MandateUpdateFields,
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
  archiveInboxItem,
  restoreInboxItem,
  isInboxItemArchived,
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
  buildMcpFirstPrompt,
  connectionAccessLabel,
  type McpConnectionHandoff,
} from "../owner/runtime";
import { pausedAfterMandateAction } from "../owner/mandateAction";

const demoReceiptHref = configuredDemoReceiptPath(import.meta.env.VITE_CHAINPAY_DEMO_RECEIPT_PDA);

export type DashboardProps = {
  wallet: string;
  walletName: string;
  walletIcon?: string;
  walletCapabilities?: WalletCapabilityReport | null;
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
  receiptDetail?: string;
  onTabChange: (tab: DashboardTab, options?: { mandateBuilder?: boolean; mandateDetail?: string; receiptDetail?: string }) => void;
  onNavigateHome: () => void;
  onRefresh: (preferredMandateAddress?: string) => Promise<void>;
  onSelectMandate: (mandate: Mandate) => void;
  onChangeAccount: () => void;
  onDisconnect: () => void;
  onChangeWallet: () => void;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
};

type WalletAssetSummary = {
  symbol: string;
  address: string;
  mint?: string;
  balance: string;
  exists: boolean;
  loading: boolean;
};

async function simulateTokenAccountCreation(transaction: Transaction) {
  const simulation = await chainpayClient.connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(`Token-account creation simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
}

export function Dashboard({
  wallet,
  walletName,
  walletIcon,
  walletCapabilities,
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
  receiptDetail,
  onTabChange,
  onNavigateHome,
}: DashboardProps) {
  const [mobileNav, setMobileNav] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse();
  const [prompt, setPrompt] = useState("Inspect my active mandate");
  const [reply, setReply] = useState("Ask ChainPay about your active mandate, receipt, or agent permissions.");
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [assistantHistory, setAssistantHistory] = useState<AgentHistoryItem[]>([]);
  const [agentToolsUsed, setAgentToolsUsed] = useState<string[]>([]);
  const voiceRecognition = useRef<SpeechRecognitionLike | null>(null);
  const [mandateDecimals, setMandateDecimals] = useState<number | null>(null);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [dangerStatus, setDangerStatus] = useState("");
  const ownerSignIn = useOwnerSignIn();
  const [mandateCreateOpen, setMandateCreateOpen] = useState(Boolean(mandateBuilder));
  useEffect(() => {
    setMandateCreateOpen(Boolean(mandateBuilder));
  }, [mandateBuilder]);
  const [demoPaymentRequest, setDemoPaymentRequest] = useState<Record<string, unknown> | undefined>();
  const [agentInbox, setAgentInbox] = useState<AgentInboxItem[]>([]);
  const [settlementHistory, setSettlementHistory] = useState<Operation[]>([]);
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
  const [hostedAssistantStatus, setHostedAssistantStatus] = useState<"unknown" | "available" | "unavailable">("unknown");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [walletAssets, setWalletAssets] = useState<WalletAssetSummary[]>([]);
  const [walletAssetRefresh, setWalletAssetRefresh] = useState(0);
  const [preparingWalletAsset, setPreparingWalletAsset] = useState("");
  const [walletAssetError, setWalletAssetError] = useState("");
  const [copiedWalletAddress, setCopiedWalletAddress] = useState("");
  const walletCopyTimer = useRef<number | null>(null);
  const toast = useToast();

  const spent = mandate ? formatTokenAmount(mandate.amountSpent, mandateDecimals) : "—";
  const solWalletAsset = walletAssets.find((asset) => asset.symbol === "SOL");
  const tokenWalletAssets = walletAssets.filter((asset) => asset.symbol !== "SOL");
  const walletAssetRegistryKey = stablecoinOptions
    .map((item) => `${item.mint}:${item.tokenProgram}:${item.label}`)
    .join("|");

  useEffect(() => {
    setAgentInbox(wallet ? loadAgentInbox(wallet) : []);
    setApprovalStatuses({});
    setApprovalErrors({});
    setSettlementHistory(wallet ? listStoredOperations().filter((operation) => operation.wallet === wallet) : []);
    if (!wallet) {
      setPrompt("");
      setReply("Ask ChainPay about your active mandate, receipt, or agent permissions.");
      setAssistantHistory([]);
      setAgentAttachments([]);
      return;
    }
    const assistantDraft = loadWalletDrafts(wallet).assistant;
    setPrompt(assistantDraft?.prompt ?? "Inspect my active mandate");
    setReply(assistantDraft?.reply ?? "Ask ChainPay about your active mandate, receipt, or agent permissions.");
    setAssistantHistory(assistantDraft?.history ?? []);
    setAgentAttachments(assistantDraft?.attachments ?? []);
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    saveWalletDrafts(wallet, {
      assistant: { prompt, reply, history: assistantHistory, attachments: agentAttachments },
    });
  }, [wallet, prompt, reply, assistantHistory, agentAttachments]);

  useEffect(() => {
    const refreshHistory = () => {
      setSettlementHistory(wallet ? listStoredOperations().filter((operation) => operation.wallet === wallet) : []);
    };
    window.addEventListener("chainpay.pending-operations.v1", refreshHistory);
    window.addEventListener(settlementTerminalEvent, refreshHistory);
    return () => {
      window.removeEventListener("chainpay.pending-operations.v1", refreshHistory);
      window.removeEventListener(settlementTerminalEvent, refreshHistory);
    };
  }, [wallet]);

  useEffect(() => () => {
    if (walletCopyTimer.current !== null) window.clearTimeout(walletCopyTimer.current);
  }, []);

  useEffect(() => {
    if (!walletMenuOpen) return;
    let active = true;
    const initialAssets: WalletAssetSummary[] = [
      { symbol: "SOL", address: wallet, balance: "—", exists: true, loading: true },
      ...stablecoinOptions.map((asset) => ({
        symbol: asset.label,
        mint: asset.mint,
        address: deriveAssociatedTokenAddress(wallet, asset.mint, asset.tokenProgram),
        balance: "—",
        exists: false,
        loading: true,
      })),
    ];
    setWalletAssets(initialAssets);

    async function loadWalletAssets() {
      try {
        const solPromise = chainpayClient.connection.getBalance(new PublicKey(wallet), "confirmed")
          .then((lamports): WalletAssetSummary => ({
            symbol: "SOL",
            address: wallet,
            balance: formatTokenAmount(BigInt(lamports), 9),
            exists: true,
            loading: false,
          }));
        const preparations = await chainpayClient.prepareRegisteredAssetTokenAccounts(wallet);
        const tokenPromises = preparations.map(async (preparation): Promise<WalletAssetSummary> => {
          const symbol = stablecoinOptions.find((asset) => asset.mint === preparation.mint)?.label
            ?? shortAddress(preparation.mint);
          if (preparation.status === "missing") {
            return { symbol, mint: preparation.mint, address: preparation.address, balance: "Not created", exists: false, loading: false };
          }
          const balance = await chainpayClient.connection.getTokenAccountBalance(new PublicKey(preparation.address), "confirmed");
          return { symbol, mint: preparation.mint, address: preparation.address, balance: balance.value.uiAmountString ?? balance.value.amount, exists: true, loading: false };
        });
        const [solState, tokenStates] = await Promise.all([
          Promise.allSettled([solPromise]).then(([state]) => state),
          Promise.allSettled(tokenPromises),
        ]);
        if (!active) return;
        const solAsset = solState.status === "fulfilled" ? solState.value : {
          ...initialAssets[0],
          balance: "Unavailable",
          loading: false,
        };
        const tokenAssets = tokenStates.map((state, index) => {
          if (state.status === "fulfilled") return state.value;
          const preparation = preparations[index];
          return {
            symbol: stablecoinOptions.find((asset) => asset.mint === preparation.mint)?.label ?? shortAddress(preparation.mint),
            mint: preparation.mint,
            address: preparation.address,
            balance: "Unavailable",
            exists: preparation.status === "ready",
            loading: false,
          };
        });
        setWalletAssets([solAsset, ...tokenAssets]);
      } catch {
        if (!active) return;
        setWalletAssets(initialAssets.map((asset) => ({ ...asset, balance: "Unavailable", loading: false })));
      }
    }
    void loadWalletAssets();
    return () => { active = false; };
  }, [wallet, walletAssetRefresh, walletAssetRegistryKey, walletMenuOpen]);

  async function prepareWalletAssetAccount(asset: WalletAssetSummary) {
    if (!asset.mint || asset.exists) return;
    setPreparingWalletAsset(asset.mint);
    setWalletAssetError("");
    try {
      if (!walletSigner) throw new Error("The connected wallet cannot sign the account-creation transaction.");
      const preparation = await chainpayClient.prepareAssociatedTokenAccount({
        owner: wallet,
        payer: wallet,
        mint: asset.mint,
      });
      if (preparation.status === "ready") {
        setWalletAssetRefresh((value) => value + 1);
        return;
      }
      if (!preparation.transaction) throw new Error("The SDK did not return an account-creation transaction.");
      const balance = await chainpayClient.connection.getBalance(new PublicKey(wallet), "confirmed");
      if (balance === 0) throw new Error("Add Devnet SOL to this wallet before creating a token account.");
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(preparation.transaction, latest.blockhash);
      await simulateTokenAccountCreation(transaction);
      const signed = await walletSigner(transaction);
      await submitSignedTransaction(`ata:${wallet}:${preparation.address}:${latest.blockhash}`, signed.serialize());
      setWalletAssetRefresh((value) => value + 1);
    } catch (cause) {
      setWalletAssetError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreparingWalletAsset("");
    }
  }

  useEffect(() => {
    if (wallet) persistAgentInbox(wallet, agentInbox);
  }, [agentInbox, wallet]);

  async function copyWalletAddress(address: string) {
    if (!await copyValue(address)) {
      toast({ body: "Could not copy the address.", type: "error" });
      return;
    }
    setCopiedWalletAddress(address);
    toast({ body: "Address copied", uniqueID: "wallet-copy", isAutoHide: true, autoHideDuration: 1800 });
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
    if (ownerSignIn.status !== "ready") { setConnections([]); setConnectionStatus("idle"); return; }
    setConnectionStatus("loading");
    const refreshConnections = async () => {
      try {
        const nextConnections = await fetchMcpConnections(wallet);
        if (active) setConnections(nextConnections.map((connection) => ({
          ...connection,
          mandates: connectionScopeDetails(connection.scope).count,
        })));
        if (active) setConnectionStatus("ready");
      } catch {
        if (active) setConnectionStatus("error");
      }
    };
    void refreshConnections();
    const interval = window.setInterval(() => void refreshConnections(), 8_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [wallet, ownerSignIn.status]);

  function updateAgentInboxItem(id: string, patch: Partial<AgentInboxItem>) {
    setAgentInbox((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function archiveInboxItemById(id: string) {
    setAgentInbox((current) => archiveInboxItem(current, id));
  }

  function restoreInboxItemById(id: string) {
    setAgentInbox((current) => restoreInboxItem(current, id));
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
    const requirements = (prepared?.requirements ?? quote?.requirements) as AgentRequirements | undefined;
    if (preparedResult.isError || !prepared?.transaction || !prepared.payment) {
      return {
        message: toolText(preparedResult),
        toolCalls: ["verify_payment_request", "quote_payment_request", "prepare_payment"],
        outcome: {
          kind: "payment_blocked",
          receiptAddress: typeof prepared?.receiptAddress === "string" ? prepared.receiptAddress : undefined,
          status: "blocked",
        },
        ...(requirements ? { requirements } : {}),
      };
    }
    return {
      message: "The signed request is verified and all five policy checks passed. The payment is prepared and waiting for your wallet approval in Phantom. It has not been submitted.",
      toolCalls: ["verify_payment_request", "quote_payment_request", "prepare_payment"],
      approval: { kind: "payment", ...prepared } as AgentApproval,
      outcome: { kind: "payment_approval_required", receiptAddress: typeof prepared.receiptAddress === "string" ? prepared.receiptAddress : undefined, status: "ready" },
      ...(requirements ? { requirements } : {}),
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
      setHostedAssistantStatus("available");
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
      const message = error instanceof Error ? error.message : "request failed";
      if (/not configured|503|OPENROUTER|assistant unavailable/i.test(message)) {
        setHostedAssistantStatus("unavailable");
      }
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
      const transaction = toWeb3Transaction(prepared, latest.blockhash);
      if (agentApproval.kind === "token_account") await simulateTokenAccountCreation(transaction);
      const signed = await walletSigner(transaction);
      if (agentApproval.kind === "mandate") {
        const result = await submitSignedTransaction(`agent-mandate:${agentApproval.mandateAddress ?? latest.blockhash}:${latest.blockhash}`, signed.serialize());
        const response = `Mandate approved${result.signature ? ` (${shortAddress(result.signature)})` : ""}. The agent can now use this policy within the limits you approved without another wallet prompt.`;
        setApprovalStatuses((current) => ({ ...current, [inboxId]: "success" }));
        setReply(response);
        updateAgentInboxItem(inboxId, { response, stage: "approved", approval: undefined });
        await onRefresh(agentApproval.mandateAddress);
        if (result.signature) setAgentToolsUsed((current) => [...current, "wallet_approval"]);
      } else if (agentApproval.kind === "token_account") {
        if (typeof agentApproval.tokenAccount !== "string" || typeof agentApproval.mint !== "string") {
          throw new Error("The token-account approval is missing its mint or canonical account address.");
        }
        const result = await submitSignedTransaction(
          `agent-ata:${wallet}:${agentApproval.tokenAccount}:${latest.blockhash}`,
          signed.serialize(),
        );
        const response = `Token account created${result.signature ? ` (${shortAddress(result.signature)})` : ""}. It can now receive this asset, but it still needs a token balance before it can send payments.`;
        setApprovalStatuses((current) => ({ ...current, [inboxId]: "success" }));
        setReply(response);
        updateAgentInboxItem(inboxId, { response, stage: "approved", approval: undefined });
        setAgentToolsUsed((current) => [...current, "wallet_approval", "prepare_token_accounts"]);
        setWalletAssetRefresh((value) => value + 1);
        await onRefresh();
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

  const revocableMandateCount = mandates.filter((value) => value.owner === wallet && value.status !== "revoked").length;

  async function revokeAllMandates() {
    setDangerStatus("");
    const revocableMandates = mandates.filter((value) => value.owner === wallet && value.status !== "revoked");
    if (!revocableMandates.length) {
      setDangerStatus("There are no mandates to revoke for this wallet.");
      return;
    }
    if (!walletSigner) {
      setDangerStatus("The connected wallet does not expose transaction signing.");
      return;
    }
    try {
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const chunks = chunkPreparedTransactions(
        revocableMandates.map((value) => chainpayClient.buildRevokeMandate(wallet, value.address)),
        latest.blockhash,
      );
      let revoked = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        const signed = await walletSigner(toWeb3Transaction(chunks[index], latest.blockhash));
        await submitSignedTransaction(`revoke-all:${wallet}:${index}:${latest.blockhash}`, signed.serialize());
        revoked += chunks[index].instructions.length;
      }
      await onRefresh();
      setDangerStatus(chunks.length > 1
        ? `${revoked} mandate${revoked === 1 ? "" : "s"} revoked in ${chunks.length} wallet transactions.`
        : `${revoked} mandate${revoked === 1 ? "" : "s"} revoked.`);
    } catch (cause) {
      setDangerStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function runMandateAction(action: MandateAction, targetMandate: Mandate = mandate ?? mandates[0], updateFields?: MandateUpdateFields) {
    if (!targetMandate) throw new Error("There is no mandate to update.");
    if (!walletSigner) throw new Error("The connected wallet does not expose transaction signing.");
    const prepared = action === "pause"
      ? chainpayClient.buildPauseMandate(wallet, targetMandate.address)
      : action === "revoke"
        ? chainpayClient.buildRevokeMandate(wallet, targetMandate.address)
        : chainpayClient.buildUpdateMandate({
          approvedAgent: targetMandate.approvedAgent,
          maxPerPayment: updateFields?.maxPerPayment ?? targetMandate.maxPerPayment,
          totalLimit: updateFields?.totalLimit ?? targetMandate.totalLimit,
          expiresAtSlot: updateFields?.expiresAtSlot ?? targetMandate.expiresAtSlot,
          maxPaymentCount: updateFields?.maxPaymentCount ?? targetMandate.maxPaymentCount,
          cooldownSlots: updateFields?.cooldownSlots ?? targetMandate.cooldownSlots,
          paused: pausedAfterMandateAction(action, targetMandate.status),
        }, wallet, targetMandate.address);
    const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
    const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
    await submitSignedTransaction(`${action}-mandate:${targetMandate.address}:${latest.blockhash}`, signed.serialize());
    await onRefresh(targetMandate.address);
  }

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

  function closeMandateBuilder() {
    setMandateCreateOpen(false);
    onTabChange("mandates");
  }

  const mandateLoadStatus: "idle" | "loading" | "ready" | "error" = integrationStatus === "loading"
    ? "loading"
    : integrationStatus === "error"
      ? "error"
      : "ready";

  const inboxCounts = inboxAttentionCounts(agentInbox);
  const attentionItems = attentionInboxItems(agentInbox);
  const preparedReceiptAddresses = preparedRequestReceiptAddresses(agentInbox);
  const recentActivity = buildRecentActivity(agentInbox, settlementHistory);
  const liveConnectionCount = connections.filter((connection) => connectionIsLive(connection.lastSeenAt)).length;
  const mandateApproved = mandates.some((item) => item.owner === wallet && item.status !== "revoked");
  const agentPaired = connections.length > 0 || hostedAssistantStatus === "available";
  const agentsTabActive = tab === "agents" || tab === "connect-mcp";

  const dashboardNav = {
    tab: (agentsTabActive ? "agents" : tab) as DashboardTab,
    approvalCount: inboxCounts.waiting,
    toolCount: mcpTools.length,
    onSelect: selectTab,
    onNavigateHome,
  };

  return (
    <div className="dashboard-app cp-app">
      <DashboardMobileNav isOpen={mobileNav} onOpenChange={setMobileNav} {...dashboardNav} />
      <div className={`dashboard-layout${sidebarCollapsed ? " is-rail" : ""}`}>
        <aside className="dashboard-sidebar">
          <DashboardNav {...dashboardNav} collapsed={sidebarCollapsed} onToggleCollapsed={toggleSidebar} />
        </aside>

        <main className="dashboard-main" id="dashboard">
          <header className="dashboard-topbar">
            <div className="dashboard-topbar-left">
              <IconButton className="dashboard-menu-button" type="button" variant="ghost" label="Open dashboard navigation" icon={<Menu size={20} />} onClick={() => setMobileNav(true)} />
              <div className="owner-breadcrumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{tabCopy(tab, { hasMandates: true, mandateCreateOpen: false }).title}</strong></div>
            </div>
            <div className="dashboard-top-actions">
              <span className={`dashboard-network ${integrationStatus}`}>
                <i /> {integrationStatus === "loading" ? "Syncing" : integrationStatus === "error" ? "Needs attention" : "Solana Devnet"}
              </span>
              {ownerSignIn.status !== "ready" && (
                <Button
                  type="button"
                  variant="secondary"
                  className="topbar-signin"
                  label={ownerSignIn.status === "signing" ? "Waiting for login message…" : "Sign in"}
                  isDisabled={ownerSignIn.status === "signing"}
                  onClick={() => void ownerSignIn.signIn()}
                />
              )}
              <div className="wallet-menu">
                <Popover
                  isOpen={walletMenuOpen}
                  onOpenChange={setWalletMenuOpen}
                  label="Connected wallet assets"
                  placement="below"
                  alignment="end"
                  width={300}
                  content={(
                    <section className="wallet-asset-popover">
                      <div className="wallet-asset-header"><div className="wallet-asset-heading"><WalletBrandMark name={walletName} icon={walletIcon} size={28} /><div><span className="soft-label">CONNECTED WALLET</span><strong>{walletName}</strong></div></div><span className="wallet-network-pill"><i /> Devnet</span></div>
                      <button type="button" className="wallet-owner-address" onClick={() => void copyWalletAddress(wallet)} title="Copy connected wallet address"><span><strong>{shortAddress(wallet)}</strong><small>{copiedWalletAddress === wallet ? "Address copied" : "Copy wallet address"}</small></span><Copy size={16} /></button>
                      <div className="wallet-asset-list">{walletAssets.map((asset) => <div className="owner-wallet-asset" key={asset.mint ?? "SOL"}>{asset.mint ? <TokenIcon mint={asset.mint} size={24} /> : <img src={solWalletImage} alt="" />}<span>{asset.symbol}</span><span className="owner-wallet-asset-state"><strong>{asset.loading ? "Loading…" : asset.balance}</strong>{asset.mint && !asset.loading && !asset.exists && <button type="button" disabled={Boolean(preparingWalletAsset)} onClick={() => void prepareWalletAssetAccount(asset)}>{preparingWalletAsset === asset.mint ? "Waiting for wallet…" : "Create account"}</button>}</span></div>)}</div>
                      {walletAssetError && <p className="wallet-asset-error" role="alert">{walletAssetError}</p>}
                      <div className="wallet-asset-actions">
                        <Button type="button" variant="secondary" label={switchingWalletAccount ? "Opening wallet…" : "Change account"} isDisabled={switchingWalletAccount} onClick={() => { setWalletMenuOpen(false); onChangeAccount(); }} />
                        <Button type="button" variant="secondary" label="Change wallet" isDisabled={false} onClick={() => { setWalletMenuOpen(false); onChangeWallet(); }} />
                      </div>
                    </section>
                  )}
                >
                  <Button
                    type="button"
                    variant="secondary"
                    className="wallet-chip"
                    label={switchingWalletAccount ? `Opening ${walletName}…` : `${walletName} · ${shortAddress(wallet)}`}
                    icon={<WalletBrandMark name={walletName} icon={walletIcon} size={18} fallback />}
                    endContent={<ChevronDown size={16} />}
                  />
                </Popover>
              </div>
            </div>
          </header>
          <div className="dashboard-page">
          <PageHeader
            copy={tabCopy(tab, { hasMandates: mandates.length > 0, mandateCreateOpen })}
            action={
              ["tools", "protocol", "connect-mcp"].includes(tab) ? <Button label="Back to settings" variant="secondary" icon={<ArrowLeft size={16} />} onClick={() => { setAdvancedSettingsOpen(true); selectTab("settings"); }} />
              : tab === "overview" && mandates.length === 0 ? null
              : tab === "overview" || tab === "mandates" ? (
                mandateCreateOpen
                  ? <Button type="button" variant="secondary" className="refresh-button" label="Back to permissions" icon={<ArrowLeft size={16} />} isDisabled={false} onClick={closeMandateBuilder} />
                  : <Button type="button" variant="primary" className="overview-new-mandate" label="New permission" icon={<Plus size={18} />} isDisabled={false} onClick={openMandateCreate} />
              )
              // Receipts carries its own scoped Refresh on the settlement-history
              // card. A second, identical-looking page-level button next to it
              // refreshed mandates instead, which read as a duplicate.
              : ["receipts", "payments", "settings", "assistant", "agents", "connect-mcp"].includes(tab) ? null
              : <Button type="button" variant="secondary" className="refresh-button" label="Refresh" icon={<RefreshCw size={16} />} isDisabled={integrationStatus === "loading"} onClick={() => void onRefresh()} />
            }
          />

          {ownerSignIn.status !== "ready" && (mandates.length > 0 || tab !== "overview") && (
            <div className="cp-workspace-signin is-compact">
              <div><p>Sign in to load agent tools. A login message is not a spending approval.</p></div>
              {ownerSignIn.error && <p role="alert">{ownerSignIn.error}</p>}
            </div>
          )}
          {integrationStatus === "error" && mandates.length > 0 && <div className="builder-error" role="alert"><b>Some information could not be refreshed</b><span>{integrationError}</span><Button label="Try again" variant="secondary" onClick={() => void onRefresh()} /></div>}
          <PendingSettlements wallet={wallet} />


          <div>{tab === "assistant" ? <AssistantPanel prompt={prompt} setPrompt={setPrompt} reply={reply} thinking={thinking} listening={listening} agentToolsUsed={agentToolsUsed} inbox={agentInbox} approvalStatuses={approvalStatuses} approvalErrors={approvalErrors} attachments={agentAttachments} attachmentError={attachmentError} stablecoinOptions={stablecoinOptions} mandateDecimals={mandateDecimals} mandate={mandate} sessionReady={ownerSignIn.status === "ready"} onSignIn={() => void ownerSignIn.signIn()} onAsk={() => void askChainPay()} onVoice={startVoice} onLoadDemoInvoice={() => void loadDemoPaymentRequest()} onApprove={approveAgentRequest} onAddAttachments={addAgentAttachments} onRemoveAttachment={removeAgentAttachment} onArchive={archiveInboxItemById} onRestore={restoreInboxItemById} onCallMcp={onCallMcp} /> : tab === "protocol" ? <ProtocolPanel wallet={wallet} walletSigner={walletSigner} config={protocolConfig} onCreated={onRefresh} /> : tab === "mandates" ? <MandatesPanel wallet={wallet} walletSigner={walletSigner} walletMessageSigner={walletMessageSigner} mandates={mandates} mandate={mandate} mandateDecimals={mandateDecimals} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} loadStatus={mandateLoadStatus} createOpen={mandateCreateOpen} onCreateOpenChange={(open) => { if (open) openMandateCreate(); else closeMandateBuilder(); }} onMandateAction={runMandateAction} onSelectMandate={onSelectMandate} onOpenPayments={() => selectTab("payments")} onOpenAgents={() => selectTab("agents")} onRefresh={onRefresh} /> : tab === "payments" ? <PaymentsWorkspace wallet={wallet} history={<ReceiptPanel mandates={mandates} stablecoinOptions={stablecoinOptions} preparedReceiptAddresses={preparedReceiptAddresses} onCallMcp={onCallMcp} />} form={<PaymentPanel wallet={wallet} walletSigner={walletSigner} mandates={mandates} mandate={mandate} stablecoinOptions={stablecoinOptions} onSelectMandate={onSelectMandate} onCallMcp={onCallMcp} onAskAgent={(message) => { selectTab("assistant"); void askChainPay(message); }} onRefresh={onRefresh} onOpenMandateBuilder={openMandateCreate} onOpenAgents={() => selectTab("agents")} />} /> : agentsTabActive ? <AgentsTabPanel connectionStatus={connectionStatus} serverUrl={MCP_URL} wallet={wallet} mandates={mandates} stablecoinOptions={stablecoinOptions} connections={connections} hostedAssistantStatus={hostedAssistantStatus} connectDialogInitiallyOpen={tab === "connect-mcp"} onConnected={(connection) => setConnections((current) => [connection, ...current])} onRevoked={async (id) => { await revokeMcpConnection(wallet, id); setConnections((current) => current.filter((connection) => connection.id !== id)); }} onCreateMandate={openMandateCreate} onOpenAssistant={() => selectTab("assistant")} /> : tab === "receipts" ? <ReceiptPanel mandates={mandates} stablecoinOptions={stablecoinOptions} preparedReceiptAddresses={preparedReceiptAddresses} receiptDetail={receiptDetail} onCallMcp={onCallMcp} /> : tab === "tools" ? <ToolsPanel mcpTools={mcpTools} /> : tab === "settings" ? <SettingsPanel advancedOpen={advancedSettingsOpen} onAdvancedOpenChange={setAdvancedSettingsOpen} onAdvanced={(destination) => selectTab(destination)} wallet={wallet} walletName={walletName} walletIcon={walletIcon} walletCapabilities={walletCapabilities} stablecoinOptions={stablecoinOptions} activeMandateCount={revocableMandateCount} dangerStatus={dangerStatus} onRevokeAll={() => void revokeAllMandates()} onDisconnect={onDisconnect} onChangeWallet={onChangeWallet} /> : (
            <>
              {integrationStatus === "loading" ? (
                <section className="dashboard-card"><span className="section-kicker">LOADING PERMISSIONS</span><h2>Reading on-chain mandates…</h2><p className="t-body">ChainPay is discovering spending permissions for this wallet. First-run setup appears only after a successful read returns zero mandates.</p></section>
              ) : integrationStatus === "error" && mandates.length === 0 ? (
                <section className="dashboard-card" role="alert"><span className="section-kicker">PERMISSION DISCOVERY</span><h2>Could not load mandates.</h2><p className="t-body">{integrationError || "Try again in a moment."}</p><Button type="button" variant="secondary" label="Retry discovery" isDisabled={false} onClick={() => void onRefresh()} /></section>
              ) : mandates.length === 0 ? (
                <EmptyOwnerOverview
                  walletConnected
                  signedIn={ownerSignIn.status === "ready"}
                  signingIn={ownerSignIn.status === "signing"}
                  signInError={ownerSignIn.error}
                  mandateApproved={mandateApproved}
                  agentPaired={agentPaired}
                  onSignIn={() => void ownerSignIn.signIn()}
                  onChangeWallet={onChangeWallet}
                  onReviewMandate={openMandateCreate}
                  onConnectAgent={() => selectTab("agents")}
                  demoReceiptHref={demoReceiptHref}
                />
              ) : (
                <>
                  <OwnerOverview mandates={mandates} connections={connections} connectionError={connectionStatus === "error"} attention={attentionItems} activity={recentActivity} assets={stablecoinOptions} onRequests={() => selectTab("assistant")} onAgents={() => selectTab("agents")} onPermissions={() => selectTab("mandates")} onPermission={(address) => onTabChange("mandates", { mandateDetail: address })} onPayments={() => selectTab("payments")} />
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

function PaymentsWorkspace({ history, form }: { wallet: string; history: ReactNode; form: ReactNode }) {
  const [composing, setComposing] = useState(false);
  const [started, setStarted] = useState(false);
  return <section className="owner-payments-workspace"><div className="owner-page-actions"><Button variant={composing ? "secondary" : "primary"} label={composing ? "Back to payments" : "New payment"} icon={composing ? <ArrowLeft size={18} /> : <Plus size={18} />} onClick={() => { setStarted(true); setComposing(!composing); }} /></div><div hidden={composing}>{history}</div>{started && <div hidden={!composing}>{form}</div>}</section>;
}

type MandateTableStatus = Mandate["status"];
function mandateTableStatus(status: Mandate["status"]): MandateTableStatus { return status; }

function mandateStatusLabel(status: MandateTableStatus) {
  return status[0].toUpperCase() + status.slice(1);
}

export function MandatesPanel({
  wallet,
  loadStatus = "ready",
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
  onOpenAgents,
  onRefresh,
}: {
  wallet: string;
  loadStatus?: "idle" | "loading" | "ready" | "error";
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  walletMessageSigner?: (message: Uint8Array) => Promise<Uint8Array>;
  mandates: Mandate[];
  mandate: Mandate | null;
  mandateDecimals: number | null;
  stablecoinOptions: StablecoinOption[];
  protocolConfig: ProtocolConfig | null;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onMandateAction: (action: MandateAction, mandate: Mandate, updateFields?: MandateUpdateFields) => Promise<void>;
  onSelectMandate: (mandate: Mandate) => void;
  onOpenPayments: () => void;
  onOpenAgents: () => void;
  onRefresh: (preferredMandateAddress?: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | MandateTableStatus>("all");
  const [mandateSearch, setMandateSearch] = useState("");
  const [actionInFlight, setActionInFlight] = useState<MandateAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<Mandate | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ maxPerPayment: "", totalLimit: "", expiresAtSlot: "", maxPaymentCount: "", cooldownSlots: "" });
  const [actionAddress, setActionAddress] = useState("");
  const actionLock = useRef(false);
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);
  const { estimate: slotEstimate } = useSlotEstimate();
  const [decimalsByMint, setDecimalsByMint] = useState<Record<string, number>>({});
  const [sourceDelegate, setSourceDelegate] = useState<string | null>(null);
  const [sourceDelegatedAmount, setSourceDelegatedAmount] = useState<bigint>(0n);
  const [delegateLoading, setDelegateLoading] = useState(false);
  const { currentRoute, navigate } = useRoute();
  const fullDetailAddress = currentRoute.kind === "app" && currentRoute.tab === "mandates" ? currentRoute.mandateDetail : undefined;
  const [expandedMandateAddress, setExpandedMandateAddress] = useState<string | null>(null);
  const recordAddress = fullDetailAddress ?? expandedMandateAddress;
  const listPosition = useRef<{ windowY: number; mainY: number } | null>(null);
  const wasFullPage = useRef(false);
  const openingControl = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (wasFullPage.current && !fullDetailAddress && listPosition.current) {
      const position = listPosition.current;
      const frame = requestAnimationFrame(() => {
        window.scrollTo(0, position.windowY);
        const main = document.querySelector(".dashboard-main");
        if (main) main.scrollTop = position.mainY;
        openingControl.current?.focus({ preventScroll: true });
      });
      wasFullPage.current = false;
      return () => cancelAnimationFrame(frame);
    }
    wasFullPage.current = Boolean(fullDetailAddress);
  }, [fullDetailAddress]);
  useEffect(() => {
    setExpandedMandateAddress(null);
    setRevokeTarget(null);
    setEditOpen(false);
    setActionError("");
    setFilter("all");
    setMandateSearch("");
    listPosition.current = null;
    openingControl.current = null;
    const saved = window.history.state?.chainpayPermissionPreview;
    if (saved && saved.wallet !== wallet) window.history.replaceState(null, "", window.location.href);
  }, [wallet]);
  useEffect(() => {
    setEditOpen(false);
  }, [recordAddress]);
  useEffect(() => {
    const syncPreview = () => {
      const saved = window.history.state?.chainpayPermissionPreview;
      setExpandedMandateAddress(saved?.wallet === wallet && window.location.pathname.replace(/\/$/, "") === "/app/mandates" ? saved.address : null);
    };
    syncPreview();
    window.addEventListener("popstate", syncPreview);
    return () => window.removeEventListener("popstate", syncPreview);
  }, [wallet]);
  function openRecord(value: Mandate, control: HTMLElement) {
    openingControl.current = control;
    listPosition.current = { windowY: window.scrollY, mainY: document.querySelector(".dashboard-main")?.scrollTop ?? 0 };
    control.focus({ preventScroll: true });
    onSelectMandate(value);
    window.history.pushState({ chainpayPermissionPreview: { wallet, address: value.address } }, "", window.location.href);
    setExpandedMandateAddress(value.address);
  }
  function closeRecord() {
    setExpandedMandateAddress(null);
    if (fullDetailAddress) {
      if (listPosition.current) window.history.back();
      else navigate({ kind: "app", tab: "mandates" }, { replace: true });
    } else if (window.history.state?.chainpayPermissionPreview?.wallet === wallet) window.history.back();
  }
  function openFullRecord() {
    if (!expandedMandate) return;
    setExpandedMandateAddress(null);
    navigate({ kind: "app", tab: "mandates", mandateDetail: expandedMandate.address }, { replace: true });
  }
  const normalizedSearch = mandateSearch.trim().toLowerCase();
  const filteredMandates = mandates.filter((value) => {
    const statusMatches = value.owner === wallet && (filter === "all" || mandateTableStatus(value.status) === filter);
    const searchMatches = !normalizedSearch || [value.address, value.approvedAgent, value.allowedMint, mandateDisplayName(value, mandates, stablecoinOptions)].some((field) => field.toLowerCase().includes(normalizedSearch));
    return statusMatches && searchMatches;
  });
  const visibleMandates = filteredMandates.slice(0, MAX_MANDATES_VISIBLE);
  const expandedMandate = recordAddress ? mandates.find((value) => value.address === recordAddress && value.owner === wallet) ?? null : null;
  const expandedMandateStatus = expandedMandate ? mandateTableStatus(expandedMandate.status) : null;
  const expandedMandateAsset = expandedMandate ? stablecoinOptions.find((option) => option.mint === expandedMandate.allowedMint) : null;
  const expandedMandateDecimals = expandedMandate ? decimalsByMint[expandedMandate.allowedMint] : undefined;
  const expandedMandateExpiry = expandedMandate
    ? mandateExpiryLabel(expandedMandate.expiresAtSlot, currentSlot, slotEstimate)
    : "";

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

  useEffect(() => {
    if (!expandedMandate) {
      setSourceDelegate(null);
      setSourceDelegatedAmount(0n);
      return undefined;
    }
    let active = true;
    setDelegateLoading(true);
    void getAccountInfoOrNull(new PublicKey(expandedMandate.sourceTokenAccount)).then((account) => {
      if (!active) return;
      setSourceDelegate(readTokenAccountDelegate(account));
      setSourceDelegatedAmount(readTokenAccountDelegatedAmount(account));
      setDelegateLoading(false);
    }).catch(() => {
      if (!active) return;
      setSourceDelegate(null);
      setSourceDelegatedAmount(0n);
      setDelegateLoading(false);
    });
    return () => { active = false; };
  }, [expandedMandate?.address, expandedMandate?.sourceTokenAccount]);

  async function repairDelegateApproval(targetMandate: Mandate) {
    if (!walletSigner) {
      setActionError("The connected wallet does not expose transaction signing.");
      return;
    }
    if (expandedMandateDecimals === undefined || expandedMandateDecimals === null) {
      setActionError("Token decimals are not available yet. Refresh and try again.");
      return;
    }
    const remainingAllowance = targetMandate.totalLimit > targetMandate.amountSpent
      ? targetMandate.totalLimit - targetMandate.amountSpent
      : 0n;
    if (remainingAllowance <= 0n) {
      setActionError("This mandate has no remaining allowance to delegate.");
      return;
    }
    actionLock.current = true;
    setActionAddress(targetMandate.address);
    setActionError("");
    setActionInFlight("update");
    try {
      const tokenProgram = targetMandate.tokenProgram ?? await chainpayClient.getTokenProgram(targetMandate.sourceTokenAccount);
      const prepared = chainpayClient.buildApproveDelegate({
        owner: wallet,
        sourceTokenAccount: targetMandate.sourceTokenAccount,
        allowedMint: targetMandate.allowedMint,
        tokenProgram,
        mandate: targetMandate.address,
        totalLimit: targetMandate.totalLimit,
        delegateAmount: remainingAllowance,
        decimals: expandedMandateDecimals,
      });
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await walletSigner(toWeb3Transaction(prepared, latest.blockhash));
      await submitSignedTransaction(`delegate-repair:${targetMandate.address}:${latest.blockhash}`, signed.serialize());
      await onRefresh(targetMandate.address);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionLock.current = false;
      setActionInFlight(null);
    }
  }

  async function handleMandateAction(action: MandateAction, targetMandate: Mandate, updateFields?: MandateUpdateFields) {
    if (actionLock.current) return;
    if (targetMandate.owner !== wallet) { setActionError("Connect the permission’s owner wallet before changing it."); return; }
    actionLock.current = true;
    setActionAddress(targetMandate.address);
    setActionError("");
    setActionInFlight(action);
    try {
      await onMandateAction(action, targetMandate, updateFields);
      if (action === "update") setEditOpen(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionLock.current = false;
      setActionInFlight(null);
    }
  }

  function openPermissionEditor(targetMandate: Mandate, decimals: number | null) {
    setEditForm({
      maxPerPayment: formatTokenAmount(targetMandate.maxPerPayment, decimals),
      totalLimit: formatTokenAmount(targetMandate.totalLimit, decimals),
      expiresAtSlot: targetMandate.expiresAtSlot.toString(),
      maxPaymentCount: targetMandate.maxPaymentCount.toString(),
      cooldownSlots: targetMandate.cooldownSlots.toString(),
    });
    setEditOpen(true);
    setActionError("");
  }

  async function submitPermissionEditor(targetMandate: Mandate) {
    const decimals = expandedMandateDecimals ?? null;
    if (decimals === null) {
      setActionError("Token decimals are not available yet. Refresh and try again.");
      return;
    }
    try {
      const maxPerPayment = parseTokenAmount(editForm.maxPerPayment, decimals);
      const totalLimit = parseTokenAmount(editForm.totalLimit, decimals);
      const expiresAtSlot = parseExpirySlot(editForm.expiresAtSlot);
      const maxPaymentCount = BigInt(editForm.maxPaymentCount.trim() || "0");
      const cooldownSlots = BigInt(editForm.cooldownSlots.trim() || "0");
      if (totalLimit < targetMandate.amountSpent) throw new Error("Total limit must cover what is already spent.");
      if (totalLimit < maxPerPayment) throw new Error("Total limit must be at least the per-payment cap.");
      if (maxPaymentCount !== 0n && maxPaymentCount < targetMandate.paymentCount) throw new Error("Payment count must be unlimited (0) or at least the number already used.");
      const latestSlot = currentSlot ?? await chainpayClient.getCurrentSlot();
      if (expiresAtSlot <= latestSlot) throw new Error("Expiry must be a future slot.");
      await handleMandateAction("update", targetMandate, { maxPerPayment, totalLimit, expiresAtSlot, maxPaymentCount, cooldownSlots });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
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
      `Cooldown slots: ${expandedMandate.cooldownSlots.toString()}${expandedMandate.cooldownSlots === 0n ? " (no cooldown)" : ""}`,
    ].join("\n"));
  }

  const searchedMandate = normalizedSearch
    ? filteredMandates.find((value) => value.address.toLowerCase() === normalizedSearch)
      ?? (filteredMandates.length === 1 ? filteredMandates[0] : undefined)
    : undefined;

  if (createOpen) {
    return (
      <section className="mandate-create-page" aria-label="Create spending permission">
          <MandateBuilder wallet={wallet} walletSigner={walletSigner} walletMessageSigner={walletMessageSigner} stablecoinOptions={stablecoinOptions} protocolConfig={protocolConfig} onCreated={(address) => onRefresh(address)} onOpenPayments={onOpenPayments} onOpenAgents={onOpenAgents} />
      </section>
    );
  }

  return (
    <section className="mandates-panel" aria-labelledby="mandate-table-title">
      <div hidden={Boolean(fullDetailAddress)}>
      <div className="mandate-filter-controls"><div className="mandate-filter-bar">
        <RadioList
          label="Filter permissions"
          isLabelHidden
          orientation="horizontal"
          value={filter}
          onChange={(value) => setFilter(value as "all" | MandateTableStatus)}
        >
          <RadioListItem value="all" label="All" />
          <RadioListItem value="active" label="Active" />
          <RadioListItem value="paused" label="Paused" />
          <RadioListItem value="revoked" label="Revoked" />
          <RadioListItem value="expired" label="Expired" />
        </RadioList>
      </div><div className="mandate-search-group"><TextInput label="Search permissions" isLabelHidden value={mandateSearch} onChange={setMandateSearch} onEnter={() => { if (searchedMandate && document.activeElement instanceof HTMLElement) openRecord(searchedMandate, document.activeElement); }} placeholder="Search permissions…" />{searchedMandate && <Button type="button" variant="secondary" className="mandate-search-action" label="Inspect permission" isDisabled={false} onClick={(event) => openRecord(searchedMandate, event.currentTarget)} />}</div></div>
      <div className="mandate-list-meta" aria-live="polite">
        <span>Showing {visibleMandates.length} of {filteredMandates.length} {filter === "all" ? "permissions" : `${filter} permissions`}</span>
        {filteredMandates.length > visibleMandates.length && <span>Showing the first {MAX_MANDATES_VISIBLE}. Use the filters to narrow the list.</span>}
        {normalizedSearch && filteredMandates.length === 0 && <span>No permission matches “{mandateSearch}”.</span>}
      </div>

      <div className="mandate-table-shell dashboard-card">
        <div className="mandate-table-scroll">
          <Table className="mandate-table" density="balanced" dividers="rows" hasHover>
            <caption id="mandate-table-title" className="sr-only">Spending permissions</caption>
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell scope="col">Permission</TableHeaderCell>
                <TableHeaderCell scope="col">Created</TableHeaderCell>
                <TableHeaderCell scope="col">Amount</TableHeaderCell>
                <TableHeaderCell scope="col">Status</TableHeaderCell>
                <TableHeaderCell scope="col" className="mandate-actions-heading"><span className="sr-only">Actions</span></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleMandates.length ? visibleMandates.map((value) => {
                const status = mandateTableStatus(value.status);
                const selectedAsset = stablecoinOptions.find((option) => option.mint === value.allowedMint);
                const decimals = decimalsByMint[value.allowedMint];
                const progress = value.totalLimit > 0n ? Math.min(100, Number((value.amountSpent * 100n) / value.totalLimit)) : 0;
                const selected = mandate?.address === value.address;
                const expiry = mandateExpiryLabel(value.expiresAtSlot, currentSlot, slotEstimate);
                return (
                  <TableRow key={value.address} className={selected ? "is-selected" : undefined} onClick={(event) => { openRecord(value, event.currentTarget); }} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRecord(value, event.currentTarget); } }} tabIndex={0} aria-label={`Inspect spending permission ${value.address}`} aria-expanded={expandedMandateAddress === value.address}>
                    <TableCell data-label="Agent">
                      <div className="mandate-agent-cell">
                        <span className="mandate-agent-avatar">{value.approvedAgent.slice(0, 2)}</span>
                        <span><strong>{mandateDisplayName(value, mandates, stablecoinOptions)}{selected ? " · Selected" : ""}</strong><small className="mono">Agent {shortAddress(value.approvedAgent)} · Mandate {shortAddress(value.address)}</small></span>
                      </div>
                    </TableCell>
                    <TableCell data-label="Date"><div className="mandate-date-cell"><strong>{mandateCreatedLabel(value)}</strong><small className="mono">{expiry}</small></div></TableCell>
                    <TableCell data-label="Amount" className="mandate-amount-cell">
                      <div className="mandate-amount-line"><strong>{formatTokenAmount(value.amountSpent, decimals ?? null)}</strong><span>/ {formatTokenAmount(value.totalLimit, decimals ?? null)} {selectedAsset?.label ?? "tokens"}</span></div>
                      <div className="mandate-spend-bar" aria-label={`${progress}% of mandate spend used`}><span style={{ width: `${progress}%` }} /></div>
                      <small className="mandate-token-note">{selectedAsset?.detail ?? (value.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token")}</small>
                    </TableCell>
                    <TableCell data-label="Status"><span className={`mandate-table-status ${status}`}><span className="mandate-status-check">✓</span>{mandateStatusLabel(status)}</span></TableCell>
                    <TableCell data-label="Actions" className="mandate-table-actions">
                      {(status === "active" || status === "paused") ? <>
                        <Button type="button" variant="secondary" label={status === "paused" ? "Resume" : "Pause"} isDisabled={actionInFlight !== null} onClick={(event) => { event.stopPropagation(); void handleMandateAction(status === "paused" ? "resume" : "pause", value); }} />
                      </> : <span className="mandate-no-actions">—</span>}
                      {actionInFlight && actionAddress === value.address && <small role="status">Waiting for wallet or confirmation…</small>}
                    </TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow className="mandate-empty-row"><TableCell colSpan={6}><div className="mandate-empty-state"><span className="empty-icon">◇</span><strong>{mandates.length ? `No ${filter} mandates` : "No mandates yet"}</strong><p>{mandates.length ? "Try another status filter." : "Create a mandate to give an agent bounded spending authority."}</p><Button type="button" variant="primary" label="＋ New mandate" isDisabled={false} onClick={() => onCreateOpenChange(true)} /></div></TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      </div>
      <RecordDetails open={Boolean(expandedMandateAddress)} fullPage={Boolean(fullDetailAddress)} title="Spending permission" onClose={closeRecord}
        fullPageHref={expandedMandate ? buildPath({ kind: "app", tab: "mandates", mandateDetail: expandedMandate.address }) : undefined} onOpenFullPage={openFullRecord}>
      {recordAddress && !expandedMandate && <div className="cp-record-missing" role="status" aria-busy={loadStatus === "loading" || loadStatus === "idle"}><h3>{loadStatus === "loading" || loadStatus === "idle" ? "Loading permission…" : loadStatus === "error" ? "Unable to load permission" : "Permission unavailable"}</h3><p>{loadStatus === "loading" || loadStatus === "idle" ? "Reading the current wallet’s permissions." : loadStatus === "error" ? "The permission list could not be refreshed. Try again before drawing a conclusion about this address." : "This permission is not in the current wallet’s loaded records. Check the address and wallet, or refresh the list."}</p><Button type="button" variant="secondary" label="Refresh permissions" isDisabled={loadStatus === "loading"} onClick={() => void onRefresh()} /></div>}
      {expandedMandate && <article className="dashboard-card mandate-detail-card" aria-labelledby="mandate-detail-title">
        <div className="mandate-detail-heading">
          <div><span className="section-kicker">MANDATE DETAILS</span><h2 id="mandate-detail-title">{expandedMandateAsset?.label ?? "Selected mandate"}</h2><p>Review the current on-chain limits for this agent.</p></div>
          <div className="mandate-detail-heading-actions"><span className={`mandate-table-status ${expandedMandateStatus}`}><span className="mandate-status-check">✓</span>{expandedMandate.status === "expired" ? "Expired" : mandateStatusLabel(expandedMandateStatus ?? "revoked")}</span></div>
        </div>
        <p className="cp-record-agent"><span>Approved agent</span><strong>{expandedMandate.approvedAgent}</strong></p>
        {expandedMandateDecimals === undefined && <p className="cp-record-consequences">Showing exact base units until token decimals are available.</p>}
        <div className="cp-permission-summary">
          <div><span>Per-payment limit</span><strong>{formatTokenAmount(expandedMandate.maxPerPayment, expandedMandateDecimals ?? null)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Remaining allowance</span><strong>{formatTokenAmount(expandedMandate.totalLimit > expandedMandate.amountSpent ? expandedMandate.totalLimit - expandedMandate.amountSpent : 0n, expandedMandateDecimals ?? null)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
        </div>
        {(expandedMandate.status === "active" || expandedMandate.status === "paused") && <div className="cp-delegate-status"><span className="section-kicker">SPL DELEGATE</span><p className="builder-intro">Token accounts have one current delegate. Repair approval replaces the delegated allowance with the mandate’s remaining allowance — it does not increment an existing approval and may displace another mandate’s delegate.</p>{delegateLoading ? <p role="status">Reading source token account…</p> : <><div className="mandate-detail-grid"><div><span>Current delegate</span><strong className="mono">{sourceDelegate ? shortAddress(sourceDelegate) : "None"}</strong></div><div><span>Remaining delegated amount</span><strong>{formatTokenAmount(sourceDelegatedAmount, expandedMandateDecimals ?? null)} {expandedMandateAsset?.label ?? "tokens"}</strong></div></div>{(() => {
          const remainingAllowance = expandedMandate.totalLimit > expandedMandate.amountSpent ? expandedMandate.totalLimit - expandedMandate.amountSpent : 0n;
          const needsRepair = sourceDelegate !== expandedMandate.address || sourceDelegatedAmount < remainingAllowance;
          return needsRepair ? <div className="mandate-detail-actions"><Button type="button" variant="secondary" label={actionInFlight === "update" ? "Waiting for wallet…" : "Repair approval"} isDisabled={actionInFlight !== null || remainingAllowance <= 0n} onClick={() => void repairDelegateApproval(expandedMandate)} /><span className="mandate-detail-note">Approves {formatTokenAmount(remainingAllowance, expandedMandateDecimals ?? null)} to this mandate PDA.</span></div> : <p className="mandate-detail-note">Source token account is delegated to this mandate with enough remaining allowance for future payments.</p>;
        })()}</>}</div>}
        <div className="mandate-detail-grid">
          <div><span>Maximum per payment</span><strong>{formatTokenAmount(expandedMandate.maxPerPayment, expandedMandateDecimals ?? null)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Total spending limit</span><strong>{formatTokenAmount(expandedMandate.totalLimit, expandedMandateDecimals ?? null)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Already spent</span><strong>{formatTokenAmount(expandedMandate.amountSpent, expandedMandateDecimals ?? null)} {expandedMandateAsset?.label ?? "tokens"}</strong></div>
          <div><span>Payment count</span><strong>{expandedMandate.paymentCount.toString()}{expandedMandate.maxPaymentCount === 0n ? " · No limit" : ` of ${expandedMandate.maxPaymentCount.toString()}`}</strong></div>
          <div><span>Cooldown</span><strong>{expandedMandate.cooldownSlots.toString()} slots<small>{expandedMandate.cooldownSlots === 0n ? "No cooldown" : "Minimum slots between payments"}</small></strong></div>
          <div><span>Expiry</span><strong>{expandedMandateExpiry}<small>Slot {expandedMandate.expiresAtSlot.toString()}</small></strong></div>
        </div>
        {(expandedMandate.status === "active" || expandedMandate.status === "paused") && (
          <div className="cp-permission-editor">
            <div className="dashboard-card-heading"><div><span className="section-kicker">EDIT LIMITS</span><h3>Adjust spending policy</h3></div>{!editOpen && <Button type="button" variant="secondary" label="Edit limits" isDisabled={actionInFlight !== null} onClick={() => openPermissionEditor(expandedMandate, expandedMandateDecimals ?? null)} />}</div>
            <p className="builder-intro">Owner, source account, token mint, and approved signer stay fixed. Paused state is preserved until you resume separately.</p>
            {editOpen && <>
              <div className="builder-grid">
                <TextInput label="Maximum per payment" value={editForm.maxPerPayment} onChange={(value) => setEditForm((current) => ({ ...current, maxPerPayment: value }))} />
                <TextInput label="Total spending limit" value={editForm.totalLimit} onChange={(value) => setEditForm((current) => ({ ...current, totalLimit: value }))} />
                <TextInput label="Expiry slot" description="Must be after the current cluster slot" value={editForm.expiresAtSlot} onChange={(value) => setEditForm((current) => ({ ...current, expiresAtSlot: value }))} />
                <TextInput label="Maximum payment count" description="0 means unlimited" value={editForm.maxPaymentCount} onChange={(value) => setEditForm((current) => ({ ...current, maxPaymentCount: value }))} />
                <TextInput label="Cooldown slots" description="Minimum slots between payments" value={editForm.cooldownSlots} onChange={(value) => setEditForm((current) => ({ ...current, cooldownSlots: value }))} />
              </div>
              <div className="mandate-detail-actions">
                <Button type="button" variant="secondary" label="Cancel" isDisabled={actionInFlight === "update"} onClick={() => setEditOpen(false)} />
                <Button type="button" variant="primary" label={actionInFlight === "update" ? "Waiting for wallet…" : "Save limits"} isDisabled={actionInFlight !== null} onClick={() => void submitPermissionEditor(expandedMandate)} />
              </div>
            </>}
          </div>
        )}
        <details className="cp-record-technical"><summary>Technical identifiers and source account</summary><div className="mandate-detail-grid">
          <div><span>Mandate address</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.address)} title="Copy mandate address">{expandedMandate.address} ⧉</button></div>
          <div><span>Approved agent</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.approvedAgent)} title="Copy approved agent">{expandedMandate.approvedAgent} ⧉</button></div>
          <div><span>Owner</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.owner)} title="Copy owner address">{expandedMandate.owner} ⧉</button></div>
          <div><span>Token</span><strong>{expandedMandateAsset?.label ?? "Unknown token"}<small>{expandedMandateAsset?.detail ?? "Token mint"}</small></strong></div>
          <div><span>Token mint</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.allowedMint)} title="Copy token mint">{expandedMandate.allowedMint} ⧉</button></div>
          <div><span>Token type</span><strong>{expandedMandate.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token"}</strong></div>
          <div><span>{expandedMandateAsset?.label ?? "Token"} account</span><button type="button" className="mandate-detail-value" onClick={() => copyValue(expandedMandate.sourceTokenAccount)} title={`Copy your ${expandedMandateAsset?.label ?? "token"} transfer account`}>{expandedMandate.sourceTokenAccount} ⧉</button><small>Your {expandedMandateAsset?.label ?? "token"} account for transferring funds</small></div>
          <div><span>Recipient rule</span><strong>{expandedMandate.legacyAllowedRecipient ?? "Chosen for each payment"}<small>{expandedMandate.legacyAllowedRecipient ? "Fixed recipient" : "Paste the recipient wallet address; ChainPay resolves its token account"}</small></strong></div>
        </div></details>
        {actionInFlight && actionAddress === expandedMandate.address && <p role="status">Waiting for wallet or confirmation. Current permission settings remain visible until confirmed.</p>}
        <p className="cp-record-consequences">Pause, resume and revoke affect future execution. They do not cancel a submitted payment or invalidate an earlier receipt.</p>
        <div className="mandate-detail-actions">
          {(expandedMandate.status === "active" || expandedMandate.status === "paused") && <>
            <Button type="button" variant="secondary" label={expandedMandate.status === "paused" ? "Resume permission" : "Pause permission"} isDisabled={actionInFlight !== null} onClick={() => void handleMandateAction(expandedMandate.status === "paused" ? "resume" : "pause", expandedMandate)} />
            <Button type="button" variant="destructive" label="Revoke permission" isDisabled={actionInFlight !== null} onClick={() => setRevokeTarget(expandedMandate)} />
          </>}
          <Button type="button" variant="secondary" label="Copy details for AI" isDisabled={false} onClick={copyExpandedMandateDetails} />
          {expandedMandate.status === "active" && expandedMandate.approvedAgent === wallet && <Button type="button" variant="primary" label="Use this mandate for payment" isDisabled={false} onClick={() => useMandateForPayment(expandedMandate)} />}
          {expandedMandate.status === "active" && expandedMandate.approvedAgent !== wallet && <span className="mandate-detail-note">This permission names a different payment signer. Use the configured agent connection. Automatic-payment availability depends on that signer’s setup.</span>}
          {expandedMandate.status === "paused" && <span className="mandate-detail-note">This mandate is paused. Resume it before using it for payment.</span>}
          {(expandedMandate.status === "revoked" || expandedMandate.status === "expired") && <span className="mandate-detail-note">This mandate cannot be used for new payments.</span>}
        </div>
      </article>}
      {actionError && <p className="mandate-action-error" role="alert">{actionError}</p>}
      </RecordDetails>
      {!recordAddress && actionError && <p className="mandate-action-error" role="alert">{actionError}</p>}
      <ConfirmDialog open={Boolean(revokeTarget)} title="Revoke this spending permission?"
        description={`This stops future payments through permission ${revokeTarget?.address ?? ""}. It cannot be resumed. Already-submitted payments and earlier receipts are unchanged. Continue to your wallet to approve revocation.`}
        confirmLabel="Continue to wallet" onClose={() => setRevokeTarget(null)} onConfirm={() => {
          const target = revokeTarget;
          setRevokeTarget(null);
          if (target) void handleMandateAction("revoke", target);
        }} />
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
  onOpenMandateBuilder: () => void;
  onOpenAgents: () => void;
};

function PaymentPanel({ wallet, walletSigner, mandates, mandate, stablecoinOptions, onSelectMandate, onCallMcp, onAskAgent, onRefresh, onOpenMandateBuilder, onOpenAgents }: PaymentPanelProps) {
  const [invoice, setInvoice] = useState("demo-invoice-001");
  const [amount, setAmount] = useState("1");
  const [recipient, setRecipient] = useState("");
  const [mintDecimals, setMintDecimals] = useState<number | null>(null);
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [mcpPreflight, setMcpPreflight] = useState("");
  const [status, setStatus] = useState<"idle" | "preparing" | "ready" | "signing" | "pending" | "success" | "error">("idle");
  const settlementOperationKey = useRef<string | null>(null);
  useSettlementFormStatus(wallet, setStatus, settlementOperationKey);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [recipientAtaReview, setRecipientAtaReview] = useState<RecipientAtaReview | null>(null);
  const [recipientAtaStatus, setRecipientAtaStatus] = useState<"idle" | "creating" | "ready">("idle");
  const allPaymentMandates = mandates
    .filter((candidate) => candidate.status === "active" && candidate.approvedAgent === wallet)
    .sort((left, right) => stablecoinOrder(left.allowedMint, stablecoinOptions) - stablecoinOrder(right.allowedMint, stablecoinOptions));
  const paymentMandates = allPaymentMandates.slice(0, MAX_PAYMENT_MANDATES);
  const selectedPaymentMandate = paymentMandates.find((candidate) => candidate.address === mandate?.address) ?? paymentMandates[0] ?? null;
  const representedMints = new Set(allPaymentMandates.map((candidate) => candidate.allowedMint));
  const hasDelegatedActiveMandate = mandates.some((candidate) => candidate.status === "active" && candidate.approvedAgent !== wallet);

  useEffect(() => {
    const recovered = (event: Event) => {
      const operation = (event as CustomEvent<Operation>).detail;
      if (operation.wallet !== wallet || operation.key !== settlementOperationKey.current) return;
      if (operation.status === "failed") {
        setError(operation.result?.error ?? "The original payment failed.");
      } else if (operation.status === "confirmed" && operation.result?.signature && prepared && operation.result.receipt_address === prepared.receiptAddress) {
        setSignature(operation.result.signature);
        setError("");
      }
    };
    window.addEventListener(settlementTerminalEvent, recovered);
    return () => window.removeEventListener(settlementTerminalEvent, recovered);
  }, [wallet, prepared]);

  useEffect(() => {
    if (selectedPaymentMandate && mandate?.address !== selectedPaymentMandate.address) {
      onSelectMandate(selectedPaymentMandate);
    }
  }, [mandate?.address, onSelectMandate, selectedPaymentMandate?.address]);

  useEffect(() => {
    const paymentDraft = loadWalletDrafts(wallet).payment;
    if (paymentDraft) {
      setInvoice(paymentDraft.invoice);
      setAmount(paymentDraft.amount);
      setRecipient(paymentDraft.recipient);
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    saveWalletDrafts(wallet, { payment: { invoice, amount, recipient } });
  }, [wallet, invoice, amount, recipient]);

  useEffect(() => {
    if (selectedPaymentMandate) setAmount((current) => current || selectedPaymentMandate.maxPerPayment.toString());
  }, [selectedPaymentMandate]);

  useEffect(() => {
    setPrepared(null);
    setMcpPreflight("");
    setSignature("");
    setReceipt(null);
    setError("");
    setRecipientAtaReview(null);
    setRecipientAtaStatus("idle");
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
      if (destination.createInstruction) {
        setRecipientAtaReview({
          ownerWallet: recipient.trim(),
          tokenAccount: destination.address,
          mint: selectedPaymentMandate.allowedMint,
          tokenProgram,
          createInstruction: destination.createInstruction,
        });
        setRecipientAtaStatus("idle");
        setPrepared(null);
        setStatus("idle");
        setError("The recipient needs a token account before payment can be prepared. Review and create it separately, then prepare again.");
        return;
      }
      setRecipientAtaReview(null);
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
      settlementOperationKey.current = `${prepared.request.mandate}:${bytesToHex(prepared.request.invoiceHash)}`;
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

  async function createRecipientAccount() {
    if (!recipientAtaReview || !walletSigner) return;
    setRecipientAtaStatus("creating");
    setError("");
    try {
      await createRecipientTokenAccount(recipientAtaReview, walletSigner, wallet);
      setRecipientAtaReview(null);
      setRecipientAtaStatus("ready");
      setError("");
    } catch (cause) {
      setRecipientAtaStatus("idle");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!selectedPaymentMandate) {
    return <>
      <div className="dashboard-card flow-empty"><div className="empty-icon">↗</div><h2>{hasDelegatedActiveMandate ? "This mandate does not sign from your browser" : "No spending permission yet"}</h2><p>{hasDelegatedActiveMandate ? "Your active mandate settles through the provisioned signer, inside the limits you approved. Use it from a paired agent, or create an “Approve each payment” mandate to sign here." : "Payments are checked against an on-chain mandate. Create one first — you approve its limits in your wallet before any payment can be prepared."}</p><div className="flow-empty-actions"><Button type="button" variant="primary" label={hasDelegatedActiveMandate ? "Create an approve-each-payment mandate" : "Create a mandate"} isDisabled={false} onClick={onOpenMandateBuilder} /><Button type="button" variant="secondary" label="Open Agents" isDisabled={false} onClick={onOpenAgents} /></div></div>

    </>;
  }

  return (
    <>
    <section className="payment-flow-layout">
      <div className="dashboard-card payment-form-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">PAYMENT REQUEST</span><h2>Prepare a policy-checked payment</h2></div><span className="mcp-badge"><span /> Payment safety checks</span></div>
        <p className="builder-intro">ChainPay checks the mandate, policy, and transaction before asking your wallet to approve this payment.</p>
        <div className="payment-mandate-picker">
          <div className="payment-mandate-picker-heading"><div><span className="soft-label">AVAILABLE MANDATES</span><strong>Choose the active policy the agent will use</strong></div><span className="payment-mandate-count">{paymentMandates.length}{allPaymentMandates.length > MAX_PAYMENT_MANDATES ? ` of ${allPaymentMandates.length}` : ""} active</span></div>
          {allPaymentMandates.length > MAX_PAYMENT_MANDATES && <p className="payment-mandate-limit">Payments show the first {MAX_PAYMENT_MANDATES} active mandates. Manage all mandates from Spending permissions.</p>}
          <div className="payment-mandate-options">
            <RadioList label="Choose the active mandate" isLabelHidden value={selectedPaymentMandate.address} onChange={selectPaymentMandate}>
              {paymentMandates.map((candidate) => {
                const option = stablecoinOptions.find((item) => item.mint === candidate.allowedMint);
                return (
                  <RadioListItem
                    key={candidate.address}
                    className={`payment-mandate-option ${candidate.address === selectedPaymentMandate.address ? "is-selected" : ""}`}
                    value={candidate.address}
                    label={mandateDisplayName(candidate, mandates, stablecoinOptions)}
                    description={`${option?.detail ?? (candidate.tokenProgram === "token-2022" ? "Token-2022" : "Classic SPL Token")} · Agent ${shortAddress(candidate.approvedAgent)} · Mandate ${shortAddress(candidate.address)} · ${formatTokenAmount(candidate.maxPerPayment, candidate.allowedMint === selectedPaymentMandate.allowedMint ? mintDecimals : null)} per payment · ${formatTokenAmount(candidate.totalLimit, candidate.allowedMint === selectedPaymentMandate.allowedMint ? mintDecimals : null)} total`}
                    endContent={<span className={`payment-mandate-status ${candidate.status}`}><i />{candidate.status}</span>}
                  />
                );
              })}
            </RadioList>
            {stablecoinOptions.filter((option) => option.mint && !representedMints.has(option.mint)).map((option) => <div className="payment-mandate-missing" key={`missing-${option.value}`}><strong>{option.label}</strong><span>{option.detail} · create a mandate first</span></div>)}
          </div>
        </div>
        <div className="builder-grid">
          <TextInput className="field-wide" label="Invoice or payment reference" value={invoice} onChange={(value) => { setInvoice(value); setPrepared(null); setSignature(""); }} placeholder="invoice-001" />
          <TextInput label="Amount" value={amount} onChange={(value) => { setAmount(value); setPrepared(null); setSignature(""); }} placeholder="1.00" description={mintDecimals === null ? "Reading mint decimals. Enter the exact token amount as text." : `${mintDecimals} decimals. Enter the exact token amount as text.`} />
          <TextInput label="Agent signer" value={wallet} isReadOnly />
          <TextInput className="field-wide" label="Recipient wallet address" value={recipient} onChange={(value) => { setRecipient(value); setPrepared(null); setSignature(""); }} placeholder="Paste the recipient's Solana wallet address" description="ChainPay derives the recipient’s account for the selected USDC, PYUSD, or Token-2022 mint." />
        </div>
        <div className="payment-policy-note"><Shield /><span>Policy limit: <b>{formatTokenAmount(selectedPaymentMandate.maxPerPayment, mintDecimals)}</b> per payment · <b>{formatTokenAmount(selectedPaymentMandate.totalLimit, mintDecimals)}</b> total · {selectedPaymentMandate.status}</span></div>
        {recipientAtaReview && <div className="dashboard-card recipient-ata-review"><span className="section-kicker">RECIPIENT ACCOUNT</span><h3>Create the recipient token account first</h3><p>ChainPay will not prepend account creation to the payment transaction. Review the derived account, pay SOL rent from your wallet, then prepare the payment again.</p><div className="review-list"><div><span>Recipient wallet</span><strong className="mono">{shortAddress(recipientAtaReview.ownerWallet)}</strong></div><div><span>Token account</span><strong className="mono">{shortAddress(recipientAtaReview.tokenAccount)}</strong></div><div><span>Stablecoin mint</span><strong className="mono">{shortAddress(recipientAtaReview.mint)}</strong></div></div><Button type="button" variant="primary" label={recipientAtaStatus === "creating" ? "Creating account…" : "Create recipient account"} isDisabled={recipientAtaStatus === "creating" || !walletSigner} onClick={() => void createRecipientAccount()} /></div>}
        <div className="builder-actions"><Button type="button" variant="primary" label={status === "preparing" ? "Checking payment…" : "Prepare payment"} isDisabled={status === "preparing" || status === "signing" || status === "pending"} onClick={() => void prepare()} /><span className="builder-safety"><Shield /> Wallet approval required to settle</span></div>
        {error && <div className="builder-error" role="alert"><b>{status === "pending" ? "Payment outcome unknown" : "Payment blocked"}</b><span>{error}</span></div>}
        {signature && prepared && <>
          <div className="success-box"><span>✓</span><div><b>Payment confirmed on Devnet</b><p className="receipt-public-url">Public receipt: <a href={publicReceiptPath(prepared.receiptAddress)}>{publicReceiptPath(prepared.receiptAddress)}</a></p></div></div>
          <details className="receipt-technical payment-settlement-details">
            <summary>Settlement transaction</summary>
            <p><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View on Solana Explorer <Arrow /></a></p>
          </details>
          <LoadedReceiptCard receiptPda={prepared.receiptAddress} shareMode="dashboard" />
        </>}
      </div>
      <div className="payment-review-stack"><div className="dashboard-card review-card"><div className="dashboard-card-heading"><div><span className="section-kicker">PAYMENT REVIEW</span><h2>{prepared ? "Payment review" : "Waiting for a request"}</h2></div><span className={`state-pill ${prepared?.preflight.valid ? "ok" : prepared ? "failed" : ""}`}><i /> {prepared ? (prepared.preflight.valid ? "Ready to approve" : "Needs attention") : "Waiting"}</span></div>{prepared ? <><div className="review-list payment-review-list"><div><span>Settlement amount</span><strong>{formatTokenAmount(prepared.request.amount, mintDecimals)} </strong></div><div><span>Stablecoin</span><strong>{stablecoinOptions.find((option) => option.mint === prepared.request.mint)?.label ?? shortAddress(prepared.request.mint)}</strong></div><div><span>Destination</span><strong className="mono">{shortAddress(prepared.request.recipient)}</strong></div><div><span>Signing wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><details className="technical-details" open={!prepared.preflight.valid}><summary>{prepared.preflight.valid ? "Policy checks passed" : "Policy issues to resolve"}</summary><div className="check-list">{prepared.preflight.checks.map((check) => <div key={check.name} className={check.ok ? "check-row ok" : "check-row failed"}><span>{check.ok ? "✓" : "×"}</span><b>{check.name}</b><small>{check.message}</small></div>)}</div></details><div className="state-box payment-readiness-message"><span className="soft-label">{prepared.preflight.valid ? "PAYMENT READY" : "PAYMENT NEEDS ATTENTION"}</span><p>{prepared.preflight.valid ? "Review the payment details, then approve in your wallet." : "The live policy checks rejected this payment. Review the issue before trying again."}</p></div><details className="technical-details"><summary>View policy details</summary><div className="state-box"><span className="soft-label">Live policy response</span><pre>{mcpPreflight || "No policy response returned."}</pre></div></details><div className="review-gate"><Shield /><span>Signing will request approval from <b>{wallet}</b>. The payment is complete only after its receipt is confirmed on-chain.</span></div><Button type="button" variant="primary" className="full-button" label={status === "signing" ? "Waiting for wallet…" : "Approve payment"} isDisabled={!prepared.preflight.valid || status === "signing" || status === "pending" || status === "success"} onClick={() => void signPayment()} /></> : <div className="review-empty"><div className="empty-icon">↗</div><p>Enter the payment details to review before approving.</p></div>}</div></div>
    </section>
    <details className="owner-batch-disclosure"><summary>Pay multiple recipients · CSV upload</summary><BatchPaymentsPanel wallet={wallet} walletSigner={walletSigner} mandates={mandates} stablecoinOptions={stablecoinOptions} onAskAgent={onAskAgent} onRefresh={onRefresh} /></details>
    </>
  );
}

const MAX_ATOMIC_BATCH_PAYMENTS = 4;

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
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "checking" | "ready" | "signing" | "pending" | "success" | "error">("idle");
  const settlementOperationKey = useRef<string | null>(null);
  useSettlementFormStatus(wallet, setStatus, settlementOperationKey);
  const [error, setError] = useState("");
  const [batchPrepared, setBatchPrepared] = useState<PreparedTransaction | null>(null);
  const [signature, setSignature] = useState("");
  const [aiReviewRequested, setAiReviewRequested] = useState(false);
  const [pendingRecipientCreates, setPendingRecipientCreates] = useState<RecipientAtaReview[]>([]);
  const [creatingRecipientAccount, setCreatingRecipientAccount] = useState<string | null>(null);

  useEffect(() => {
    const batchDraft = loadWalletDrafts(wallet).batch;
    if (batchDraft?.items.length) {
      setItems(batchDraft.items);
      setEntries(batchDraft.items.map((item) => ({ item, status: "imported" })));
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet || !items.length) return;
    saveWalletDrafts(wallet, { batch: { items, csvFileName: csvFile?.name } });
  }, [wallet, items, csvFile?.name]);

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
    } catch (cause) {
      setItems([]);
      setEntries([]);
      setCsvFile(null);
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

  async function collectPendingRecipientCreates() {
    const pending = new Map<string, RecipientAtaReview>();
    for (const item of items) {
      const selectedMandate = mandates.find((candidate) => candidate.address === item.mandateAddress);
      if (!selectedMandate) continue;
      const tokenProgram = selectedMandate.tokenProgram ?? await chainpayClient.getTokenProgram(selectedMandate.sourceTokenAccount);
      const destination = await resolvePaymentDestination(item.recipient, selectedMandate.allowedMint, tokenProgram, wallet);
      if (destination.createInstruction && !pending.has(destination.address)) {
        pending.set(destination.address, {
          ownerWallet: item.recipient.trim(),
          tokenAccount: destination.address,
          mint: selectedMandate.allowedMint,
          tokenProgram,
          createInstruction: destination.createInstruction,
        });
      }
    }
    return [...pending.values()];
  }

  async function createPendingRecipientAccount(review: RecipientAtaReview) {
    if (!walletSigner) return;
    setCreatingRecipientAccount(review.tokenAccount);
    setError("");
    try {
      await createRecipientTokenAccount(review, walletSigner, wallet);
      const remaining = pendingRecipientCreates.filter((candidate) => candidate.tokenAccount !== review.tokenAccount);
      setPendingRecipientCreates(remaining);
      if (!remaining.length) setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingRecipientAccount(null);
    }
  }

  async function prepareBatch() {
    if (!items.length) return;
    setStatus("checking");
    setError("");
    setBatchPrepared(null);
    setSignature("");
    const pendingCreates = await collectPendingRecipientCreates();
    if (pendingCreates.length) {
      setPendingRecipientCreates(pendingCreates);
      setStatus("error");
      setError(`${pendingCreates.length} recipient token account${pendingCreates.length === 1 ? "" : "s"} must be created before this batch can be prepared. Create each account separately, then check the batch again.`);
      return;
    }
    setPendingRecipientCreates([]);
    const nextEntries: BatchPaymentEntry[] = [];
    const seenInvoices = new Set<string>();

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
        if (destination.createInstruction) {
          throw new Error(`Recipient token account ${destination.address} must be created before batch preparation.`);
        }
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
      const batchKey = `batch:${wallet}:${batchFingerprint.slice(0, 24)}`;
      settlementOperationKey.current = batchKey;
      const result = await submitSignedTransaction(
        batchKey,
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
      <div className="batch-import-actions"><FileInput label="Choose CSV file" accept=".csv,text/csv" maxSize={512_000} value={csvFile} onChange={(file) => { const next = Array.isArray(file) ? file[0] ?? null : file; setCsvFile(next); void importCsv(next ?? undefined); }} /><Button type="button" variant="secondary" label="Download template" isDisabled={false} onClick={downloadBatchPaymentsTemplate} /></div>
      {error && <div className="builder-error"><b>Batch needs attention</b><span>{error}</span></div>}
      {pendingRecipientCreates.length > 0 && <div className="dashboard-card recipient-ata-review"><span className="section-kicker">RECIPIENT ACCOUNTS</span><h3>Create missing recipient token accounts</h3><p>Batch settlement never prepends account creation. Create each account in a separate wallet transaction, then check the batch again.</p>{pendingRecipientCreates.map((review) => <div className="review-list" key={review.tokenAccount}><div><span>Recipient</span><strong className="mono">{shortAddress(review.ownerWallet)}</strong></div><div><span>Token account</span><strong className="mono">{shortAddress(review.tokenAccount)}</strong></div><Button type="button" variant="secondary" label={creatingRecipientAccount === review.tokenAccount ? "Creating…" : "Create account"} isDisabled={creatingRecipientAccount !== null || !walletSigner} onClick={() => void createPendingRecipientAccount(review)} /></div>)}</div>}
      {entries.length > 0 && <>
        <div className="batch-list-meta"><span>{entries.length} of {MAX_ATOMIC_BATCH_PAYMENTS} payments imported</span><span>{entries.filter((entry) => entry.status === "ready" || entry.status === "settled").length} ready</span></div>
        <Table className="batch-payment-table" density="compact" dividers="rows">
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell scope="col">Row</TableHeaderCell>
              <TableHeaderCell scope="col">Invoice</TableHeaderCell>
              <TableHeaderCell scope="col">Amount</TableHeaderCell>
              <TableHeaderCell scope="col">Status</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              const token = entry.prepared?.request.mint ?? entry.item.requiredToken;
              const tokenLabel = stablecoinOptions.find((option) => option.mint === token)?.label;
              return (
                <TableRow className={`batch-payment-row ${entry.status}`} key={`${entry.item.row}-${entry.item.invoice}`}>
                  <TableCell>{entry.item.row}</TableCell>
                  <TableCell><strong>{entry.item.invoice}</strong><small>Mandate {shortAddress(entry.item.mandateAddress)} · Recipient {shortAddress(entry.item.recipient)}</small></TableCell>
                  <TableCell><strong>{entry.item.amount}</strong><small>{tokenLabel ?? (token ? shortAddress(token) : "Mandate token")}</small></TableCell>
                  <TableCell><span className={`state-pill ${entry.status === "ready" || entry.status === "settled" ? "ok" : entry.status === "blocked" ? "failed" : ""}`}><i /> {entry.status === "settled" ? "Settled" : entry.status === "ready" ? "Ready" : entry.status === "blocked" ? "Blocked" : "Imported"}</span>{entry.error && <small>{entry.error}</small>}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="batch-actions"><Button type="button" variant="secondary" label={aiReviewRequested ? "AI review sent" : "Ask AI to review"} isDisabled={status === "checking" || status === "signing"} onClick={askAiToReview} /><Button type="button" variant="primary" label={status === "checking" ? "Checking batch…" : "Check batch"} isDisabled={status === "checking" || status === "signing"} onClick={() => void prepareBatch()} /></div>
      </>}
      {batchPrepared && <div className="batch-readiness"><Shield /><div><b>Every row passed live policy and account checks</b><p>{batchPrepared.instructions.length} instructions will be signed and submitted directly. Finalized chain state determines whether the batch settled.</p></div><Button type="button" variant="primary" label={status === "signing" ? "Waiting for wallet…" : "Approve & settle batch"} isDisabled={status !== "ready" || !walletSigner} onClick={() => void approveAndSettleBatch()} /></div>}
      {signature && <div className="batch-success"><div><span className="soft-label">BATCH SETTLED</span><b>{entries.length} payments confirmed in one transaction.</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">Open batch transaction <Arrow /></a></div><div className="batch-receipt-cards">{entries.filter((entry) => entry.prepared).map((entry) => <div key={entry.item.row} className="batch-receipt-card"><span className="soft-label">{entry.item.invoice}</span><LoadedReceiptCard receiptPda={entry.prepared!.receiptAddress} shareMode="dashboard" /></div>)}</div></div>}
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
      blocks.push(<Table className="assistant-table" key={`table-${index}`} density="compact" dividers="rows">
        <TableHeader>
          <TableRow isHeaderRow>{header.map((cell, cellIndex) => <TableHeaderCell scope="col" key={cellIndex}>{inlineAssistantText(cell)}</TableHeaderCell>)}</TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIndex) => <TableRow key={rowIndex}>{row.map((cell, cellIndex) => <TableCell key={cellIndex}>{inlineAssistantText(cell)}</TableCell>)}</TableRow>)}
        </TableBody>
      </Table>);
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
  mint: string;
};

function ReceiptPanel({ mandates, stablecoinOptions, preparedReceiptAddresses, receiptDetail, onCallMcp }: { mandates: Mandate[]; stablecoinOptions: StablecoinOption[]; preparedReceiptAddresses?: Set<string>; receiptDetail?: string; onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse> }) {
  const { navigate } = useRoute();
  const [lookupMode, setLookupMode] = useState<"receipt" | "mandate">("receipt");
  const [receiptAddress, setReceiptAddress] = useState("");
  const [lookupMandate, setLookupMandate] = useState("");
  const [lookupInvoiceHash, setLookupInvoiceHash] = useState("");
  const [result, setResult] = useState("");
  const [lookupPda, setLookupPda] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [onChainReceipts, setOnChainReceipts] = useState<LedgerReceiptRow[]>([]);
  const [selectedReceiptAddress, setSelectedReceiptAddress] = useState("");
  const [receiptLoadStatus, setReceiptLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [receiptLoadError, setReceiptLoadError] = useState("");
  const [receiptLoadVersion, setReceiptLoadVersion] = useState(0);
  const [shareMessage, setShareMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const mandateKey = mandates.map((item) => item.address).sort().join("|");
  const stablecoinKey = stablecoinOptions.map((item) => `${item.mint}:${item.label}`).join("|");
  const detailReceiptAddress = receiptDetail?.trim() ?? "";
  const selectedReceipt = detailReceiptAddress
    ? onChainReceipts.find((item) => item.address === detailReceiptAddress) ?? { address: detailReceiptAddress, invoiceHash: "", recipientTokenAccount: "", executedAtSlot: "", settled: false, amountLabel: "Receipt", tokenLabel: "…", mint: "" }
    : onChainReceipts.find((item) => item.address === selectedReceiptAddress) ?? null;
  const settledCount = onChainReceipts.filter((item) => item.settled).length;

  useEffect(() => {
    if (detailReceiptAddress) setSelectedReceiptAddress(detailReceiptAddress);
  }, [detailReceiptAddress]);

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
          mint: receipt.mint,
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
        details.some((receipt) => receipt.address === current) ? current : ""
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
    setLookupError("");
    let pda = lookupMode === "receipt" ? receiptAddress.trim() : "";
    if (lookupMode === "mandate") {
      if (!lookupMandate.trim() || !lookupInvoiceHash.trim()) return;
      try {
        if (!/^[0-9a-fA-F]{64}$/.test(lookupInvoiceHash.trim())) throw new Error("Enter a 64-character hexadecimal invoice hash.");
        pda = deriveReceiptAddress(lookupMandate.trim(), hexToBytes(lookupInvoiceHash.trim()), PROGRAM_ID);
      } catch (cause) {
        setLookupPda("");
        setLookupError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
    }
    if (!pda) return;
    try { new PublicKey(pda); } catch { setLookupError("Enter a valid Solana receipt address."); return; }
    setLoading(true);
    setShareMessage("");
    setLookupPda(pda);
    try {
      const response = await onCallMcp("get_payment", lookupMode === "receipt"
        ? { receiptAddress: pda }
        : { mandate: lookupMandate.trim(), invoiceHash: lookupInvoiceHash.trim() });
      setResult(toolText(response));
    } catch (cause) {
      setLookupError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return <section className="receipt-page">
    {detailReceiptAddress && (
      <div className="mandate-create-toolbar">
        <div><span className="section-kicker">RECEIPT DETAIL</span><h2>{selectedReceipt?.amountLabel ?? "Receipt"} {selectedReceipt?.tokenLabel ?? ""}</h2></div>
        <Button type="button" variant="secondary" label="Back to payments" isDisabled={false} onClick={() => navigate({ kind: "app", tab: "receipts" }, { replace: true })} />
      </div>
    )}
    <div className="dashboard-card onchain-receipts-card" hidden={Boolean(detailReceiptAddress)}>
      <div className="dashboard-card-heading"><div><span className="section-kicker">ON-CHAIN RECEIPTS</span><h2>Payment history</h2></div><div className="receipt-ledger-heading-actions"><span className="chip chip-muted">{settledCount} settled</span><Button type="button" variant="secondary" className="refresh-button" label="Refresh" icon={<RefreshCw size={16} />} isDisabled={receiptLoadStatus === "loading"} onClick={() => setReceiptLoadVersion((value) => value + 1)} /></div></div>
      <p className="builder-intro">Select a payment to view or share its receipt.</p>
      {receiptLoadStatus === "loading" ? <div className="receipt-ledger-empty" aria-busy="true"><Skeleton width="100%" height={72} /><p>Reading Devnet receipts…</p></div> : receiptLoadStatus === "error" && onChainReceipts.length === 0 ? <div className="receipt-ledger-empty"><CircleAlert size={28} /><h3>Payment history is unavailable</h3><p>Refresh to try again. Your recorded payments are unchanged.</p></div> : onChainReceipts.length === 0 ? <div className="receipt-ledger-empty"><p>No receipts yet — one is written on chain for every settled payment.</p><SampleReceiptOutline /></div> : <Table className="receipt-ledger-table" density="compact" dividers="rows" hasHover>
        <TableHeader>
          <TableRow isHeaderRow>
            <TableHeaderCell scope="col">Amount</TableHeaderCell>
            <TableHeaderCell scope="col">Status</TableHeaderCell>
            <TableHeaderCell scope="col">Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {onChainReceipts.map((receipt) => {
            const selected = receipt.address === selectedReceipt?.address;
            return (
              <TableRow className={`receipt-ledger-row ${selected ? "is-selected" : ""}`} key={receipt.address}>
                <TableCell>
                  <button type="button" className="receipt-ledger-main" onClick={() => setSelectedReceiptAddress(receipt.address)} aria-label={`Preview ${receipt.tokenLabel} receipt ${receipt.address}`}>
                    <TokenIcon mint={receipt.mint} />
                    <span className="receipt-ledger-payment"><strong>{receipt.amountLabel} {receipt.tokenLabel}</strong><small>Invoice {shortAddress(receipt.invoiceHash)} · to {shortAddress(receipt.recipientTokenAccount)}</small></span>
                  </button>
                </TableCell>
                <TableCell><span className="receipt-ledger-status"><strong>{receipt.settled ? "Settled" : "Unsettled"}</strong><small>Slot {receipt.executedAtSlot}</small></span></TableCell>
                <TableCell>
                  <div className="receipt-ledger-actions">
                    <Button type="button" variant="ghost" href={buildPath({ kind: "app", tab: "receipts", receiptDetail: receipt.address })} label="Open receipt" icon={<ArrowUpRight size={18} />} />
                    <IconButton type="button" variant="ghost" label={`Share receipt ${receipt.address}`} icon={<Share2 size={18} />} onClick={() => void sendReceipt(receipt)} />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>}
      {receiptLoadError && <small className={receiptLoadStatus === "error" ? "receipt-ledger-error" : "receipt-ledger-warning"}>{receiptLoadError}</small>}
    </div>
    {selectedReceipt && <div className="dashboard-card receipt-preview-card"><div className="dashboard-card-heading"><div><span className="section-kicker">{detailReceiptAddress ? "RECEIPT DETAIL" : "RECEIPT PREVIEW"}</span><h2 className="owner-token-heading"><TokenIcon mint={selectedReceipt.mint} />Payment receipt</h2></div>{!detailReceiptAddress && <Button type="button" variant="ghost" href={buildPath({ kind: "app", tab: "receipts", receiptDetail: selectedReceipt.address })} label="Open full page" isDisabled={false} />}</div><LoadedReceiptCard receiptPda={selectedReceipt.address} shareMode="dashboard" preparedInRequests={preparedReceiptAddresses?.has(selectedReceipt.address) ?? false} onShare={() => void sendReceipt(selectedReceipt)} /></div>}
    {shareMessage && <div className="receipt-share-message" role="status">{shareMessage}</div>}
    <details className="dashboard-card receipt-lookup"><summary className="owner-lookup-summary"><span className="owner-row-icon neutral"><Search /></span><span><strong>Find a receipt</strong><small>Advanced lookup by receipt address or payment reference</small></span><ChevronDown size={18} /></summary><div className="owner-lookup-intro"><h2>Verify a payment</h2><p>Find a receipt directly from the chain, even if it isn’t in your payment history.</p></div>
      <TabList className="receipt-lookup-tabs" value={lookupMode} onChange={(value) => { setLookupMode(value as "receipt" | "mandate"); setLookupPda(""); setResult(""); setLookupError(""); }} role="tablist" aria-label="Receipt lookup type">
        <Tab value="receipt" label="Receipt address" panelId="receipt-lookup-pda" />
        <Tab value="mandate" label="Permission + invoice" panelId="receipt-lookup-mandate" />
      </TabList>
      {lookupMode === "receipt" ? <div className="receipt-search" id="receipt-lookup-pda" role="tabpanel">
        <TextInput label="Receipt address" value={receiptAddress} onChange={(value) => { setReceiptAddress(value); setLookupPda(""); setLookupError(""); }} onEnter={() => void lookup()} placeholder="Paste the full receipt address" />
        <Button type="button" variant="primary" label={loading ? "Looking up…" : "Find receipt"} isDisabled={loading || !receiptAddress.trim()} onClick={() => void lookup()} />
      </div> : <div className="receipt-search receipt-search-grid" id="receipt-lookup-mandate" role="tabpanel">
        <TextInput label="Spending permission address" value={lookupMandate} onChange={(value) => { setLookupMandate(value); setLookupPda(""); setLookupError(""); }} placeholder="Mandate address" />
        <TextInput label="Invoice hash" value={lookupInvoiceHash} onChange={(value) => { setLookupInvoiceHash(value); setLookupPda(""); setLookupError(""); }} onEnter={() => void lookup()} placeholder="64-character invoice hash" />
        <Button type="button" variant="primary" label={loading ? "Looking up…" : "Find receipt"} isDisabled={loading || !lookupMandate.trim() || !lookupInvoiceHash.trim()} onClick={() => void lookup()} />
      </div>}
      {lookupError && <p className="builder-error" role="alert">{lookupError}</p>}
      {lookupPda && <LoadedReceiptCard receiptPda={lookupPda} shareMode="dashboard" preparedInRequests={preparedReceiptAddresses?.has(lookupPda) ?? false} />}
      {result && <details className="receipt-raw"><summary>Technical lookup response</summary><div className="state-box receipt-result"><pre>{result}</pre></div></details>}
    </details>
  </section>;
}

function AgentsTabPanel({
  connectionStatus,
  serverUrl,
  wallet,
  mandates,
  stablecoinOptions,
  connections,
  hostedAssistantStatus,
  connectDialogInitiallyOpen = false,
  onConnected,
  onRevoked,
  onCreateMandate,
  onOpenAssistant,
}: {
  connectionStatus: "idle" | "loading" | "ready" | "error";
  serverUrl: string;
  wallet: string;
  mandates: Mandate[];
  stablecoinOptions: StablecoinOption[];
  connections: AgentConnection[];
  hostedAssistantStatus: "unknown" | "available" | "unavailable";
  connectDialogInitiallyOpen?: boolean;
  onConnected: (connection: AgentConnection) => void;
  onRevoked: (id: string) => Promise<void>;
  onCreateMandate: () => void;
  onOpenAssistant: () => void;
}) {
  const [pairDialogOpen, setPairDialogOpen] = useState(connectDialogInitiallyOpen);
  useEffect(() => {
    if (connectDialogInitiallyOpen) setPairDialogOpen(true);
  }, [connectDialogInitiallyOpen]);

  return (
    <section className="page-panel agents-tab-panel">
      {connectionStatus === "error" && <p role="alert" className="builder-error">Agent connections could not be refreshed. Showing the last available records.</p>}
      {connectionStatus === "loading" && <p role="status">Refreshing agent connections…</p>}

      <ConnectMcpPanel
        serverUrl={serverUrl}
        wallet={wallet}
        mandates={mandates}
        stablecoinOptions={stablecoinOptions}
        connections={connections}
        dialogOpen={pairDialogOpen}
        onDialogOpenChange={setPairDialogOpen}
        onConnected={onConnected}
        onRevoked={onRevoked}
        onCreateMandate={onCreateMandate}
      />
    </section>
  );
}

function AgentRequirementChecklist({ requirements }: { requirements: AgentRequirements }) {
  const statusLabel = requirements.status === "ready" ? "Ready for approval" : requirements.status === "blocked" ? "Blocked" : "Details needed";
  return <div className={`agent-requirement-checklist ${requirements.status}`}>
    <div className="agent-requirement-heading"><span className="soft-label">CHECKS BEFORE APPROVAL</span><span className="state-pill"><i /> {statusLabel}</span></div>
    <div className="agent-requirement-grid">{requirements.checks.map((check) => <div className={`agent-requirement-row ${check.status}`} key={check.key}><span>{check.status === "pass" ? "✓" : check.status === "fail" ? "×" : check.status === "missing" ? "!" : "·"}</span><div><b>{check.label}</b><small>{check.detail}</small></div></div>)}</div>
    {requirements.missing.length > 0 && <p className="agent-requirement-missing"><b>Please provide:</b> {requirements.missing.join(" · ")}</p>}
  </div>;
}

function AgentInboxPanel({ inbox, approvalStatuses, approvalErrors, stablecoinOptions, mandateDecimals, mandate, onApprove, onArchive, onRestore }: { inbox: AgentInboxItem[]; approvalStatuses: Record<string, ApprovalStatus>; approvalErrors: Record<string, string>; stablecoinOptions: StablecoinOption[]; mandateDecimals: number | null; mandate: Mandate | null; onApprove: (id: string) => Promise<void>; onArchive: (id: string) => void; onRestore: (id: string) => void }) {
  const [filter, setFilter] = useState("attention");
  const [selected, setSelected] = useState<string | null>(null);
  const matches = (item: AgentInboxItem) => {
    if (filter === "archived") return isInboxItemArchived(item);
    if (isInboxItemArchived(item)) return false;
    const complete = ["approved", "receipt_ready"].includes(item.stage);
    const needsAction = ["waiting_for_approval", "needs_details", "blocked"].includes(item.stage);
    return filter === "completed" ? complete : filter === "attention" ? needsAction : !complete && !needsAction;
  };
  const visible = inbox.filter(matches);
  return <section className="dashboard-card owner-inbox"><TabList role="tablist" value={filter} onChange={(value) => { setFilter(String(value)); setSelected(null); }} aria-label="Request status"><Tab value="attention" label="Needs attention" panelId="request-attention" /><Tab value="progress" label="In progress" panelId="request-progress" /><Tab value="completed" label="Completed" panelId="request-completed" /><Tab value="archived" label="Archived" panelId="request-archived" /></TabList><div id={`request-${filter}`} role="tabpanel" aria-label={filter === "attention" ? "Needs attention" : filter}>
    {!visible.length && <div className="owner-small-empty"><Inbox /><h2>{filter === "attention" ? "Nothing needs your attention" : "No requests here yet"}</h2><p>{filter === "attention" ? "Requests that need your approval or more details will appear here." : "Track your requests as they move through payment and completion."}</p></div>}
    {visible.map((item) => <article className="owner-request-record" key={item.id}><button className="owner-request-summary" aria-expanded={selected === item.id} onClick={() => setSelected(selected === item.id ? null : item.id)}><span className="owner-row-icon neutral"><Inbox /></span><span><strong>{item.title || "Payment request"}</strong><small>{new Date(item.createdAt).toLocaleString()}</small></span><span className="owner-status">{item.stage === "waiting_for_approval" ? "Approval needed" : item.stage.replaceAll("_", " ")}</span><ChevronDown size={16} /></button>{selected === item.id && <div className="owner-request-body"><PurchaseCard purchase={purchaseCardFromInboxItem(item, { stablecoinOptions, mandateDecimals, mandate })} />{item.attachments.length > 0 && <div className="agent-attachment-previews">{item.attachments.map((attachment) => <div className="agent-attachment-preview" key={attachment.name}>{attachment.previewUrl && <img src={attachment.previewUrl} alt="" />}<span>{attachment.name}</span></div>)}</div>}
      {item.requirements && item.requirements.status !== "ready" && <AgentRequirementChecklist requirements={item.requirements} />}
      {item.approval && item.stage === "waiting_for_approval" && <AgentApprovalCard approval={item.approval} status={approvalStatuses[item.id] ?? "idle"} error={approvalErrors[item.id] ?? item.error ?? ""} stablecoinOptions={stablecoinOptions} decimals={item.approval.payment?.mint === mandate?.allowedMint ? mandateDecimals : null} onApprove={() => onApprove(item.id)} />}
      {item.stage === "receipt_ready" && <InboxReceipt receiptAddress={item.outcome?.receiptAddress} preparedInRequests />}
      <details className="technical-details"><summary>Request details</summary><p>{item.prompt}</p><AssistantMessage value={item.response} className="agent-inbox-response" />{item.requirements?.status === "ready" && <AgentRequirementChecklist requirements={item.requirements} />}</details>
      {isInboxItemArchived(item) ? <Button label="Restore request" variant="secondary" onClick={() => onRestore(item.id)} /> : ["approved", "receipt_ready"].includes(item.stage) && <Button label="Archive request" variant="secondary" onClick={() => onArchive(item.id)} />}
    </div>}</article>)}
  </div></section>;

}

function AssistantPanel({ prompt, setPrompt, reply, thinking, listening, agentToolsUsed, inbox, approvalStatuses, approvalErrors, attachments, attachmentError, stablecoinOptions, mandateDecimals, mandate, sessionReady, onSignIn, onAsk, onVoice, onLoadDemoInvoice, onApprove, onAddAttachments, onRemoveAttachment, onArchive, onRestore, onCallMcp }: { prompt: string; setPrompt: (value: string) => void; reply: string; thinking: boolean; listening: boolean; agentToolsUsed: string[]; inbox: AgentInboxItem[]; approvalStatuses: Record<string, ApprovalStatus>; approvalErrors: Record<string, string>; attachments: AgentAttachment[]; attachmentError: string; stablecoinOptions: StablecoinOption[]; mandateDecimals: number | null; mandate: Mandate | null; sessionReady: boolean; onSignIn: () => void; onAsk: () => void; onVoice: () => void; onLoadDemoInvoice: () => void; onApprove: (id: string) => Promise<void>; onAddAttachments: (files: FileList | File[]) => Promise<void>; onRemoveAttachment: (name: string) => void; onArchive: (id: string) => void; onRestore: (id: string) => void; onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse> }) {
  const [composing, setComposing] = useState(false);
  return <section className="owner-requests">
    <div className="owner-page-actions"><Button label={composing ? "Close composer" : "New request"} variant={composing ? "secondary" : "primary"} icon={composing ? <X size={18} /> : <Plus size={18} />} onClick={() => setComposing(!composing)} /></div>
    <div hidden={!composing} className="dashboard-card assistant-card"><div className="dashboard-card-heading"><h2>What would you like to pay for?</h2></div><p className="owner-muted">Describe the payment or attach an invoice.</p><div className="assistant-attachments">{attachments.map((attachment) => <span className="assistant-attachment-chip" key={attachment.name}>{attachment.name}<IconButton variant="ghost" label={`Remove ${attachment.name}`} icon={<X size={16} />} onClick={() => onRemoveAttachment(attachment.name)} /></span>)}</div>{attachmentError && <p role="alert">{attachmentError}</p>}<div className="assistant-input"><TextInput label="Request" value={prompt} onChange={setPrompt} onEnter={onAsk} placeholder="Describe a payment or paste an invoice" /><FileInput label="Attach invoice" isMultiple accept="image/*,.pdf,.csv,.json,.txt,.md" value={null} onChange={(files) => { if (files) onAddAttachments(Array.isArray(files) ? files : [files]); }} /><Button label={thinking ? "Checking…" : "Send request"} variant="primary" isDisabled={thinking} onClick={onAsk} /></div><div className="owner-composer-options"><Button label={listening ? "Stop voice input" : "Use voice input"} variant="ghost" onClick={onVoice} /><details><summary>Try a Devnet request</summary><Button label="Create signed demo request" variant="secondary" isDisabled={thinking} onClick={onLoadDemoInvoice} /></details></div>{reply && <div className="assistant-log"><AssistantMessage value={reply} className="assistant-response" />{agentToolsUsed.length > 0 && <details><summary>Technical activity</summary>{agentToolsUsed.map((tool, index) => <span key={`${tool}-${index}`}>{tool} </span>)}</details>}</div>}</div>
    <AgentInboxPanel inbox={inbox} approvalStatuses={approvalStatuses} approvalErrors={approvalErrors} stablecoinOptions={stablecoinOptions} mandateDecimals={mandateDecimals} mandate={mandate} onApprove={onApprove} onArchive={onArchive} onRestore={onRestore} />
    <details className="dashboard-card owner-service-requests"><summary><img className="owner-service-logo" src={x402Logo} alt="x402" />Paid API requests</summary><X402JobsPanel sessionReady={sessionReady} onSignIn={onSignIn} onCallMcp={onCallMcp} /></details>
  </section>;
}

function AgentApprovalCard({ approval, status, error, stablecoinOptions, decimals, onApprove }: { approval: AgentApproval; status: ApprovalStatus; error: string; stablecoinOptions: StablecoinOption[]; decimals: number | null; onApprove: () => Promise<void> }) {
  const instructionNames = approval.transaction?.instructions?.map((instruction) => instruction.name).join(" + ") || "mandate transaction";
  const isPayment = approval.kind === "payment";
  const isTokenAccount = approval.kind === "token_account";
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
  return <div className="agent-approval-card"><div className="agent-approval-heading"><div><span className="section-kicker">WALLET APPROVAL</span><h3>{isPayment ? "Approve payment" : isTokenAccount ? "Create token account" : "Approve this mandate once"}</h3></div><span className={`state-pill ${status === "error" ? "failed" : status === "success" ? "ok" : ""}`}><i /> {status === "pending" ? "Pending settlement" : status === "signing" ? "Waiting" : status === "success" ? "Approved" : status === "error" ? "Needs attention" : "Ready"}</span></div><p>{isPayment ? "Review the amount, recipient, and policy checks below. Approve in your wallet to complete the payment." : isTokenAccount ? "The AI prepared one canonical token-account creation. Approving spends Devnet SOL for account rent; it does not fund the account or authorize payments." : "The AI prepared this spending policy. Approve it once; future policy-compliant payments can settle without another wallet prompt."}</p><div className="agent-approval-details">{isPayment ? <><span><b>Amount</b><code>{displayAmount}</code></span><span><b>Recipient</b>{typeof payment?.recipient === "string" ? <code>{shortAddress(payment.recipient)}</code> : "See wallet"}</span><span><b>Receipt</b>{approval.receiptAddress && typeof approval.receiptAddress === "string" ? <code>{shortAddress(approval.receiptAddress)}</code> : "Prepared"}</span></> : isTokenAccount ? <><span><b>Mint</b>{approval.mint ? <code>{shortAddress(approval.mint)}</code> : "Enabled asset"}</span><span><b>Token account</b>{approval.tokenAccount ? <code>{shortAddress(approval.tokenAccount)}</code> : "Canonical ATA"}</span><span><b>Wallet</b>{approval.transaction?.feePayer ? <code>{shortAddress(approval.transaction.feePayer)}</code> : "Connected owner"}</span></> : <><span><b>Mandate</b>{approval.mandateAddress ? <code>{shortAddress(approval.mandateAddress)}</code> : "New policy"}</span><span><b>Instructions</b>{instructionNames}</span><span><b>Wallet</b>{approval.transaction?.feePayer ? <code>{shortAddress(approval.transaction.feePayer)}</code> : "Connected owner"}</span></>}</div>{error && <div className="builder-error"><b>Approval blocked</b><span>{error}</span></div>}<Button type="button" variant="primary" className="full-button" label={status === "signing" ? "Waiting for wallet…" : status === "success" ? "Approved" : isPayment ? "Approve payment in wallet" : isTokenAccount ? "Create account in wallet" : "Approve wallet once"} isDisabled={status === "signing" || status === "pending" || status === "success"} onClick={() => void onApprove()} /></div>;
}

function ToolsPanel({ mcpTools }: { mcpTools: McpTool[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const liveToolNames = new Set(mcpTools.map((tool) => tool.name));
  const tools = mcpTools.length ? [...mcpTools, ...coreToolReferences.filter((tool) => !liveToolNames.has(tool.name))] : coreToolReferences;

  // Deterministic order. The live list arrives in whatever order the server
  // returns, so the page used to reshuffle between reads.
  const grouped = [...TOOL_GROUPS, { id: "other" as const, label: "Other", blurb: "" }]
    .map((group) => ({
      group,
      members: tools
        .filter((tool) => toolGroup(tool.name) === group.id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((entry) => entry.members.length > 0);

  return <section className="page-panel tools-panel">
    <p className="tools-surface-note">
      <b>{tools.length} tools.</b> Technical reference for connected agents.
      Each connection can call only the tools allowed by its scope.
    </p>
    {grouped.map(({ group, members }) => (
      <div className="tool-group" key={group.id}>
        <div className="tool-group-head">
          <h2>{group.label}</h2>
          <span className="chip chip-muted">{members.length}</span>
          {group.blurb ? <p>{group.blurb}</p> : null}
        </div>
        <ul className="tool-rows">
          {members.map((tool) => {
            const schema = "inputSchema" in tool && tool.inputSchema ? tool.inputSchema : { type: "object", properties: {}, additionalProperties: false };
            const required = requiredParams(schema);
            const open = expanded === tool.name;
            return (
              <li className="tool-row" key={tool.name}>
                <div className="tool-row-main">
                  <code className="tool-row-name">{tool.name}</code>
                  <p className="tool-row-desc">{tool.description ?? "ChainPay agent tool"}</p>
                  {required.length > 0 && (
                    <p className="tool-row-required">
                      <span>Requires</span> <code>{required.join(", ")}</code>
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="tool-row-toggle"
                  label={open ? "Hide schema" : "Input schema"}
                  isDisabled={false}
                  onClick={() => setExpanded(open ? null : tool.name)}
                  aria-expanded={open}
                />
                {open && (
                  <pre className="schema-block" tabIndex={0} aria-label={`Input schema for ${tool.name}`}>
                    {JSON.stringify(schema, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    ))}
  </section>;
}


function ConnectMcpPanel({ serverUrl, wallet, mandates, stablecoinOptions, connections, dialogOpen, onDialogOpenChange, onConnected, onRevoked, onCreateMandate }: { serverUrl: string; wallet: string; mandates: Mandate[]; stablecoinOptions: StablecoinOption[]; connections: AgentConnection[]; dialogOpen?: boolean; onDialogOpenChange?: (open: boolean) => void; onConnected: (connection: AgentConnection) => void; onRevoked: (id: string) => Promise<void>; onCreateMandate: () => void }) {
  const ownedAddresses = ownedMandateAddresses(mandates, wallet);
  const ownedMandates = mandates.filter((mandate) => ownedAddresses.includes(mandate.address));
  const mandateOptions = mandates
    .filter((mandate) => ownedAddresses.includes(mandate.address))
    .map((mandate) => ({
      value: mandate.address,
      label: mandateDisplayName(mandate, mandates, stablecoinOptions),
      description: shortAddress(mandate.address),
    }));
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const dialogControlled = dialogOpen !== undefined;
  const isDialogOpen = dialogControlled ? dialogOpen : internalDialogOpen;
  const setDialogOpen = (open: boolean) => {
    if (dialogControlled) onDialogOpenChange?.(open);
    else setInternalDialogOpen(open);
  };
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [scope, setScope] = useState("");
  const [allowPayments, setAllowPayments] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [connectionToken, setConnectionToken] = useState("");
  const [connectionHandoff, setConnectionHandoff] = useState<McpConnectionHandoff | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const config = buildMcpClientConfig(serverUrl, connectionToken || undefined);
  const firstPrompt = connectionHandoff ? buildMcpFirstPrompt(connectionHandoff) : "";

  const ownedKey = ownedAddresses.join(",");
  useEffect(() => {
    if (scope && !ownedKey.split(",").includes(scope)) setScope("");
  }, [ownedKey, scope]);

  function copyConfig() {
    copyValue(config);
    setConfigCopied(true);
    window.setTimeout(() => setConfigCopied(false), 2200);
  }

  function copyFirstPrompt() {
    if (!firstPrompt) return;
    copyValue(firstPrompt);
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 2200);
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
      const selectedMandate = ownedMandates.find((mandate) => mandate.address === scope);
      const result = await registerMcpConnection(wallet, createdAgentName, buildConnectionScope(scope, ownedMandates, allowPayments));
      onConnected({ ...result.connection, mandates: 1 });
      setConnectionId(result.connection.id);
      setConnectionName(createdAgentName);
      setConnectionToken(result.token);
      setConnectionHandoff({
        agentName: createdAgentName,
        mandateAddress: scope,
        mandateLabel: selectedMandate
          ? mandateDisplayName(selectedMandate, mandates, stablecoinOptions)
          : undefined,
        paymentsPermitted: allowPayments,
      });
      setConfigCopied(false);
      setPromptCopied(false);
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
    {connectionToken && connectionHandoff && <section className="dashboard-card connection-config-card">
      <div className="dashboard-card-heading">
        <h2>Finish connecting {connectionName}</h2>
        <span className="owner-status">Ready to paste</span>
      </div>
      <p className="connection-handoff-intro">Paste the configuration into any MCP client, then send the first prompt so the agent inspects your permission before spending.</p>
      <div className="connection-handoff-scope">
        <span className="section-kicker">THIS CONNECTION</span>
        <p><strong>{connectionHandoff.mandateLabel ?? "Spending permission"}</strong></p>
        <p>{connectionAccessLabel(connectionHandoff.paymentsPermitted)} · Token shown once · Solana Devnet</p>
      </div>
      <ol className="connection-handoff-steps">
        <li><strong>Copy configuration</strong><span>Paste into your MCP client settings.</span></li>
        <li><strong>Send first prompt</strong><span>Starts read-only: inspect tools and your permission.</span></li>
        <li><strong>Ask when ready</strong><span>Payments only after you explicitly request them.</span></li>
      </ol>
      <div className="connection-handoff-actions">
        <Button label={configCopied ? "Copied" : "Copy configuration"} variant="primary" icon={<Copy size={16} />} onClick={copyConfig} />
        <Button label={promptCopied ? "Copied" : "Copy first prompt"} variant="secondary" icon={<Copy size={16} />} onClick={copyFirstPrompt} />
      </div>
      <details className="technical-details"><summary>View configuration</summary><pre className="schema-block">{config}</pre></details>
      <details className="technical-details"><summary>View first prompt</summary><pre className="schema-block connection-prompt-block">{firstPrompt}</pre></details>
      <p className="connection-safety-note" role="note"><ShieldCheck className="shield-icon" aria-hidden /> Never paste the connection token into chat, commits, or public prompts. Revoke and recreate if it leaks.</p>
    </section>}
    <div className="dashboard-card connected-clients-card"><div className="dashboard-card-heading"><h2>Connected agents</h2><Button type="button" variant="primary" label="Connect agent" icon={<Plus size={18} />} onClick={() => { setAllowPayments(false); setDialogOpen(true); }} /></div>{connections.length ? <div className="connection-list">{connections.map((connection) => <article className="owner-connection" key={connection.id}><div className="owner-connection-heading"><span className="owner-row-icon neutral"><Bot /></span><div><h3>{connection.agentName}</h3><p>{connectionSeenLabel(connection.lastSeenAt)}</p></div><span className={`owner-status ${connectionIsLive(connection.lastSeenAt) ? "good" : ""}`}>{connectionIsLive(connection.lastSeenAt) ? "Connected" : "Configured"}</span><Button variant="ghost" label={`Revoke ${connection.agentName}`} onClick={() => setRevokeId(connection.id)} /></div><p>{connectionScopeDetails(connection.scope).label}</p><details className="technical-details"><summary>Connection details and activity</summary><p>Owner: {connection.wallet}</p><p>{connection.mandates} associated spending permission{connection.mandates === 1 ? "" : "s"}</p><div className="connection-tools">{connection.toolsCalled.length ? connection.toolsCalled.map((tool) => <span className="tool-call-chip" key={tool.name}>{tool.name} <b>×{tool.count}</b></span>) : <span>No tool activity recorded.</span>}</div></details></article>)}</div> : <div className="owner-small-empty"><Bot /><h3>Your agents will appear here</h3><p>Connect an agent and choose the spending permission it can use.</p></div>}</div>
    <Dialog isOpen={isDialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }} purpose="form" width={480}>
      <Layout
        height="auto"
        header={<DialogHeader title="Connect an agent" onOpenChange={(open) => { if (!open) closeDialog(); }} />}
        content={
          <LayoutContent>
            <div className="connection-form">
              <p>Name your agent, choose a spending permission, and decide whether it may execute payments. You will receive a private MCP configuration to paste into any client.</p>
              <TextInput label="Agent name" value={agentName} onChange={setAgentName} placeholder="Invoice agent" />
              {mandateOptions.length ? (
                <Selector
                  label="Spending permission"
                  value={scope}
                  onChange={setScope}
                  options={mandateOptions}
                  description="Connections can only use a mandate this wallet owns."
                />
              ) : (
                <p className="builder-error"><b>No owned mandate</b><span>Create a mandate first. You cannot type another owner’s address.</span></p>
              )}
              <CheckboxInput
                label="Allow payments within this permission"
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
              <Button type="button" variant="primary" label="Create spending permission" isDisabled={false} onClick={() => { closeDialog(); onCreateMandate(); }} />
            )}
          </LayoutFooter>
        }
      />
    </Dialog>
    <ConfirmDialog open={Boolean(revokeId)} title="Revoke this connection?" description="This agent will no longer be able to call ChainPay tools with this connection." confirmLabel="Revoke connection" onClose={() => setRevokeId(null)} onConfirm={() => { const id = revokeId; setRevokeId(null); if (id) void onRevoked(id).then(() => { if (id === connectionId) { setConnectionId(""); setConnectionName(""); setConnectionToken(""); setConnectionHandoff(null); } }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} />
  </section>;
}

function SettingsPanel({ advancedOpen, onAdvancedOpenChange, onAdvanced, wallet, walletName, walletIcon, walletCapabilities, stablecoinOptions, activeMandateCount, dangerStatus, onRevokeAll, onDisconnect, onChangeWallet }: { wallet: string; walletName: string; walletIcon?: string; walletCapabilities?: WalletCapabilityReport | null; stablecoinOptions: StablecoinOption[]; activeMandateCount: number; dangerStatus: string; onRevokeAll: () => void; onDisconnect: () => void; onChangeWallet: () => void; advancedOpen: boolean; onAdvancedOpenChange: (open: boolean) => void; onAdvanced: (tab: "tools" | "protocol" | "connect-mcp") => void }) {
  const [confirmAction, setConfirmAction] = useState<"revoke" | "disconnect" | null>(null);
  const [mcpCopyStatus, setMcpCopyStatus] = useState("");
  const capability = walletCapabilities ?? null;
  const capabilityCopy = capability ? describeWalletCapabilities(capability) : null;
  return <section className="owner-settings">
    <section className="dashboard-card owner-account-card"><div className="owner-settings-heading"><span className="owner-row-icon neutral"><Wallet /></span><div><h2>Wallet & account</h2><p>Your connected wallet is your workspace identity.</p></div></div><div className="owner-account-identity"><div className="owner-account-wallet"><WalletBrandMark name={walletName} icon={walletIcon} size={28} fallback /><div><strong>{walletName || "Solana wallet"}</strong><span>{shortAddress(wallet)}</span></div></div><Button label="Copy address" variant="secondary" icon={<Copy size={16} />} onClick={() => void copyValue(wallet)} /></div><div className="owner-settings-row"><div><strong>Connected wallet</strong><p className="owner-full-address">{wallet}</p></div><Button label="Change wallet" variant="secondary" onClick={onChangeWallet} /></div></section>
    <section className="dashboard-card"><div className="owner-settings-heading"><span className="owner-row-icon neutral"><ShieldCheck /></span><div><h2>Network</h2><p>Where your permissions and payments are recorded.</p></div></div><div className="owner-settings-row"><div className="owner-token-heading"><img className="owner-network-logo" src={solWalletImage} alt="" /><div><strong>Solana Devnet</strong><p>Test network · Devnet tokens only</p></div></div><span className="owner-status">Current network</span></div></section>
    <TokenAddresses options={stablecoinOptions} wallet={wallet} />
    <details className="dashboard-card owner-advanced-settings" open={advancedOpen} onToggle={(event) => onAdvancedOpenChange(event.currentTarget.open)}><summary className="owner-lookup-summary"><span className="owner-row-icon neutral"><Settings2 /></span><span><strong>Advanced settings</strong><small>Integration tools and wallet diagnostics</small></span><ChevronDown size={18} /></summary><div className="owner-settings-row owner-mcp-settings"><div><strong>MCP connection</strong><p>Connect an agent to your workspace using this server address.</p><code className="owner-mcp-endpoint">{MCP_URL}</code>{mcpCopyStatus && <p role="status">{mcpCopyStatus}</p>}</div><div className="owner-mcp-actions"><Button label={mcpCopyStatus === "Copied" ? "Copied" : "Copy MCP address"} variant="secondary" icon={<Copy size={16} />} onClick={() => void copyValue(MCP_URL).then((copied) => setMcpCopyStatus(copied ? "Copied" : "Could not copy. Select the server address to copy it manually."))} /><Button label="Connect agent" variant="secondary" onClick={() => onAdvanced("connect-mcp")} /></div></div><div className="owner-settings-row"><div><strong>Developer tools</strong><p>Inspect the tools available to agent integrations.</p></div><Button label="Developer tools" variant="secondary" onClick={() => onAdvanced("tools")} /></div><div className="owner-settings-row"><div><strong>Protocol administration</strong><p>Manage protocol configuration with the authority wallet.</p></div><Button label="Protocol administration" variant="secondary" onClick={() => onAdvanced("protocol")} /></div><details className="technical-details"><summary>Wallet compatibility details</summary><p>{capabilityCopy?.identity ?? walletName}</p><p>{capabilityCopy?.summary ?? "Wallet compatibility evidence was not recorded for this connection."}</p><p>Advertised versions: {capabilityCopy?.versionsLabel ?? "Not recorded"}. v1: {capabilityCopy?.v1Label ?? "Unverified"}. Devnet: {capabilityCopy?.chainLabel ?? "Unverified"}.</p></details></details>
    <section className="dashboard-card owner-settings-danger"><div className="owner-settings-heading"><span className="owner-row-icon danger"><CircleAlert /></span><div><h2>Account actions</h2><p>Review these changes before continuing.</p></div></div><div className="owner-settings-row"><div><strong>Disconnect wallet</strong><p>Sign out of this workspace. Your spending permissions stay on-chain.</p></div><Button label="Disconnect" variant="destructive" icon={<LogOut size={18} />} className="owner-danger-action" onClick={() => setConfirmAction("disconnect")} /></div><div className="owner-settings-row"><div><strong>Revoke all spending permissions</strong><p>{activeMandateCount ? `${activeMandateCount} non-revoked permission${activeMandateCount === 1 ? "" : "s"}, including paused and expired. Requires wallet approval. Completed payments stay recorded.` : "No permissions need to be revoked."}</p></div><Button label="Revoke all" variant="destructive" icon={<ShieldCheck size={18} />} className="owner-danger-action" isDisabled={activeMandateCount === 0} onClick={() => setConfirmAction("revoke")} /></div>{dangerStatus && <p role="status">{dangerStatus}</p>}</section>
    <ConfirmDialog open={confirmAction === "revoke"} title="Revoke every non-revoked mandate?" description={`${activeMandateCount} mandate${activeMandateCount === 1 ? "" : "s"} that ${activeMandateCount === 1 ? "is" : "are"} not yet revoked — active, paused, or expired — will require a wallet-approved revoke transaction. Agents will not be able to request new payments until you create new mandates.`} confirmLabel="Revoke all mandates" onClose={() => setConfirmAction(null)} onConfirm={() => { setConfirmAction(null); onRevokeAll(); }} />
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
  const settlementOperationKey = useRef<string | null>(null);
  useSettlementFormStatus(wallet, setStatus, settlementOperationKey);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [registerMint, setRegisterMint] = useState("");
  const [assetActionMint, setAssetActionMint] = useState<string | null>(null);

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
      const configKey = `config:${wallet}:${latest.blockhash}`;
      settlementOperationKey.current = configKey;
      const result = await submitSignedTransaction(configKey, signed.serialize());
      setSignature(result.signature ?? "");
      setStatus("success");
      await onCreated();
    } catch (cause) {
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const isAuthority = config?.authority === wallet;

  async function submitAssetAction(preparedTx: PreparedTransaction, label: string) {
    if (!walletSigner) {
      setStatus("error");
      setError("The connected wallet does not expose transaction signing.");
      return;
    }
    setStatus("signing");
    setError("");
    try {
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await walletSigner(toWeb3Transaction(preparedTx, latest.blockhash));
      const configKey = `${label}:${wallet}:${latest.blockhash}`;
      settlementOperationKey.current = configKey;
      const result = await submitSignedTransaction(configKey, signed.serialize());
      setSignature(result.signature ?? "");
      setStatus("success");
      await onCreated();
    } catch (cause) {
      setStatus(isPendingSettlement(cause) ? "pending" : "error");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssetActionMint(null);
    }
  }

  async function registerAssetMint(mint: string, tokenProgram: TokenProgram) {
    setAssetActionMint(mint);
    await submitAssetAction(chainpayClient.buildRegisterAsset(mint, tokenProgram, wallet), `register-asset:${mint}`);
  }

  async function setAssetEnabled(mint: string, enabled: boolean) {
    setAssetActionMint(mint);
    await submitAssetAction(chainpayClient.buildSetAssetStatus(mint, wallet, enabled), `${enabled ? "enable" : "disable"}-asset:${mint}`);
  }

  return (
    <section className="protocol-layout">
      <div className="dashboard-card protocol-form-card">
        <div className="dashboard-card-heading">
          <div><span className="section-kicker">PROTOCOL CONFIG</span><h2>{config ? "Configuration is live" : "Initialize the protocol"}</h2></div>
          <span className={`state-pill ${config ? "ok" : ""}`}><i /> {config ? "On-chain" : "Not initialized"}</span>
        </div>
        <p className="builder-intro">Choose up to three mint addresses for the program config. Empty slots are stored as the zero address.</p>
        <div className="builder-grid protocol-slots">
          {slots.map((slot, index) => <TextInput className="field-wide" key={index} label={`Mint slot ${index + 1}`} description={index === 0 ? "recommended" : "optional"} value={slot} onChange={(value) => updateSlot(index, value)} placeholder={index === 0 ? DEVNET_USDC_MINT : "Optional mint address"} isReadOnly={Boolean(config)} />)}
        </div>
        {config ? <div className="protocol-authority"><span>Authority</span><strong className="mono">{shortAddress(config.authority)}</strong><small>{isAuthority ? "Connected wallet can register and enable assets." : "Read-only. Connect the authority wallet to register or enable assets."}</small></div> : <div className="builder-actions"><Button type="button" variant="primary" label={status === "building" ? "Checking setup…" : "Preview initializer"} isDisabled={status === "building" || status === "signing"} onClick={() => void buildPreview()} /><span className="builder-safety"><Shield /> Wallet approval required</span></div>}
        {error && <div className="builder-error"><b>Needs attention</b><span>{error}</span></div>}
      </div>

      <div className="dashboard-card protocol-review-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">SUPPORTED ASSETS</span><h2>{config ? `${assets.length} configured mint${assets.length === 1 ? "" : "s"}` : "Review transaction"}</h2></div>{config && <span className="network-chip"><i /> Devnet</span>}</div>
        {config ? <>
          <div className="asset-status-list">{assets.length ? assets.map((asset) => <div className="asset-status-row" key={asset.mint}><span className="asset-status-icon">{asset.enabled ? "✓" : "!"}</span><span><strong>{shortAddress(asset.mint)}</strong><small>{asset.tokenProgram ? (asset.tokenProgram === TOKEN_2022_PROGRAM_ID ? "Token-2022" : "Classic SPL Token") : "Not registered"}{asset.decimals === undefined ? "" : ` · ${asset.decimals} decimals`}</small></span><em className={asset.enabled ? "asset-enabled" : "asset-disabled"}>{asset.enabled ? "Enabled" : asset.registered ? "Disabled" : "Not registered"}</em>{isAuthority && <span className="asset-status-actions">{!asset.registered ? <Button type="button" variant="secondary" label={assetActionMint === asset.mint ? "Waiting…" : "Register"} isDisabled={status === "signing" || assetActionMint !== null} onClick={() => void registerAssetMint(asset.mint, asset.tokenProgram === TOKEN_2022_PROGRAM_ID ? "token-2022" : "spl-token")} /> : asset.enabled ? <Button type="button" variant="secondary" label={assetActionMint === asset.mint ? "Waiting…" : "Disable"} isDisabled={status === "signing" || assetActionMint !== null} onClick={() => void setAssetEnabled(asset.mint, false)} /> : <Button type="button" variant="primary" label={assetActionMint === asset.mint ? "Waiting…" : "Enable"} isDisabled={status === "signing" || assetActionMint !== null} onClick={() => void setAssetEnabled(asset.mint, true)} />}</span>}</div>) : <div className="review-empty"><div className="empty-icon">◌</div><p>Reading asset registry…</p></div>}</div>
          {isAuthority && <div className="protocol-register-row"><TextInput label="Register another mint" description="Authority-only" value={registerMint} onChange={setRegisterMint} placeholder="Mint address" /><Button type="button" variant="secondary" label={status === "signing" ? "Waiting…" : "Register mint"} isDisabled={!registerMint.trim() || status === "signing" || assetActionMint !== null} onClick={() => void registerAssetMint(registerMint.trim(), "spl-token")} /></div>}
        </> : prepared ? <><div className="review-list"><div><span>Protocol settings</span><strong className="mono">{shortAddress(deriveConfigAddress(PROGRAM_ID))}</strong></div><div><span>Setup actions</span><strong>{prepared.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="state-box"><p>This transaction will be submitted directly to Devnet after wallet approval. Success is reported only from finalized on-chain state.</p></div><Button type="button" variant="primary" className="full-button" label={status === "signing" ? "Waiting for wallet…" : "Approve setup"} isDisabled={status === "signing" || !walletSigner} onClick={() => void signAndInitialize()} />{signature && <div className="success-box"><span>✓</span><div><b>Protocol initialized</b><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a></div></div>}</> : <div className="review-empty"><div className="empty-icon">◌</div><p>Review the mint list before direct Devnet submission.</p></div>}
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

function MandateBuilder({ wallet, walletSigner, walletMessageSigner, stablecoinOptions, protocolConfig, onCreated, onOpenPayments, onOpenAgents }: { wallet: string; walletSigner?: (transaction: Transaction) => Promise<Transaction>; walletMessageSigner?: (message: Uint8Array) => Promise<Uint8Array>; stablecoinOptions: StablecoinOption[]; protocolConfig: ProtocolConfig | null; onCreated: (mandateAddress: string) => Promise<void>; onOpenPayments: () => void; onOpenAgents: () => void }) {
  const [step, setStep] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { stepHeading.current?.focus(); }, [step]);
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
  const settlementOperationKey = useRef<string | null>(null);
  useSettlementFormStatus(wallet, setStatus, settlementOperationKey);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [pdaCopied, setPdaCopied] = useState(false);
  const [accountSignature, setAccountSignature] = useState("");
  const [accountSetup, setAccountSetup] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [mintDecimals, setMintDecimals] = useState<number | null>(null);
  const [catalogProviders, setCatalogProviders] = useState<PayshCatalogProvider[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [catalogError, setCatalogError] = useState("");
  const [catalogSelection, setCatalogSelection] = useState("");
  const [catalogNote, setCatalogNote] = useState("");

  useEffect(() => {
    const draft = loadWalletDrafts(wallet).mandateBuilder;
    if (!draft) return;
    setForm(draft.form);
    setSigningMode(draft.signingMode);
    setMandateNonce(draft.mandateNonce);
    setStablecoin(draft.stablecoin);
    setCatalogSelection(draft.catalogSelection);
    setCatalogNote(draft.catalogNote);
    setSlotEdited(draft.slotEdited);
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    saveWalletDrafts(wallet, {
      mandateBuilder: {
        form,
        signingMode,
        mandateNonce,
        stablecoin,
        catalogSelection,
        catalogNote,
        slotEdited,
      },
    });
  }, [wallet, form, signingMode, mandateNonce, stablecoin, catalogSelection, catalogNote, slotEdited]);

  useEffect(() => {
    let active = true;
    setCatalogStatus("loading");
    void fetchPayshCatalog()
      .then((providers) => {
        if (!active) return;
        setCatalogProviders(providers.filter((provider) => (provider.endpoint_count ?? 0) > 0).slice(0, 200));
        setCatalogStatus("ready");
      })
      .catch((cause) => {
        if (!active) return;
        setCatalogStatus("error");
        setCatalogError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, []);

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
    void retryRead(() => chainpayClient.getCurrentSlot(), { cancelled: () => !active })
      .then((slot) => {
        if (active) setCurrentSlot(slot);
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

  function applyCatalogQuote() {
    const provider = catalogProviders.find((candidate) => candidate.fqn === catalogSelection);
    if (!provider) {
      setError("Pick a pay.sh catalog provider first.");
      return;
    }
    const quote = catalogQuoteForProvider(provider);
    updateField("maxPerPayment", quote.estimateAmount);
    setCatalogNote(`${quote.label} · USD catalog estimate only. Not a live 402 challenge and not a receipt.`);
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
      const preparation = await chainpayClient.prepareAssociatedTokenAccount({ owner: wallet, payer: wallet, mint });
      if (preparation.tokenProgram !== form.tokenProgram) {
        throw new Error("The registry token program does not match the selected token program.");
      }
      const tokenAccount = preparation.address;
      setForm((current) => ({ ...current, sourceTokenAccount: tokenAccount }));
      if (preparation.status === "ready") {
        setAccountSignature("");
        setAccountSetup("ready");
        return;
      }
      const balance = await chainpayClient.connection.getBalance(new PublicKey(wallet), "confirmed");
      if (balance === 0) {
        throw new Error("Add Devnet SOL to this wallet before preparing it for payments.");
      }
      if (!walletSigner) throw new Error("The connected wallet does not expose transaction signing.");
      if (!preparation.transaction) throw new Error("The SDK did not return an account-creation transaction.");
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(preparation.transaction, latest.blockhash);
      await simulateTokenAccountCreation(transaction);
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
      const perPayment = parseTokenAmount(form.maxPerPayment, mintDecimals);
      const totalLimit = parseTokenAmount(form.totalLimit, mintDecimals);
      if (perPayment <= 0n || totalLimit <= 0n) throw new Error("Enter spending limits greater than zero.");
      if (perPayment > totalLimit) throw new Error("The per-payment limit cannot exceed the total allowance.");
      if (![form.maxPaymentCount, form.cooldownSlots].every((value) => /^\d+$/.test(value))) throw new Error("Advanced limits must be whole numbers of zero or more.");
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
      setStep(2);
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
      const mandateKey = `mandate:${prepared.mandateAddress}:${latest.blockhash}`;
      settlementOperationKey.current = mandateKey;
      const result = await submitSignedTransaction(mandateKey, signed.serialize());
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

  return <section className="owner-permission-wizard">
    <ol className="owner-stepper" aria-label="Spending permission steps">{["Approval method", "Spending limits", "Review"].map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "done" : ""} aria-current={step === index ? "step" : undefined}><span>{index < step ? <Check size={16} /> : index + 1}</span>{label}</li>)}</ol>
    <div className="owner-wizard-grid"><div>
    {step < 2 && <section className="dashboard-card mandate-builder"><div className="owner-form-heading"><span className="owner-caption">Step {step + 1} of 3</span><h2 ref={stepHeading} tabIndex={-1}>{step === 0 ? "How should payments be approved?" : "Set your spending limits"}</h2><p>{step === 0 ? "Choose when you want your wallet to ask you." : "Your agent can only spend within these limits."}</p></div>
    {step === 0 ? <>        <div className="mandate-mode-selector">
          <RadioList label="Payment signing mode" value={signingMode} onChange={(value) => selectSigningMode(value as "human" | "delegated")}>
            <RadioListItem value="human" label="Approve each payment" description="Review and approve every payment in your wallet." />
            <RadioListItem value="delegated" label="Automatic payments" description="Approve the permission once. Payments use a secure signer within your limits. Requires signer setup and network-fee funding." />
          </RadioList>
        </div>
<div className="owner-form-actions"><Button label="Set spending limits" variant="primary" icon={<ArrowRight size={18} />} onClick={() => setStep(1)} /></div></> : <>        <div className="builder-grid simple-mandate-grid">

          <div className="field-wide"><Selector
            label="Stablecoin"
            value={stablecoin}
            onChange={updateStablecoin}
            options={stablecoinOptions.length ? stablecoinOptions.map((option) => ({ value: option.value, label: `${option.label} · ${option.detail}` })) : [{ value: "", label: "No enabled registry assets" }]}
          />
          </div><div className="owner-amount-fields field-wide"><SpendingAmountField label="Max per payment" value={form.maxPerPayment} onChange={(value) => updateField("maxPerPayment", value)} token={selectedStablecoin.label} mint={form.allowedMint} rangeMax={100} description="The most your agent can spend at once." />
          <SpendingAmountField label="Total spend limit" value={form.totalLimit} onChange={(value) => updateField("totalLimit", value)} token={selectedStablecoin.label} mint={form.allowedMint} rangeMax={1000} description="The total allowance across all payments." />
          </div><div className="field-wide"><Selector
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
              : "Approximate duration. The exact expiry is recorded on-chain."}
          />
</div><details className="technical-details field-wide" open={slotEstimateStatus === "unavailable"}><summary>Exact on-chain expiry</summary>          <TextInput
            className="field-wide"
            label="Exact expiry slot"
            value={form.expiresAtSlot}
            onChange={(value) => { setSlotEdited(true); updateField("expiresAtSlot", value); }}
            placeholder={currentSlot ? (currentSlot + 1n).toString() : "Current slot unavailable"}
            description={slotEstimate
              ? `Estimated from recent network activity. Current slot ${currentSlot?.toString() ?? "unavailable"}.`
              : "Enter the exact expiry slot. Estimates are unavailable until a performance sample can be read."}
          /></details>
        </div>
        <details className="technical-details mandate-advanced-limits">
          <summary>Advanced limits</summary>
          <div className="builder-grid simple-mandate-grid">
            <TextInput label="Maximum payment count" value={form.maxPaymentCount} onChange={(value) => updateField("maxPaymentCount", value)} description="0 means no payment-count limit." />
            <TextInput label="Cooldown slots" value={form.cooldownSlots} onChange={(value) => updateField("cooldownSlots", value)} description="Minimum slots between payments. 0 means no cooldown." />
          </div>
        </details>
<details className="technical-details owner-catalog"><summary>Estimate a limit from pay.sh</summary>        <div className="catalog-prefill-card">
          <img className="owner-service-logo" src={payshLogo} alt="pay.sh" />
          <p>Use a catalog estimate to help set a limit. The actual price is reviewed with each payment.</p>
          {catalogStatus === "loading" && <Skeleton className="catalog-prefill-skeleton" />}
          {catalogStatus === "error" && <p className="builder-error"><b>Catalog unavailable</b><span>{catalogError}</span></p>}
          {catalogStatus === "ready" && catalogProviders.length > 0 && (
            <div className="catalog-prefill-row">
              <Selector
                className="field-wide"
                label="pay.sh provider"
                value={catalogSelection}
                onChange={setCatalogSelection}
                options={catalogProviders.map((provider) => ({
                  value: provider.fqn,
                  label: provider.title,
                  description: provider.max_price_usd > 0
                    ? `Up to $${provider.max_price_usd} catalog estimate`
                    : provider.has_free_tier
                      ? "Free tier listed"
                      : "See catalog",
                }))}
                description="Catalog prices are estimates, not approved payment amounts."
              />
              <Button type="button" variant="secondary" label="Use catalog estimate" isDisabled={!catalogSelection} onClick={applyCatalogQuote} />
            </div>
          )}
          {catalogNote && <p className="catalog-prefill-note">{catalogNote}</p>}
        </div>
</details>        {signingMode === "delegated" && <div className="account-setup-row"><div><span>Secure automatic-payment wallet</span><small>{managedSignerStatus === "ready" ? "Created by ChainPay" : managedSignerStatus === "provisioning" ? "Waiting for wallet authorization" : "Needs setup"}</small></div><Button type="button" variant="secondary" className="inline-action" label={managedSignerStatus === "provisioning" ? "Setting up…" : managedSignerStatus === "ready" ? "Ready" : "Set up securely"} isDisabled={managedSignerStatus === "provisioning" || managedSignerStatus === "ready"} onClick={() => void setupManagedSigner()} /></div>}
        {signingMode === "delegated" && managedSigner && <div className="success-box"><span>✓</span><div><b>Automatic-payment wallet ready</b><Button type="button" variant="ghost" className="copy-id" label={`Send Devnet SOL for transaction fees to ${shortAddress(managedSigner.public_key)} ⧉`} isDisabled={false} onClick={() => void copyValue(managedSigner.public_key)} /></div></div>}
        <details className="account-identity-card technical-details"><summary>Account details</summary><div><span>Connected owner wallet</span><strong>{wallet}</strong></div><div><span>{selectedStablecoin.label} source token account</span><strong>{form.sourceTokenAccount || "Select an enabled mint"}</strong></div>{signingMode === "delegated" && <div><span>Automatic-payment wallet</span><strong>{managedSigner?.public_key ?? "Not created yet"}</strong></div>}<small>Your {selectedStablecoin.label} stays in your token account. The automatic-payment wallet holds only Devnet SOL for fees and can spend tokens only through this mandate.</small></details>
        {accountSetup !== "ready" && <div className="account-setup-row"><div><span>Token account setup</span><small>{accountSetup === "working" ? "Checking token account" : "Needs setup"}</small></div><Button type="button" variant="secondary" className="inline-action" label={accountSetup === "working" ? "Checking…" : "Prepare token account"} isDisabled={accountSetup === "working"} onClick={() => void setupWalletTokenAccount()} /><p className="owner-caption">Creating an account requires a separate wallet approval and SOL network fees.</p></div>}
        {accountSignature && <div className="success-box"><span>✓</span><div><b>{accountSignature ? "Source token account prepared" : "Source token account ready"}</b><a href={accountSignature ? `https://explorer.solana.com/tx/${accountSignature}?cluster=devnet` : `https://explorer.solana.com/address/${form.sourceTokenAccount}?cluster=devnet`} target="_blank" rel="noreferrer">{accountSignature ? "View account transaction" : "View token account"} <Arrow /></a></div></div>}
<div className="owner-form-actions"><Button label="Back" variant="secondary" isDisabled={status === "building" || managedSignerStatus === "provisioning" || accountSetup === "working"} onClick={() => setStep(0)} /><Button label={status === "building" ? "Reviewing…" : "Review permission"} variant="primary" isDisabled={status === "building" || status === "pending" || (signingMode === "delegated" && managedSignerStatus !== "ready")} onClick={() => void buildPreview()} /></div></>}
    </section>}
    {step === 2 && <><Button label="Edit spending limits" variant="ghost" isDisabled={status === "signing" || status === "pending" || status === "success"} onClick={() => { setPrepared(null); setStep(1); }} />      <div className="dashboard-card review-card mandate-review-card">
        <div className="dashboard-card-heading"><div><span className="section-kicker">REVIEW</span><h2>{prepared ? "Ready for approval" : "Your permission"}</h2></div><span className={`state-pill ${prepared ? "ok" : ""}`}><i /> {prepared ? "Ready to approve" : "Waiting"}</span></div>
        {prepared ? <>
          <p className="owner-muted">Approving in your wallet creates this spending permission.</p>
          <div className="mandate-summary"><div><span>Payment approval</span><strong>{signingMode === "human" ? "Human signing · confirm each payment" : "Delegated signing · automatic within limits"}</strong></div><div><span>Connected wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div><div><span>Payment signer</span><strong className="mono">{shortAddress(form.approvedAgent)}</strong></div><div><span>Stablecoin</span><strong>{selectedStablecoin.label} <small>{selectedStablecoin.detail}</small></strong></div><div><span>Recipient</span><strong>Chosen per payment</strong></div><div><span>Max per payment</span><strong className="mono">{mintDecimals === null ? form.maxPerPayment : reviewExactAmount(form.maxPerPayment, mintDecimals)}</strong></div><div><span>Total spend limit</span><strong className="mono">{mintDecimals === null ? form.totalLimit : reviewExactAmount(form.totalLimit, mintDecimals)}</strong></div><div><span>Expires</span><strong className="mono">{slotEstimate ? `${mandateExpiryLabel(BigInt(form.expiresAtSlot), currentSlot, slotEstimate)}` : `Slot ${form.expiresAtSlot}`}</strong></div><div><span>Payment count / cooldown</span><strong className="mono">{form.maxPaymentCount === "0" ? "No count limit" : form.maxPaymentCount} · {form.cooldownSlots === "0" ? "No cooldown" : `${form.cooldownSlots} slots`}</strong></div></div>
          <details className="technical-details"><summary>Transaction details</summary><div className="review-list"><div><span>Mandate address</span><strong className="mono">{shortAddress(prepared.mandateAddress)}</strong></div><div><span>Policy actions</span><strong>{prepared.transaction.instructions.map((instruction) => instruction.name).join(" + ")}</strong></div><div><span>Wallet</span><strong className="mono">{shortAddress(wallet)}</strong></div></div><div className="state-box"><p>After wallet approval, Axum submits this transaction directly and verifies finalized chain state.</p></div></details>
          <Button type="button" variant="primary" label={status === "signing" ? "Waiting for wallet…" : status === "success" ? "Mandate created" : "Approve spending permission"} isDisabled={status === "signing" || status === "pending" || status === "success"} onClick={() => void signAndCreate()} />
          {signature && <div className="mandate-created-callout"><div className="mandate-created-heading"><span>✓</span><div><b>Permission created on Devnet</b><small>{signingMode === "human" ? "Your policy is ready for a wallet-approved payment." : "Your policy is ready for autonomous agent payments inside its limits."}</small></div></div><div className="mandate-pda-row"><div><span>Permission address</span><strong>{prepared.mandateAddress}</strong></div><Button type="button" variant="secondary" label={pdaCopied ? "Copied" : "Copy address"} isDisabled={false} onClick={copyMandatePda} /></div><div className="mandate-created-actions"><a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction <Arrow /></a>{signingMode === "human" ? <Button type="button" variant="primary" label="Pay with this mandate" isDisabled={false} onClick={onOpenPayments} /> : <Button type="button" variant="primary" label="Connect an agent" isDisabled={false} onClick={onOpenAgents} />}</div></div>}
        </> : <div className="review-empty"><div className="empty-icon">◇</div><p>Review the mandate before signing.</p></div>}
      </div></>}
    {error && <div className="builder-error" role="alert"><b>Needs attention</b><span>{error}</span></div>}
    </div><aside className="owner-wizard-aside"><ShieldCheck size={32} /><h2>A permission,<br />on your terms.</h2><p>Your funds stay in your wallet. You choose the limits and can revoke the permission at any time.</p><ul><li>A receipt for every payment</li><li>Spending limited by your rules</li><li>Revoke access when you need to</li></ul></aside></div>
  </section>;
}



export default function DashboardRoute(props: DashboardProps) {
  return <Dashboard {...props} />;
}
