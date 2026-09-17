import { createContext, useContext, type ReactNode } from "react";
import type { Transaction } from "@solana/web3.js";
import type { WalletPickerOption } from "../ui/WalletPickerDialog";
import type { WalletCapabilityReport } from "./capabilities";

type MandateStatus = "active" | "paused" | "revoked" | "expired";
type TokenProgram = "spl-token" | "token-2022";

export type WalletMandate = {
  address: string;
  owner: string;
  approvedAgent: string;
  sourceTokenAccount: string;
  allowedMint: string;
  legacyAllowedRecipient?: string;
  maxPerPayment: bigint;
  totalLimit: bigint;
  amountSpent: bigint;
  paymentCount: bigint;
  expiresAtSlot: bigint;
  maxPaymentCount: bigint;
  cooldownSlots: bigint;
  lastPaymentSlot: bigint;
  paused: boolean;
  revoked: boolean;
  status: MandateStatus;
  tokenProgram?: TokenProgram;
  mandateNonce?: string;
  createdAt?: number;
  createdAtSlot?: bigint;
};

export type WalletAsset = {
  address: string;
  authority: string;
  mint: string;
  tokenProgram: string;
  enabled: boolean;
  bump: number;
};

type ProtocolConfig = {
  address?: string;
  authority: string;
  supportedMints: string[];
  bump: number;
};

type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpToolResponse = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };

export type WalletContextValue = {
  wallet: string;
  walletName: string;
  walletCapabilities: WalletCapabilityReport | null;
  connecting: boolean;
  switchingWalletAccount: boolean;
  walletPickerOpen: boolean;
  walletOptions: WalletPickerOption[];
  walletConnectionError: string;
  mandateAddress: string;
  mandate: WalletMandate | null;
  mandates: WalletMandate[];
  protocolConfig: ProtocolConfig | null;
  registeredAssets: WalletAsset[];
  mcpTools: McpTool[];
  mcpResult: McpToolResponse | null;
  integrationStatus: "idle" | "loading" | "ready" | "error";
  integrationError: string;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  requestWalletConnection: () => void;
  refreshWalletOptions: () => void;
  connectWallet: (optionId: string) => Promise<void>;
  setWalletPickerOpen: (open: boolean) => void;
  changeConnectedAccount: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  changeWallet: () => Promise<void>;
  refreshMandate: (preferredMandateAddress?: string) => Promise<void>;
  selectMandate: (mandate: WalletMandate) => void;
  callMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
};

const disconnected: WalletContextValue = {
  wallet: "",
  walletName: "",
  walletCapabilities: null,
  connecting: false,
  switchingWalletAccount: false,
  walletPickerOpen: false,
  walletOptions: [],
  walletConnectionError: "",
  mandateAddress: "",
  mandate: null,
  mandates: [],
  protocolConfig: null,
  registeredAssets: [],
  mcpTools: [],
  mcpResult: null,
  integrationStatus: "idle",
  integrationError: "",
  requestWalletConnection: () => {},
  refreshWalletOptions: () => {},
  connectWallet: async () => {},
  setWalletPickerOpen: () => {},
  changeConnectedAccount: async () => {},
  disconnectWallet: async () => {},
  changeWallet: async () => {},
  refreshMandate: async () => {},
  selectMandate: () => {},
  callMcp: async () => ({ content: [] }),
};

const WalletContext = createContext<WalletContextValue>(disconnected);

export function WalletContextProvider({
  value,
  children,
}: {
  value: WalletContextValue;
  children: ReactNode;
}) {
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  return useContext(WalletContext);
}
