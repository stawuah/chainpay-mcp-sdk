import { createHash, createHmac } from "node:crypto";
import { deriveCrossmintPaymentReferences, crossmintFieldsToPreparePaymentInput, crossmintPaymentTransaction, crossmintTermsToPrepareFields, validateCrossmintCheckoutOrder, type CrossmintPaymentTerms } from "@chainpayhq/sdk";
import { authorizeMandate } from "../authorization.js";
import { materializeUnsignedTransaction, serializeTransaction, solanaAddress, toolResult } from "./common.js";
import type { ChainPayMcpContext } from "./context.js";
import { fetchCrossmintOrder, requireCrossmintEnabled } from "./crossmint-provider.js";
import { requirementsFromPreflight } from "./check_payment_requirements.js";
import { submitSettlement } from "./settlement-submit.js";

/**
 * Solana Devnet's full genesis hash, as `getGenesisHash` returns it. The
 * 32-character `solana:EtWT…` CAIP-2 reference is a truncation of this value
 * and never equals what the RPC reports.
 */
const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function backend(context: ChainPayMcpContext) {
  if (!context.principal || !context.backendUrl || !context.backendAuthToken) throw new Error("Crossmint requires an authenticated caller and Axum relay");
  return { url: context.backendUrl.replace(/\/$/, ""), headers: { Authorization: `Bearer ${context.backendAuthToken}`, "Content-Type": "application/json" } };
}
/**
 * What the owner approved. The memo is included because it is what makes the
 * payment Crossmint's order and not an anonymous transfer to its shared treasury:
 * a re-fetched order with a different memo needs a fresh review.
 */
export function crossmintTermsFingerprint(terms: CrossmintPaymentTerms): string {
  return createHash("sha256").update(JSON.stringify([terms.orderId, terms.mint, terms.recipient, terms.amount, terms.decimals, terms.tokenProgram, terms.payerAddress, terms.crossmintSourceTokenAccount, terms.lineItemLocators, terms.items ?? null, terms.memo ?? null])).digest("hex");
}
/** What the owner reviews: the price and also which item, who receives it, and how many. */
function requestView(terms: CrossmintPaymentTerms) {
  const names = (terms.items ?? []).map(item => item.name).filter((name): name is string => typeof name === "string");
  return { orderId: terms.orderId, quoteCheck: terms.quoteCheck, quotedAmount: terms.amount, phase: terms.phase, ...(names.length ? { itemLabel: names.join(", ") } : {}), items: (terms.items ?? []).map(item => ({ name: item.name, locator: item.locator, quantity: item.quantity, deliveryRecipient: item.deliveryRecipient })) };
}
const DELIVERY_STATES = new Set(["delivered", "pending", "failed", "unknown"]);
type CrossmintObservation = { orderPhase?: string; evidenceSource?: string; reportedAtMs?: number; paymentStatus?: string; delivery?: string; refunded?: { amount?: string; currency?: string } | null; deliveries?: Array<{ status?: string; failureCode?: string }> };
/**
 * Crossmint's report, field by field. Payment, delivery and refund are read
 * independently: a completed order whose delivery failed or was refunded is
 * never collapsed into "complete".
 */
