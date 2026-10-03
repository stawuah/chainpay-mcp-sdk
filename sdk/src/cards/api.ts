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
};

export class CardsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly evidenceState?: string;

  constructor(status: number, body: Partial<CardsApiErrorBody>) {
    super(body.message || `Card API request failed (${status})`);
    this.name = "CardsApiError";
    this.status = status;
    this.code = body.code || "card_api_error";
    this.retryable = body.retryable === true;
    this.operationId = body.operationId;
    this.evidenceState = body.evidenceState;
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

/** No policy values: the owner reads those from the TEE with their own token. */
export type CardView = {
  cardId: string;
  label: string;
  lastFour: string;
  issuerState: string;
  mirror: { state: string; acknowledgedAt?: string; policyVersionMirrored?: number };
  freeze: { onChain: boolean; issuer: IssuerFreezeState };
  commitment?: { seq: string; root: string; slot: string };
  recovery?: { state: string; [key: string]: unknown };
};

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
  merchant?: CardMerchantView;
  intentId?: string;
  agent?: string;
  declineReason?: CardDeclineReason;
  exception?: "forced_capture" | "over_capture" | "unpaired_capture" | string;
  needsReview?: boolean;
};

export type Page<T> = { rows: T[]; nextCursor?: string | null };

export type StatementLine = {
  kind: "purchase" | "refund" | "adjustment_debit" | "adjustment_credit";
  amountCents: string;
  feeCents: string;
  at: string;
  merchant?: CardMerchantView;
  exception?: string;
};

export type StatementView = {
  statementId: string;
  cardId: string;
  periodIndex: number;
  state: StatementState;
  closedAt?: string;
  dueAt?: string;
  totalCents: string;
  feeCents: string;
  digest?: string;
  lines: StatementLine[];
  repayment?: { receiptPda?: string; mandatePda?: string; verifiedAt?: string; mismatch?: string[] };
  partner?: { confirmedAt?: string; ref?: string };
  /** Always true: the credit facility is a labelled simulation. */
  simulatedCredit: true;
};

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
    if (!response.ok) throw new CardsApiError(response.status, (parsed ?? {}) as Partial<CardsApiErrorBody>);
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

  async listStatements(cardId: string): Promise<{ statements: StatementView[] }> {
    return this.request("GET", `/v1/cards/${assertCardId(cardId)}/statements`);
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

  /** Owner session only. Returns the prepared `restore` args for the owner to review and sign. */
  async prepareRestore(cardId: string, input: { clientOperationId: string; reconReportDigest: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/cards/${assertCardId(cardId)}/recovery/restore`, { clientOperationId: assertClientOperationId(input.clientOperationId), reconReportDigest: input.reconReportDigest });
  }
}
