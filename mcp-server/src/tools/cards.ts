import { randomUUID } from "node:crypto";
import {
  CardsApiClient,
  CardsApiError,
  DECLINE_COPY,
  cardDraftDigest,
  cardDraftMaxObligationCents,
  encodeCardDraftReviewLink,
  findCardNumberLikeInInput,
  formatFeeBps,
  formatUsdCents,
  isForbiddenCardKey,
  normalizeCardDraft,
  parseCents,
  redactCardNumbersInInput,
  parseSignedCents,
  redactCardData,
  type CardActivityRow,
  type StatementView,
} from "@chainpayhq/sdk";
import type { ChainPayMcpContext } from "./context.js";

/*
 * Private Agent Card tools (contracts.md §10). What an agent can never do
 * through these tools, enforced here and in tests:
 *   - see a card number, CVV, expiry, embed URL or TEE token
 *   - grant or extend credit, raise a limit, unfreeze, change permissions
 *   - authorize or execute a statement repayment
 *   - turn a draft into a live card, or reach a card outside its scope
 * Every output is an allowlisted projection, then passes a final redaction
 * pass that drops forbidden keys and any 13-19 digit run.
 */

const CLOSED_INPUTS: Record<string, readonly string[]> = {
  prepare_agent_card: ["label", "budgetCents", "maxPurchaseCents", "merchants", "mccs", "periodDays", "expiresAt", "feeBps"],
  request_card_checkout: ["cardId", "merchantRef", "amountCents", "currency", "description", "clientOperationId"],
  get_card_activity: ["cardId", "cursor", "limit"],
  get_statement: ["cardId", "statementId"],
  freeze_agent_card: ["cardId", "reason", "clientOperationId"],
};

/** Closed input schema, enforced at runtime: an unknown field (say `creditLimit` or `unfreeze`) is refused, not ignored. */
const CARD_NUMBER_REFUSAL = "That looks like a card number. ChainPay never takes card numbers in tool calls; remove it and try again.";

function assertClosedInput(tool: string, args: Record<string, unknown>): void {
  const allowed = CLOSED_INPUTS[tool];
  // Card data first, keys included, so nothing card-like is ever echoed back
  // in the error below (review F3). Dots and slashes count as separators (F7).
  for (const key of Object.keys(args)) {
    if (isForbiddenCardKey(key)) throw new Error("Card numbers, CVVs and tokens are never accepted by ChainPay tools");
    if (findCardNumberLikeInInput(key).length) throw new Error(CARD_NUMBER_REFUSAL);
  }
  const scan = (value: unknown): void => {
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? value.toString() : undefined;
    if (text !== undefined && findCardNumberLikeInInput(text).length) throw new Error(CARD_NUMBER_REFUSAL);
    if (Array.isArray(value)) value.forEach(scan);
  };
  Object.values(args).forEach(scan);
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`${tool} does not accept "${redactCardNumbersInInput(key)}". Card tools can't change limits, credit, freezes or repayments beyond what they describe.`);
  }
  // Money and ids travel as strings, never JS numbers (contracts.md preamble).
  for (const key of ["amountCents", "budgetCents", "maxPurchaseCents", "cardId", "merchantRef", "clientOperationId", "statementId", "cursor"]) {
    if (args[key] !== undefined && typeof args[key] !== "string") throw new Error(`${key} must be a string`);
  }
}

export function cardToolResult(data: Record<string, unknown>, text: string, isError = false) {
  const safe = redactCardData(data).value;
  const safeText = redactCardData(text).value;
  return { isError: isError || undefined, structuredContent: safe, content: [{ type: "text", text: safeText }] };
}

function cardsApi(context: ChainPayMcpContext): CardsApiClient {
  if (!context.principal || !context.backendUrl || !context.backendAuthToken) throw new Error("Card tools need a signed-in owner session or an agent connection, and the ChainPay backend");
  return new CardsApiClient({ baseUrl: context.backendUrl, authToken: context.backendAuthToken });
}