function providerView(orderId: string, observation: CrossmintObservation | undefined) {
  const delivery = typeof observation?.delivery === "string" && DELIVERY_STATES.has(observation.delivery) ? observation.delivery : "unknown";
  const refund = observation?.refunded && typeof observation.refunded.amount === "string" ? { amount: observation.refunded.amount, ...(typeof observation.refunded.currency === "string" ? { currency: observation.refunded.currency } : {}) } : undefined;
  return {
    orderId,
    ...(observation?.orderPhase ? { phase: observation.orderPhase } : {}),
    ...(typeof observation?.paymentStatus === "string" ? { paymentStatus: observation.paymentStatus } : {}),
    delivery,
    refunded: Boolean(refund),
    ...(refund ? { refund } : {}),
    ...(Array.isArray(observation?.deliveries) ? { deliveries: observation!.deliveries!.map(line => ({ status: typeof line?.status === "string" ? line.status : "unknown", ...(typeof line?.failureCode === "string" ? { failureCode: line.failureCode } : {}) })) } : {}),
    ...(Number.isSafeInteger(observation?.reportedAtMs) ? { reportedAt: new Date(observation!.reportedAtMs!).toISOString() } : {}),
  };
}
async function preparedOrder(context: ChainPayMcpContext, args: Record<string, unknown>, mayPatch: boolean) {
  requireCrossmintEnabled(); backend(context);
  if ((process.env.CHAINPAY_CROSSMINT_AUTH_SECRET?.length ?? 0) < 32) throw new Error("Crossmint relay authorization is not configured");
  const mandateAddress = solanaAddress(args.mandate, "mandate");
  const agent = solanaAddress(args.agent, "agent");
  const mandate = await authorizeMandate(context, mandateAddress);
  if (agent !== mandate.approvedAgent) throw new Error("Agent differs from the approved mandate agent");
  if (await context.client.connection.getGenesisHash() !== SOLANA_DEVNET_GENESIS_HASH) throw new Error("Crossmint staging requires Solana Devnet");
  if (typeof args.orderId !== "string") throw new Error("orderId is required");
  let order = await fetchCrossmintOrder(args.orderId);
  if (args.preparePayer === true) {
    if (!mayPatch || context.principal!.scope) throw new Error("Changing order payer requires explicit preparation by the owner session");
    if (!["quote", "payment"].includes(order.phase) || order.payerAddress && order.payerAddress !== context.principal!.wallet) throw new Error("This order cannot be assigned to this owner");
    // No automatic PATCH retries: an unknown mutation outcome is reconciled by GET.
    await context.assertActive?.();
    order = await fetchCrossmintOrder(args.orderId, context.principal!.wallet);
  }
  const terms = validateCrossmintCheckoutOrder(order, { orderId: args.orderId, owner: context.principal!.wallet, source: mandate.sourceTokenAccount, mint: mandate.allowedMint });
  const fields = await crossmintTermsToPrepareFields(terms);
  const input = crossmintFieldsToPreparePaymentInput(mandateAddress, fields);
  const payment = await context.client.preparePayment(input, agent);
  // Crossmint matches a payment to its order only by the memo, so the signed
  // transaction is execute_payment followed by Crossmint's exact memo.
  const prepared = { ...payment, transaction: crossmintPaymentTransaction(payment.transaction, terms) };
  return { terms, fields, input, prepared, agent, fingerprint: crossmintTermsFingerprint(terms), expiresAtMs: Math.min(Date.parse(order.quoteExpiresAt!), Date.now() + 120_000).toString() };
}
export async function prepareCrossmintPayment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const { terms, fields, prepared, agent, fingerprint } = await preparedOrder(context, args, true);
  if (!prepared.preflight.valid) return toolResult({ action: "rejected_by_preflight", preflight: prepared.preflight, requirements: requirementsFromPreflight(prepared.preflight) }, true);
  const payment = { mandate: args.mandate, agent, ...fields, expectedTerms: fingerprint, signingMode: "human" };
  const continuation = { tool: "execute_crossmint_payment", arguments: { orderId: terms.orderId, mandate: args.mandate, agent, invoiceHash: fields.invoiceHash, expectedTerms: fingerprint, signingMode: "human" } };
  return toolResult({ action: "crossmint_agent_signature_required", payment, crossmint: requestView(terms), receiptAddress: prepared.receiptAddress, preflight: prepared.preflight, requirements: requirementsFromPreflight(prepared.preflight), transaction: serializeTransaction(prepared.transaction), unsignedTransaction: await materializeUnsignedTransaction(context.client, prepared.transaction), continuation, message: "Review this Devnet order and sign the ChainPay transaction. No payment has been submitted." });
}

/**
 * Relay answers that prove the payment was refused before broadcast. The same
 * set as the dashboard's `callMcpTool`; every other failure may follow a send.
 */
