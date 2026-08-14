export type Address = string;

export type TokenProgram = "spl-token" | "token-2022";

export type AccountMeta = {
  address: Address;
  isSigner: boolean;
  isWritable: boolean;
};

export type ChainPayInstruction = {
  name: string;
  programId: Address;
  keys: AccountMeta[];
  data: Uint8Array;
};

export type PreparedTransaction = {
  instructions: ChainPayInstruction[];
  requiredSigners: Address[];
  feePayer?: Address;
};

export type SimulationResult = {
  ok: boolean;
  logs: string[];
  unitsConsumed?: bigint;
  error?: string;
};

export type PaymentSubmission = {
  signature: string;
  slot?: bigint;
  status?: "submitted" | "confirmed";
};

export type PaymentSubmissionAdapter = {
  simulate(prepared: PreparedTransaction): Promise<SimulationResult>;
  submit(prepared: PreparedTransaction): Promise<PaymentSubmission>;
  confirm?(signature: string): Promise<{ slot?: bigint }>;
};

export type MandateStatus = "active" | "paused" | "revoked" | "expired";

export type PaymentStatus =
  | "prepared"
  | "submitted"
  | "confirmed"
  | "failed";

export type Mandate = {
  address: Address;
  owner: Address;
  approvedAgent: Address;
  sourceTokenAccount: Address;
  allowedMint: Address;
  /** Populated only when decoding a legacy fixed-recipient mandate. */
  legacyAllowedRecipient?: Address;
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
};

export type SupportedAsset = {
  address: Address;
  authority: Address;
  mint: Address;
  tokenProgram: Address;
  enabled: boolean;
  bump: number;
};

export type PaymentRequestPayload = {
  version: 1;
  cluster: "devnet" | "mainnet-beta";
  merchant: Address;
  invoice: string;
  mint: Address;
  tokenProgram: TokenProgram;
  recipient: Address;
  amount: string;
  decimals: number;
  nonce: string;
  expiresAtSlot?: string;
  resource?: string;
};

export type SignedPaymentRequest = {
  payload: PaymentRequestPayload;
  signature: string;
};

export type PaymentRequestVerification = {
  valid: boolean;
  payload: PaymentRequestPayload;
  invoiceHash: Uint8Array;
  reason?: string;
};

export type PaymentRequest = {
  mandate: Address;
  invoiceHash: Uint8Array;
  paymentId: Uint8Array;
  signatureReference: Uint8Array;
  mint: Address;
  recipient: Address;
  amount: bigint;
  tokenProgram?: TokenProgram;
  /** Extra accounts required by a Token-2022 extension such as transfer-hook. */
  remainingAccounts?: AccountMeta[];
};

export type PaymentReceipt = {
  address: Address;
  mandate: Address;
  invoiceHash: Uint8Array;
  paymentId: Uint8Array;
  mint: Address;
  recipient: Address;
  sourceTokenAccount: Address;
  recipientTokenAccount: Address;
  amount: bigint;
  agent: Address;
  executedAtSlot: bigint;
  signatureReference: Uint8Array;
  status: PaymentStatus;
  onChainStatus: number;
  bump: number;
  transactionSignature?: string;
};

export type PolicyCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export type PaymentPreflight = {
  valid: boolean;
  currentSlot: bigint;
  checks: PolicyCheck[];
};

export type PreparedPayment = {
  request: PaymentRequest;
  mandate: Mandate;
  receiptAddress: Address;
  instruction: ChainPayInstruction;
  transaction: PreparedTransaction;
  preflight: PaymentPreflight;
};

export type PaymentExecutionResult = {
  status: "submitted" | "confirmed" | "failed";
  receiptAddress: Address;
  signature?: string;
  slot?: bigint;
  simulation: SimulationResult;
  error?: string;
};

export type PreparedMandate = {
  mandateAddress: Address;
  configAddress: Address;
  transaction: PreparedTransaction;
};

export type ChainPayClientOptions = {
  rpcUrl?: string;
  programId?: Address;
  commitment?: "processed" | "confirmed" | "finalized";
};
