import type { CardDeclineReason, CardMerchantView, CardReservationLifecycle, StatementState } from "./evidence.js";
import { isCheckoutCapability } from "./hash.js";
import { parseCents } from "./math.js";

/*
 * Typed client for the Axum card routes (contracts.md §3.4). Axum derives the
 * actor from the bearer credential (owner session or MCP connection); this
 * client never sends an owner wallet of its own. Amounts are cent strings.
 * Internal routes (checkout redeem, reconcile cron) are deliberately absent.
 */

export type CardsApiErrorBody = {
  code: string;
  message: string;
  operationId?: string;
  retryable: boolean;
  evidenceState?: string;
  /** Fresh card view on a partial failure (e.g. `mirror_failed`): the state the issuer and chain actually reached. */
  card?: CardView;
};

export class CardsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly evidenceState?: string;
  /** Fresh card view Axum attached to a partial failure, when it sent one. */
  readonly card?: CardView;

  constructor(status: number, body: Partial<CardsApiErrorBody>) {
    super(body.message || `Card API request failed (${status})`);
    this.name = "CardsApiError";
    this.status = status;
    this.code = body.code || "card_api_error";
    this.retryable = body.retryable === true;
    this.operationId = body.operationId;
    this.evidenceState = body.evidenceState;
    this.card = body.card;
  }
}

export type CardAccountsView = { binding: string; policy: string; period: string; commitment: string; escrow: string };

export type PreparedCard = {
  cardId: string;
  accounts: CardAccountsView;
  /** Unsigned base64 transactions for the owner wallet. */
  initTx: string;
  delegateTx: string;
  escrowTopUpTx: string;
  authorizer: string;
  teeValidator: string;
  prefundLamports: string;
};

export type IssuerFreezeState = "pending_issuer_confirmation" | "confirmed" | "failed";

/**
 * Axum's own attestation of the TEE it authorizes against: a fresh quote bound to
 * Axum's challenge, verified under Intel's DCAP chain with an accepted TCB status
 * (`verified`), plus the pinned measurement allowlist.
 */
export type CardAttestationView = {
  mode: "report" | "enforce" | string;
  hardware: "verified" | "failed" | "unchecked" | string;
  measurements: "match" | "mismatch" | "pending" | string;
  checkedAt?: string | null;
  label: string;
};

/**
 * Axum's persisted card activation (audit R2). Order: mirror limits at the issuer
 * (card paused) → checkpoint on PER → base-layer commitment read back → issuer open.
 * `active` only when all of it holds for `policyVersion`.
 */
export type CardActivationState = "mirroring" | "mirror_failed" | "pending_commitment" | "issuer_pending" | "held" | "active" | "superseded";

export type CardActivationView = {
  state: CardActivationState | string;
  policyVersion: number;
  steps?: {
    mirror?: string;
    rules?: "pending" | "retired" | "retire_pending" | string;
    checkpoint?: string | { seq?: string; state?: string };
    commitment?: "pending" | "confirmed" | string;
    issuer?: string;
  };
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  /** e.g. `new_activation_disabled`, `issuer_not_open`, `frozen_on_per`, `policy_version_changed`. */
  detail?: string;
};

/**
 * Public commitment. `state: "confirmed"` only when a base-layer readback matched the
 * checkpoint ChainPay scheduled (seq, policy version and period). A checkpoint PER
 * accepted is `checkpoint: "scheduled"` and still `state: "pending"`.
 */
export type CardCommitmentView = {
  seq: string;
  root?: string;
  slot?: string;
  state?: "confirmed" | "pending" | "mismatch" | "unverified" | string;
  checkpoint?: "pending" | "scheduled" | "failed" | "stalled" | "mismatch" | "confirmed" | string;
  policyVersion?: number;
  periodIndex?: number;
  expectedSeq?: string;
  source?: "base_readback" | "recorded";
};