const RELAY_REJECTED_BEFORE_BROADCAST = new Set([400, 401, 403, 404, 422]);

/** The re-fetched order no longer matches what the owner reviewed. */
class ReviewRequired extends Error {
  constructor() { super("Crossmint order changed (price, item, quantity, delivery wallet or order memo) or was not reviewed. Prepare and review it again; nothing was submitted."); }
}

export async function executeCrossmintPayment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  if (typeof args.paymentId === "string" && /^payment_/.test(args.paymentId)) return crossmintPaymentStatus(context, args);
  // Check the deterministic original operation before current quote/preflight:
  // a paid order is no longer payable, but its outcome must still be recoverable.
  if (typeof args.orderId === "string" && typeof args.mandate === "string" && context.principal) {
    const relay = backend(context);
    const references = await deriveCrossmintPaymentReferences(args.orderId);
    const id = `payment_${createHash("sha256").update(`${context.principal.wallet}:${args.mandate}:${references.invoiceHash}`).digest("hex")}`;
    const existing = await fetch(`${relay.url}/v1/payments/${id}/connector`, { headers: relay.headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (existing.ok) return crossmintPaymentStatus(context, { paymentId: id });
    if (existing.status !== 404) throw new Error("Original operation could not be checked; do not submit a replacement");
  }
  // Only these structured failures prove the relay was never called.
  let checked: Awaited<ReturnType<typeof preparedOrder>>;
  try {
    checked = await preparedOrder(context, args, false);
    if (args.invoiceHash !== checked.fields.invoiceHash) throw new Error("Invoice reference is missing or differs from the Crossmint order");
    if (args.expectedTerms !== checked.fingerprint) throw new ReviewRequired();
    if (!checked.prepared.preflight.valid) return toolResult({ action: "rejected_by_preflight", preflight: checked.prepared.preflight }, true);
    if (args.signingMode !== "human" && args.signingMode !== "delegated") throw new Error("Choose human or delegated signing explicitly");
    if (args.signingMode === "human" && typeof args.signedTransaction !== "string") throw new Error("Human execution requires the original approved signed transaction");
    if (args.signingMode === "delegated" && args.signedTransaction !== undefined) throw new Error("Delegated execution does not accept signed transactions");
  } catch (error) { return toolResult({ action: "crossmint_rejected_before_submission", ...(error instanceof ReviewRequired ? { reviewRequired: true } : {}), message: error instanceof Error ? error.message : "Crossmint preparation failed" }, true); }
  const { terms, fields, prepared, agent } = checked;
  const relay = backend(context);
  await context.assertActive?.();
  const delegated = args.signingMode === "delegated";
  const wire = delegated ? (await materializeUnsignedTransaction(context.client, prepared.transaction)).value : args.signedTransaction;
  const payload = JSON.stringify({ version: 1, owner: context.principal!.wallet, mandate: args.mandate, agent, invoiceHash: fields.invoiceHash, terms, expiresAtMs: checked.expiresAtMs });
  const mac = createHmac("sha256", process.env.CHAINPAY_CROSSMINT_AUTH_SECRET!).update(payload).digest("hex");
  const response = await submitSettlement(context, `${relay.url}/v1/${delegated ? "managed-payments" : "payments"}`, {
    method: "POST", headers: relay.headers, body: JSON.stringify({
      idempotency_key: `${args.mandate}:${fields.invoiceHash}`, mandate: args.mandate, agent,
      invoice_hash: fields.invoiceHash, receipt_address: prepared.receiptAddress,
      [delegated ? "unsigned_transaction" : "signed_transaction"]: wire,
      mint: fields.mint, recipient: fields.recipient, amount: fields.amount, token_program: fields.tokenProgram,
      crossmint: { order_id: terms.orderId, terms: { ...terms, authorization: { payload, mac } } },
    }),
  });
  const payment = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    if (RELAY_REJECTED_BEFORE_BROADCAST.has(response.status)) return toolResult({ action: "backend_rejected", httpStatus: response.status, ...payment }, true);
    // Any other failure (5xx, 409, a proxy error) can arrive after the relay
    // broadcast the transaction, so it is never reported as a rejection.
    const paymentId = `payment_${createHash("sha256").update(`${context.principal!.wallet}:${args.mandate}:${fields.invoiceHash}`).digest("hex")}`;
    return toolResult({
      action: "crossmint_payment_pending", status: "unknown", payment_id: paymentId, httpStatus: response.status,
      ...(typeof payment.error === "string" ? { relayError: payment.error } : {}),
      receiptAddress: prepared.receiptAddress, crossmint: requestView(terms),
      continuation: { tool: "get_crossmint_payment", arguments: { paymentId } },
      message: `The relay answered HTTP ${response.status}, so this payment may already have been sent. Resume with paymentId to check it. Do not retry or prepare a replacement.`,
    });
  }
  if (payment.status === "confirmed" && typeof payment.payment_id === "string") {
    try { return await crossmintPaymentStatus(context, { paymentId: payment.payment_id }); }
    catch { return toolResult({ ...payment, action: "crossmint_settled", receiptAddress: prepared.receiptAddress, providerStatus: "unknown", crossmint: { orderId: terms.orderId }, message: "Payment confirmed; order readback is unavailable. Resume this paymentId without paying again." }); }
  }
  return toolResult({ ...payment, action: "crossmint_payment_pending", receiptAddress: prepared.receiptAddress, crossmint: requestView(terms), continuation: { tool: "get_crossmint_payment", arguments: { paymentId: payment.payment_id } }, message: "Reconcile this operation using paymentId. Do not prepare a replacement." }, payment.status === "failed");
}

