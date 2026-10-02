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

export type PaymentSubmission = {
  signature: string;
  slot?: bigint;
  status?: "submitted" | "confirmed";
};

export type PaymentSubmissionAdapter = {
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
  /** Present for nonce-scoped mandates; absent for legacy accounts. */
  mandateNonce?: Address;
  /** Unix timestamp from the oldest confirmed transaction for this PDA. */
  createdAt?: number;
  /** Slot from the oldest confirmed transaction for this PDA. */
  createdAtSlot?: bigint;
};

export type SupportedAsset = {
  address: Address;
  authority: Address;
  mint: Address;
  tokenProgram: Address;
  enabled: boolean;
  bump: number;
};

export type AssociatedTokenAccountPreparation = {
  asset: SupportedAsset;
  address: Address;
  owner: Address;
  mint: Address;
  tokenProgram: TokenProgram;
  status: "ready" | "missing";
  /** Present only when the canonical account is missing. The SDK never submits it. */
  transaction?: PreparedTransaction;
};

export type TokenCapabilityProfile = {
  mint: Address;
  tokenProgram: TokenProgram;
  compatible: boolean;
  mintExtensions: string[];
  sourceAccountExtensions: string[];
  recipientAccountExtensions: string[];
  blockers: string[];
  warnings: string[];
  transferFee?: {
    basisPoints: number;
    maximumFee: bigint;
  };
  transferHookProgram?: Address;
};

/** One line of what was bought. Amounts are base units of the request mint. */
export type PaymentRequestLineItem = {
  label: string;
  /** Unsigned integer string in base units of the request mint. */
  amount?: string;
  /** Unsigned decimal string, for example "1" or "2.5". */
  quantity?: string;
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
  /**
   * Seller's plain description of what is being bought. Signed with the rest
   * of the payload, so it is part of the invoice hash when present.
   */
  description?: string;
  lineItems?: PaymentRequestLineItem[];
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
};

/**
 * Mandate policy values the program copied into a v2 receipt at payment time.
 * Every value is the mandate's state immediately after this payment.
 */
export type ReceiptPolicyLimits = {
  maxPerPayment: bigint;
  totalLimit: bigint;
  amountSpentAfter: bigint;
  paymentCountAfter: bigint;
  /** 0 means no payment-count cap. */
  maxPaymentCount: bigint;
  expiresAtSlot: bigint;
  cooldownSlots: bigint;
};

export type ReceiptPolicySnapshot = ReceiptPolicyLimits & {
  /** Layout version byte from the receipt. 1 is the first snapshot layout. */
  version: number;
};

/**
 * Where the limits shown beside a receipt came from.
 * - on-chain: written by the program into the receipt account itself.
 * - relay-observed: read from the mandate by the ChainPay relay after the
 *   payment finalized. Not stored on Solana, and later payments in the same
 *   observation window may already be counted.
 * - not-recorded: neither exists for this receipt.
 */
export type ReceiptPolicySource = "on-chain" | "relay-observed" | "not-recorded";

export type ReceiptPolicy =
  | { source: "on-chain"; limits: ReceiptPolicyLimits }
  | {
      source: "relay-observed";
      limits: ReceiptPolicyLimits;
      observedAtSlot: bigint;
      /**
       * The mandate had paid again after this receipt when the relay read it,
       * so `amountSpentAfter` and `paymentCountAfter` include later payments.
       */
      includesLaterPayments: boolean;
    }
  | { source: "not-recorded" };

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
  /** Replay lock from settle. Not seller delivery and not the transaction signature. */
  signatureReference: Uint8Array;
  status: PaymentStatus;
  onChainStatus: number;
  bump: number;
  transactionSignature?: string;
  /**
   * Policy snapshot from a v2 (371-byte) receipt. Null for an original
   * 282-byte receipt or when the program wrote no snapshot.
   */
  policySnapshot: ReceiptPolicySnapshot | null;
};

export type PolicyCheck = {
  name: string;
  ok: boolean;
  message: string;
};

/** Verified source token account fields supplied by preparePayment. */
export type PaymentPreflightContext = {
  sourceBalance: bigint;
  sourceOwner: Address;
  delegate: Address | null;
  delegatedAmount: bigint;
};

export type PaymentPreflight = {
  valid: boolean;
  currentSlot: bigint;
  checks: PolicyCheck[];
};

export type BatchPreflightEntry = {
  request: PaymentRequest;
  mandate: Mandate;
  agent?: Address;
  receiptAlreadyExists?: boolean;
  sourceContext?: PaymentPreflightContext;
};

export type PaymentBatchPreflight = {
  valid: boolean;
  currentSlot: bigint;
  entries: Array<{
    request: PaymentRequest;
    mandate: Address;
    preflight: PaymentPreflight;
  }>;
  batchChecks: PolicyCheck[];
};

export type PreparedPayment = {
  request: PaymentRequest;
  mandate: Mandate;
  receiptAddress: Address;
  instruction: ChainPayInstruction;
  transaction: PreparedTransaction;
  preflight: PaymentPreflight;
  capabilityProfile?: TokenCapabilityProfile;
};

export type PaymentExecutionResult = {
  status: "submitted" | "confirmed" | "failed";
  receiptAddress: Address;
  signature?: string;
  slot?: bigint;
  error?: string;
  /** Set when the receipt already existed: nothing new was paid. */
  code?: "DuplicateInvoice";
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
