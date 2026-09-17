import type { AgentAttachment, AgentHistoryItem, AgentInboxItem } from "../owner/runtime";

export type MandateBuilderDraft = {
  form: {
    approvedAgent: string;
    sourceTokenAccount: string;
    allowedMint: string;
    maxPerPayment: string;
    totalLimit: string;
    expiresInDays: string;
    expiresAtSlot: string;
    maxPaymentCount: string;
    cooldownSlots: string;
    tokenProgram: "spl-token" | "token-2022";
  };
  signingMode: "human" | "delegated";
  mandateNonce: string;
  stablecoin: string;
  catalogSelection: string;
  catalogNote: string;
  slotEdited: boolean;
};

export type PaymentDraft = {
  invoice: string;
  amount: string;
  recipient: string;
};

export type BatchCsvPayment = {
  row: number;
  mandateAddress: string;
  invoice: string;
  amount: string;
  recipient: string;
  requiredToken?: string;
  receiptAddress?: string;
  tokenProgram?: "spl-token" | "token-2022";
};

export type BatchDraft = {
  items: BatchCsvPayment[];
  csvFileName?: string;
};

export type AssistantDraft = {
  prompt: string;
  reply: string;
  history: AgentHistoryItem[];
  attachments: AgentAttachment[];
};

export type WalletDrafts = {
  mandateBuilder?: MandateBuilderDraft;
  payment?: PaymentDraft;
  batch?: BatchDraft;
  assistant?: AssistantDraft;
};

const draftsByWallet = new Map<string, WalletDrafts>();

export function loadWalletDrafts(wallet: string): WalletDrafts {
  if (!wallet) return {};
  return { ...(draftsByWallet.get(wallet) ?? {}) };
}

export function saveWalletDrafts(wallet: string, patch: Partial<WalletDrafts>): void {
  if (!wallet) return;
  const current = draftsByWallet.get(wallet) ?? {};
  draftsByWallet.set(wallet, { ...current, ...patch });
}

export function clearWalletDrafts(wallet: string): void {
  if (!wallet) return;
  draftsByWallet.delete(wallet);
}

/** Test-only reset */
export function resetDraftStoreForTests(): void {
  draftsByWallet.clear();
}