/** No policy values: the owner reads those from the TEE with their own token. */
export type CardView = {
  cardId: string;
  label: string;
  lastFour: string;
  issuerState: string;
  mirror: { state: string; acknowledgedAt?: string; policyVersionMirrored?: number; allMerchantsMirrored?: boolean; rulesRetirePending?: boolean };
  freeze: { onChain: boolean; issuer: IssuerFreezeState };
  accounts?: CardAccountsView;
  commitment?: CardCommitmentView;
  activation?: CardActivationView;
  /**
   * Axum recovery states: `recovery_frozen` → `restore_prepared` (co-signed restore handed out)
   * → `reconciled_pending_owner_confirm` (issuer events replayed) → `restored`.
   */
  recovery?: { state: string; [key: string]: unknown };
  attestation?: CardAttestationView;
  billing?: { label: string; lastStatementSeq?: number | null; carriedCreditCents: string };
  simulatedCredit?: true;
};

/** Sandbox shop registry served by Axum (`GET /v1/cards/merchants`): the source of truth for allowlist hashes. */
export type CardMerchantListing = { merchantRef: string; displayName: string; merchantIdHash: string; mcc: number };

export type CardActivityKind =
  | "authorization"
  | "capture"
  | "reversal"
  | "refund"
  | "dispute"
  | "exception"
  | "freeze"
  | "unfreeze"
  | "policy_change"
  | "repayment";

export type CardActivityRow = {
  rowId: string;
  cardId: string;
  at: string;
  kind: CardActivityKind;
  lifecycle?: CardReservationLifecycle | "late_capture" | "refunded" | "forced_capture";
  amountCents?: string;
  /** Approved hold for capture rows, when it differs from amountCents (partial charges). */
  reservedCents?: string;
  /** opaque event id hash (hex) the owner passes to resolve_exception. */
  eventIdHash?: string;
  merchant?: CardMerchantView;
  intentId?: string;
  agent?: string;
  declineReason?: CardDeclineReason;
  exception?: "forced_capture" | "over_capture" | "unpaired_capture" | string;
  needsReview?: boolean;
};

export type Page<T> = { rows: T[]; nextCursor?: string | null };

/** Amounts are signed cent strings: credits (refunds, correction credits) are negative, and so are their fees. */
export type StatementLine = {
  lineId?: string;
  kind: "purchase" | "refund" | "adjustment_debit" | "adjustment_credit";
  amountCents: string;
  feeCents: string;
  /** Posting time (Axum). */
  postedAt?: string;
  /** Older fixtures used `at`. */
  at?: string;
  merchant?: { displayName: string; mcc?: string };
  exception?: string;
  needsReview?: boolean;
};

/** Where and how much to repay (only while the statement is payable). */
export type StatementPayWith = {
  method: "chainpay_execute_payment";
  cluster: "devnet";
  mint: string;
  recipientTokenAccount: string | null;
  invoiceHash: string;
  amountCents: string;
  note?: string;
};

export type StatementView = {
  statementId: string;
  cardId: string;
  statementSeq?: number;
  periodIndex: number;
  closeKind?: "period_end" | "interim";
  state: StatementState;
  /** `overdue` while a closed statement is past due (display only), else `state`. */
  displayState?: StatementState;
  overdue?: boolean;
  closedAt?: string;
  dueAt?: string;
  purchasesCents?: string;
  refundsCents?: string;
  totalCents: string;
  feeCents: string;
  carriedCreditCents?: string;
  /** max(0, total − carried credit): the exact amount a repayment must carry. */
  amountDueCents?: string;
  creditForwardCents?: string;
  digest?: string;
  lines: StatementLine[];
  repayment?: { receiptPda?: string; mandatePda?: string; verifiedAt?: string; mismatch?: string[] };
  partner?: { confirmedAt?: string; ref?: string };
  payWith?: StatementPayWith;
  /** Opt-in MagicBlock Private Payments repayment (contracts §7.3). The payer is never verified. */
  payPrivately?: { method: "magicblock_private_payments"; prepare: string; cluster: "devnet"; verification: "settlement_to_partner_only"; payerVerified: false };
  privateRepayment?: { attempts?: { attemptId?: string; state?: string }[] } | null;
  history?: { state: string; at: string }[];
  /** Always true: the credit facility is a labelled simulation. */
  simulatedCredit: true;
};