/** Read/reconcile only, even if checkout has subsequently been disabled. */
export async function crossmintPaymentStatus(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const relay = backend(context);
  const id = args.paymentId;
  if (typeof id !== "string" || !/^payment_[a-f0-9]{64}$/.test(id)) throw new Error("A valid existing paymentId is required");
  const response = await fetch(`${relay.url}/v1/payments/${id}/connector`, { headers: relay.headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Original Crossmint operation unavailable (${response.status}); retain the original approval`);
  const saved = await response.json() as { connector: string; connector_reference: string; payment: Record<string, unknown>; idempotency_key: string; proof?: CrossmintObservation };
  if (saved.connector !== "crossmint" || saved.payment.payment_id !== id) throw new Error("This operation is not the requested Crossmint payment");
  let observation = saved.proof?.evidenceSource === "crossmint-staging-orders-api" ? saved.proof : undefined; let providerError: string | undefined;
  if (saved.payment.status === "confirmed") {
    try {
      // Axum authenticates its own provider GET. Caller-supplied evidence is ignored.
      const readback = await fetch(`${relay.url}/v1/crossmint-orders/proof`, { method: "POST", headers: relay.headers, redirect: "error", signal: AbortSignal.timeout(20_000), body: JSON.stringify({ mandate: saved.payment.mandate, idempotency_key: saved.idempotency_key, proof: {}, order_phase: "unknown", response_status: 200 }) });
      if (!readback.ok) throw new Error("Provider readback unavailable");
      observation = (await readback.json() as { proof?: typeof observation }).proof;
    } catch { providerError = "Payment is confirmed; Crossmint order status could not be refreshed. Retry status, not payment."; }
  }
  const crossmint = providerView(saved.connector_reference, observation);
  return toolResult({ ...saved.payment, action: saved.payment.status === "confirmed" ? "crossmint_settled" : "crossmint_payment_pending", receiptAddress: saved.payment.receipt_address, crossmint, providerStatus: observation?.orderPhase ?? "unknown", providerDelivery: crossmint.delivery, ...(providerError ? { message: providerError } : {}), continuation: { tool: "get_crossmint_payment", arguments: { paymentId: id } } }, saved.payment.status === "failed");
}