/** Writes (checkout, freeze) resume with their clientOperationId; reads are simply safe to repeat. */
function apiFailure(tool: string, error: unknown, clientOperationId?: string) {
  if (error instanceof CardsApiError) {
    // A dropped connection, a gateway 5xx, or Axum saying it can't tell yet.
    const unknownOutcome = error.code === "network_unknown" || error.code === "outcome_unknown" || error.evidenceState === "unknown";
    const retry = clientOperationId
      ? `Call ${tool} again with clientOperationId "${clientOperationId}" to check; don't start a new one.`
      : `It only reads, so it's safe to call ${tool} again.`;
    return cardToolResult(
      { action: `${tool}_failed`, code: error.code, retryable: error.retryable, ...(error.operationId ? { operationId: error.operationId } : {}), ...(clientOperationId ? { clientOperationId } : {}), outcome: unknownOutcome ? "unknown" : "not_done" },
      unknownOutcome
        ? `**Outcome unknown.** ChainPay didn't confirm whether it happened. ${retry}`
        : `**Not done.** ${error.message}`,
      true,
    );
  }
  throw error;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function centsOrUndefined(value: unknown): string | undefined {
  try { return value === undefined ? undefined : parseCents(value).toString(); } catch { return undefined; }
}

/** Statement amounts may be negative (credit). Never clamp them to zero. */
function signedCentsOrUndefined(value: unknown): string | undefined {
  try { return value === undefined ? undefined : parseSignedCents(value).toString(); } catch { return undefined; }
}

// ------------------------------------------------------------ prepare_agent_card

/** Stateless: validates a proposal and hands the owner a review link. No storage, no network, no signing. */
export async function prepareAgentCard(_context: ChainPayMcpContext, args: Record<string, unknown>) {
  assertClosedInput("prepare_agent_card", args);
  const draft = normalizeCardDraft(args as Parameters<typeof normalizeCardDraft>[0]);
  const appUrl = (process.env.CHAINPAY_APP_URL ?? "https://chainpay-web-kappa.vercel.app").trim();
  const maxObligationCents = cardDraftMaxObligationCents(draft);
  const draftDigest = await cardDraftDigest(draft);
  const display = {
    budget: formatUsdCents(draft.budgetCents),
    maxPurchase: formatUsdCents(draft.maxPurchaseCents),
    fee: formatFeeBps(draft.feeBps),
    maxObligation: formatUsdCents(maxObligationCents),
  };
  const data = {
    action: "card_draft_prepared",
    status: "draft",
    live: false,
    reviewUrl: await encodeCardDraftReviewLink(draft, appUrl),
    draftDigest,
    maxObligationCents,
    draft,
    display,
  };
  const text = [
    `**Card draft ready for the owner.** Nothing is live yet.`,
    "",
    `- Budget: ${display.budget} every ${draft.periodDays} day${draft.periodDays === 1 ? "" : "s"}`,
    `- Max per purchase: ${display.maxPurchase}`,
    `- Platform fee: ${display.fee}, so the most the owner could owe per period is ${display.maxObligation} (simulated credit; the card refuses to bill past it)`,
    `- Shops: ${draft.merchants.length ? draft.merchants.join(", ") : "any shop in the listed categories"}${draft.mccs.length ? `; categories ${draft.mccs.join(", ")}` : ""}`,
    `- Check code: ${draftDigest.slice(0, 8)} (the owner sees the same code on the review page)`,
    "",
    "**Next step:** Send the owner the review link. Only their wallet can create the card and set these limits.",
  ].join("\n");
  return cardToolResult(data, text);
}

// --------------------------------------------------------- request_card_checkout

export async function requestCardCheckout(context: ChainPayMcpContext, args: Record<string, unknown>) {
  assertClosedInput("request_card_checkout", args);
  if (args.currency !== "USD") throw new Error("Cards only spend USD");
  const api = cardsApi(context);
  try {
    const response = await api.requestCardCheckout({
      cardId: String(args.cardId),
      merchantRef: String(args.merchantRef ?? ""),
      amountCents: String(args.amountCents ?? ""),
      currency: "USD",
      ...(args.description === undefined ? {} : { description: String(args.description) }),
      clientOperationId: String(args.clientOperationId ?? ""),
    });
    const data = {
      action: "card_checkout_ready",
      status: response.status,
      capability: response.capability,
      expiresAt: response.expiresAt,
      intentId: response.intentId,
      merchant: { displayName: response.merchant.displayName },
      amountCents: response.amountCents,
      currency: response.currency,
      display: { amount: formatUsdCents(response.amountCents) },
    };
    const text = [
      `**Checkout ready** for ${data.display.amount} at ${data.merchant.displayName}.`,
      "",
      `It works once, for this shop and amount only, until ${data.expiresAt}. The card itself still checks every rule when the shop charges it.`,
      "",
      "**Next step:** Hand the capability to the ChainPay checkout runner. It is not a card number and can't be used anywhere else.",
    ].join("\n");
    return cardToolResult(data, text);
  } catch (error) {
    return apiFailure("request_card_checkout", error, String(args.clientOperationId));
  }
}

// ------------------------------------------------------------- get_card_activity

const ROW_KINDS = new Set(["authorization", "capture", "reversal", "refund", "dispute", "exception", "freeze", "unfreeze", "policy_change", "repayment"]);

/** Allowlisted row: lifecycle facts only. No limits, balances, card data or other agents. */
export function projectActivityRow(row: CardActivityRow) {
  const amountCents = centsOrUndefined(row.amountCents);
  const declineReason = row.declineReason && row.declineReason in DECLINE_COPY ? row.declineReason : undefined;
  return {
    rowId: str(row.rowId),
    at: str(row.at),
    kind: ROW_KINDS.has(row.kind) ? row.kind : "other",
    lifecycle: str(row.lifecycle),
    ...(amountCents !== undefined ? { amountCents, amount: formatUsdCents(amountCents) } : {}),
    ...(row.merchant ? { merchant: { displayName: String(row.merchant.displayName ?? ""), mcc: String(row.merchant.mcc ?? "") } } : {}),
    ...(row.intentId ? { intentId: str(row.intentId) } : {}),
    ...(declineReason ? { declineReason, declineCopy: DECLINE_COPY[declineReason] } : {}),
    ...(row.exception ? { exception: str(row.exception) } : {}),
    needsReview: Boolean(row.exception) || row.needsReview === true,
  };
}

export async function getCardActivity(context: ChainPayMcpContext, args: Record<string, unknown>) {
  assertClosedInput("get_card_activity", args);
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error("limit must be 1-100");
  if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 256)) throw new Error("cursor must be a short string");
  const api = cardsApi(context);
  try {
    const page = await api.getCardActivity(String(args.cardId), { ...(args.cursor ? { cursor: String(args.cursor) } : {}), ...(limit ? { limit } : {}) });
    const rows = (Array.isArray(page?.rows) ? page.rows : []).map(projectActivityRow);
    const data = { action: "card_activity", cardId: String(args.cardId), rows, nextCursor: str(page?.nextCursor) ?? null };
    const lines = rows.slice(0, 10).map((row) => `- ${row.at ?? ""} ${row.kind}${row.lifecycle ? ` (${row.lifecycle})` : ""}${"amount" in row ? ` ${row.amount}` : ""}${row.merchant ? ` at ${row.merchant.displayName}` : ""}${row.declineCopy ? `: ${row.declineCopy}` : ""}${row.needsReview ? " — needs review" : ""}`);
    const text = rows.length
      ? [`**Card activity** (${rows.length} row${rows.length === 1 ? "" : "s"}).`, "", ...lines, ...(data.nextCursor ? ["", "More rows are available with the next cursor."] : [])].join("\n")
      : "**No card activity yet.**";
    return cardToolResult(data, text);
  } catch (error) {
    return apiFailure("get_card_activity", error);
  }
}