/** The running (not yet closed) statement: never a due amount. */
export type OpenStatementView = {
  lineCount: number;
  purchasesCents: string;
  refundsCents: string;
  feeCents: string;
  runningTotalCents: string;
  carriedCreditCents: string;
  lines: StatementLine[];
};

export type StatementList = { statements: StatementView[]; open?: OpenStatementView | null };

/** `POST /v1/cards/{cardId}/recovery/restore`: a review first, then the authorizer-co-signed transaction. */
export type PreparedRestore =
  | { state: "review_required"; reconReport: unknown; reconReportDigest: string }
  | { state: "ready_to_sign"; reconReportDigest: string; restoreTx: string; coSignedBy: string; restoreArgs: Record<string, unknown> };

export type CheckoutCapabilityResponse = {
  capability: string;
  expiresAt: string;
  merchant: { displayName: string };
  amountCents: string;
  currency: "USD";
  intentId: string;
  status: "ready";
};

export type FreezeResult = {
  freezeOperationId: string;
  onChain: "submitted";
  issuer: "pending_issuer_confirmation";
};

export type RequestCardCheckoutInput = {
  cardId: string;
  merchantRef: string;
  amountCents: string;
  currency: "USD";
  description?: string;
  clientOperationId: string;
};

export type CardsApiOptions = {
  baseUrl: string;
  /** Owner session token or MCP connection token. Never logged, never echoed. */
  authToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const CARD_ID = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

export function assertCardId(cardId: unknown): string {
  if (typeof cardId !== "string" || !CARD_ID.test(cardId)) throw new Error("cardId must be 64 lowercase hex characters");
  return cardId;
}

export function assertClientOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) throw new Error("clientOperationId must be 8-128 letters, digits or _.:-");
  return value;
}

/** Validate an Axum checkout response before anything downstream sees it. */
export function parseCheckoutCapabilityResponse(body: unknown): CheckoutCapabilityResponse {
  const value = body as Partial<CheckoutCapabilityResponse> | null;
  if (!value || typeof value !== "object") throw new Error("Checkout response is not an object");
  if (!isCheckoutCapability(value.capability)) throw new Error("Checkout capability has an unexpected format");
  if (value.status !== "ready") throw new Error("Checkout capability is not ready");
  if (value.currency !== "USD") throw new Error("Checkout currency must be USD");
  parseCents(value.amountCents, "amountCents");
  if (typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))) throw new Error("Checkout expiry is missing");
  if (typeof value.intentId !== "string" || !value.intentId) throw new Error("Checkout intent id is missing");
  if (!value.merchant || typeof value.merchant.displayName !== "string") throw new Error("Checkout merchant is missing");
  return {
    capability: value.capability,
    expiresAt: value.expiresAt,
    merchant: { displayName: value.merchant.displayName },
    amountCents: value.amountCents!,
    currency: "USD",
    intentId: value.intentId,
    status: "ready",
  };
}

/** Validate Axum's merchant registry before any hash reaches a policy the owner signs. */
export function parseMerchantListings(value: unknown): CardMerchantListing[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error("Card merchant list is missing");
  return value.map((entry) => {
    const item = entry as Partial<CardMerchantListing> | null;
    if (!item || typeof item.merchantRef !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(item.merchantRef)) throw new Error("Card merchant has an unexpected reference");
    if (typeof item.displayName !== "string" || !item.displayName.trim() || item.displayName.length > 80) throw new Error("Card merchant has no name");
    if (typeof item.merchantIdHash !== "string" || !/^[0-9a-f]{64}$/.test(item.merchantIdHash)) throw new Error("Card merchant hash must be 32 bytes of hex");
    if (typeof item.mcc !== "number" || !Number.isInteger(item.mcc) || item.mcc < 0 || item.mcc > 9999) throw new Error("Card merchant category is invalid");
    return { merchantRef: item.merchantRef, displayName: item.displayName, merchantIdHash: item.merchantIdHash, mcc: item.mcc };
  });
}

export class CardsApiClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CardsApiOptions) {
    if (!options.baseUrl) throw new Error("Card API base URL is required");
    if (!options.authToken) throw new Error("Card API needs an owner session or connection token");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Never serialize the credential. */
  toJSON() {
    return { baseUrl: this.baseUrl, authToken: "[redacted]" };
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.authToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network failure: the outcome of a POST is unknown. Callers resume with
      // the same clientOperationId; they never invent a new operation.
      throw new CardsApiError(0, { code: "network_unknown", message: "Card API could not be reached; the outcome is unknown", retryable: true, evidenceState: "unknown" });
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    }
    if (!response.ok) {
      const body = (parsed ?? {}) as Partial<CardsApiErrorBody>;
      // A gateway or proxy error (408/502/503/504, or any 5xx without Axum's
      // JSON error body) says nothing about whether Axum acted: for a POST the
      // outcome is unknown, exactly like a dropped connection (review F2).
      const gateway = [408, 502, 503, 504].includes(response.status) || (response.status >= 500 && typeof body.code !== "string");
      if (method === "POST" && gateway && typeof body.code !== "string") {
        throw new CardsApiError(response.status, { code: "network_unknown", message: `Card API answered ${response.status} before confirming; the outcome is unknown`, retryable: true, evidenceState: "unknown" });
      }
      throw new CardsApiError(response.status, body);
    }
    return parsed as T;
  }

  async prepareCard(input: { label: string; clientOperationId: string }): Promise<PreparedCard> {
    if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 40) throw new Error("label must be 1-40 characters");
    return this.request("POST", "/v1/cards/prepare", { clientOperationId: assertClientOperationId(input.clientOperationId), label: input.label.trim() });
  }

  async activateCard(cardId: string, expectedPolicyVersion: number, clientOperationId: string): Promise<CardView> {
    if (!Number.isInteger(expectedPolicyVersion) || expectedPolicyVersion < 1) throw new Error("expectedPolicyVersion must be a positive integer");
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/activate`, { clientOperationId: assertClientOperationId(clientOperationId), expectedPolicyVersion });
  }

  async listCards(): Promise<{ cards: CardView[] }> {
    return this.request("GET", "/v1/cards");
  }

  async getCard(cardId: string): Promise<CardView> {
    return this.request("GET", `/v1/cards/${assertCardId(cardId)}`);
  }

  async freezeCard(cardId: string, reason: string, clientOperationId: string): Promise<FreezeResult> {
    if (typeof reason !== "string" || !reason.trim() || reason.length > 200) throw new Error("reason must be 1-200 characters");
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/freeze`, { clientOperationId: assertClientOperationId(clientOperationId), reason: reason.trim() });
  }

  /** Owner session only, after the owner signed `unfreeze` on the TEE. */
  async unfreezeMirror(cardId: string, expectedPolicyVersion: number, clientOperationId: string): Promise<CardView> {
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/unfreeze-mirror`, { clientOperationId: assertClientOperationId(clientOperationId), expectedPolicyVersion });
  }

  /** Owner session only. The single human display of the card number, inside Lithic's iframe. Never for agents. */
  async createEmbedSession(cardId: string): Promise<{ embedUrl: string; expiresAt: string }> {
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/embed-session`, {});
  }

  async getCardActivity(cardId: string, page: { cursor?: string; limit?: number } = {}): Promise<Page<CardActivityRow>> {
    const params = new URLSearchParams();
    if (page.cursor) params.set("cursor", page.cursor);
    if (page.limit !== undefined) {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new Error("limit must be 1-100");
      params.set("limit", String(page.limit));
    }
    const query = params.toString();
    return this.request("GET", `/v1/cards/${assertCardId(cardId)}/activity${query ? `?${query}` : ""}`);
  }

  async listStatements(cardId: string): Promise<StatementList> {
    return this.request("GET", `/v1/cards/${assertCardId(cardId)}/statements`);
  }

  /** Owner session only: close the running statement now (interim close; the budget period is untouched). */
  async closeStatement(cardId: string, clientOperationId: string): Promise<StatementView> {
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/statements/close`, { clientOperationId: assertClientOperationId(clientOperationId) });
  }

  /** The sandbox shop registry with the allowlist hash for each shop. */
  async listMerchants(): Promise<CardMerchantListing[]> {
    const body = await this.request<{ merchants?: unknown }>("GET", "/v1/cards/merchants");
    return parseMerchantListings(body?.merchants);
  }

  async getStatement(cardId: string, statementId: string): Promise<StatementView> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(statementId)) throw new Error("statementId has an unexpected format");
    return this.request("GET", `/v1/cards/${assertCardId(cardId)}/statements/${encodeURIComponent(statementId)}`);
  }

  /** Owner session only. Submits an existing receipt for verification; never pays. */
  async submitRepayment(cardId: string, statementId: string, input: { receiptPda: string; mandatePda: string; cluster: "devnet" }): Promise<{ state: StatementState }> {
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/statements/${encodeURIComponent(statementId)}/repayment`, input);
  }

  async requestCardCheckout(input: RequestCardCheckoutInput): Promise<CheckoutCapabilityResponse> {
    parseCents(input.amountCents, "amountCents");
    if (input.currency !== "USD") throw new Error("Cards only spend USD");
    if (typeof input.merchantRef !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.merchantRef)) throw new Error("merchantRef has an unexpected format");
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 80)) throw new Error("description must be at most 80 characters");
    const body = await this.request<unknown>("POST", `/v1/cards/${assertCardId(input.cardId)}/checkout-intents`, {
      clientOperationId: assertClientOperationId(input.clientOperationId),
      merchantRef: input.merchantRef,
      amountCents: input.amountCents,
      currency: "USD",
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    return parseCheckoutCapabilityResponse(body);
  }

  /**
   * Owner session only. Without a digest (or with a stale one) Axum answers `review_required` and refreshes the
   * report on the card; with the reviewed digest it returns the authorizer-co-signed `restoreTx` to check and sign.
   */
  async prepareRestore(cardId: string, input: { clientOperationId: string; reconReportDigest?: string }): Promise<PreparedRestore> {
    if (input.reconReportDigest !== undefined && !/^[0-9a-f]{64}$/.test(input.reconReportDigest)) throw new Error("reconReportDigest must be 64 lowercase hex characters");
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/recovery/restore`, {
      clientOperationId: assertClientOperationId(input.clientOperationId),
      ...(input.reconReportDigest === undefined ? {} : { reconReportDigest: input.reconReportDigest }),
    });
  }

  /**
   * Owner session only, after the co-signed restore landed on PER: Axum replays issuer events it never applied and
   * returns an unsigned `confirm_reconciled` for the reviewed digest. The card stays frozen.
   */
  async reconcileRecovery(cardId: string, clientOperationId: string): Promise<{ state: string; issuerEventsReplayed: number; reconDigest: string; confirmReconciledTx: string }> {
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/recovery/reconcile`, { clientOperationId: assertClientOperationId(clientOperationId) });
  }

  /** Owner session only: the checkpoint's master salt, for a field-picker disclosure. */
  async disclosureSalt(cardId: string, seq?: string): Promise<{ cardId: string; seq: string; masterSalt: string; commitment: { state: "current" | "superseded" | "pending"; onChainSeq?: string | null } }> {
    if (seq !== undefined && !/^[1-9][0-9]{0,19}$/.test(seq)) throw new Error("seq must be a positive integer");
    return this.request("GET", `/v1/cards/${assertCardId(cardId)}/disclosure-salt${seq === undefined ? "" : `?seq=${seq}`}`);
  }
}