// ----------------------------------------------------------------- get_statement

export function projectStatement(statement: StatementView) {
  const totalCents = signedCentsOrUndefined(statement.totalCents);
  const feeCents = signedCentsOrUndefined(statement.feeCents);
  const amountDueCents = signedCentsOrUndefined(statement.amountDueCents);
  return {
    statementId: str(statement.statementId),
    statementSeq: Number.isInteger(statement.statementSeq) ? statement.statementSeq : undefined,
    periodIndex: Number.isInteger(statement.periodIndex) ? statement.periodIndex : undefined,
    state: str(statement.state),
    closedAt: str(statement.closedAt),
    dueAt: str(statement.dueAt),
    totalCents,
    feeCents,
    ...(amountDueCents !== undefined ? { amountDueCents } : {}),
    digest: str(statement.digest),
    lines: (Array.isArray(statement.lines) ? statement.lines : []).map((line) => ({
      kind: str(line.kind),
      amountCents: signedCentsOrUndefined(line.amountCents),
      feeCents: signedCentsOrUndefined(line.feeCents),
      at: str(line.postedAt ?? line.at),
      ...(line.merchant ? { merchant: { displayName: String(line.merchant.displayName ?? ""), mcc: String(line.merchant.mcc ?? "") } } : {}),
      ...(line.exception ? { exception: str(line.exception) } : {}),
    })),
    repaymentState: statement.repayment?.mismatch?.length ? "repayment_mismatch" : str(statement.state),
    simulatedCredit: true as const,
    label: "Simulated credit",
    // An unreadable amount is reported as unknown, never as $0.00.
    display: {
      total: totalCents === undefined ? "unknown" : formatUsdCents(totalCents),
      fee: feeCents === undefined ? "unknown" : formatUsdCents(feeCents),
      ...(amountDueCents !== undefined ? { amountDue: formatUsdCents(amountDueCents) } : {}),
    },
  };
}

export async function getStatement(context: ChainPayMcpContext, args: Record<string, unknown>) {
  assertClosedInput("get_statement", args);
  const api = cardsApi(context);
  const cardId = String(args.cardId);
  try {
    let statement: StatementView | undefined;
    if (args.statementId !== undefined) {
      statement = await api.getStatement(cardId, String(args.statementId));
    } else {
      const list = await api.listStatements(cardId);
      // Newest first: statements are numbered (an owner can close one early, inside a period).
      statement = [...(Array.isArray(list?.statements) ? list.statements : [])].sort((a, b) => (b.statementSeq ?? 0) - (a.statementSeq ?? 0) || (b.periodIndex ?? 0) - (a.periodIndex ?? 0))[0];
    }
    if (!statement) return cardToolResult({ action: "card_statement", cardId, found: false, simulatedCredit: true, label: "Simulated credit" }, "**No statement yet.** The first one closes at the end of the card's first period.");
    const projected = projectStatement(statement);
    const data = { action: "card_statement", cardId, found: true, statement: projected };
    const text = [
      `**Statement · Simulated credit.** ${projected.display.total} total, including ${projected.display.fee} in fees.`,
      "",
      `State: ${projected.state ?? "unknown"}${projected.dueAt ? `, due ${projected.dueAt}` : ""}.`,
      "",
      "**Next step:** Repayment is the owner's call, made from their own wallet in the dashboard. Agents can't pay or approve it.",
    ].join("\n");
    return cardToolResult(data, text);
  } catch (error) {
    return apiFailure("get_statement", error);
  }
}

// ------------------------------------------------------------- freeze_agent_card

/** Owner sessions only (OWNER_TOOLS). Freezing is the fail-safe direction; there is no unfreeze tool. */
export async function freezeAgentCard(context: ChainPayMcpContext, args: Record<string, unknown>) {
  assertClosedInput("freeze_agent_card", args);
  if (context.principal?.scope) throw new Error("Only the owner can freeze a card from here");
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason || reason.length > 200) throw new Error("reason must be 1-200 characters");
  const clientOperationId = typeof args.clientOperationId === "string" ? args.clientOperationId : `mcp-freeze-${randomUUID()}`;
  const api = cardsApi(context);
  try {
    const result = await api.freezeCard(String(args.cardId), reason, clientOperationId);
    const data = {
      action: "card_freeze_submitted",
      cardId: String(args.cardId),
      freezeOperationId: str(result?.freezeOperationId),
      clientOperationId,
      onChain: "submitted",
      issuer: "pending_issuer_confirmation",
    };
    return cardToolResult(data, "**Freeze sent.** New purchases will be declined once it lands. The card issuer hasn't confirmed yet, so treat it as pending until it does. Unfreezing is only possible from the owner's wallet in the dashboard.");
  } catch (error) {
    return apiFailure("freeze_agent_card", error, clientOperationId);
  }
}
