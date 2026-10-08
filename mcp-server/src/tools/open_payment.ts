import { createHash } from "node:crypto";
import { canonicalPaymentRequest, type PaymentRequestPayload } from "@chainpayhq/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { requiredString, solanaAddress, toolResult } from "./common.js";
import { requireObject } from "./payment-input.js";
import { derivePaymentReferences } from "./payment-request-references.js";
import { formatTokenAmount, tokenLabel } from "./token-amount.js";
import { createFlow, flowUrl } from "../payment-flows.js";
import { shortAddress, type PaymentWidgetView } from "../widget/view.js";
import { relayPaymentId } from "./settlement-submit.js";

/**
 * Opens the payment card before anything is checked or paid. The owner has
 * already said to pay; this only shows the card at its first step and hands
 * the agent the exact execute_payment call that will move it. Nothing here is
 * verified yet, so the card shows no merchant name, product or checks until
 * execute_payment proves them.
 */
export async function openPayment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const request = requireObject(args.request);
  const payload = requireObject(request.payload) as unknown as PaymentRequestPayload;
  const signature = requiredString(request.signature, "request.signature");
  const mandate = solanaAddress(args.mandate, "mandate");
  const agent = solanaAddress(args.agent, "agent");
  const mint = solanaAddress(payload.mint, "request.payload.mint");
  const recipient = solanaAddress(payload.recipient, "request.payload.recipient");
  const amount = requiredString(payload.amount, "request.payload.amount");
  if (!/^\d+$/.test(amount)) throw new Error("request.payload.amount must be an unsigned integer string");
  const signingMode = args.signingMode === undefined ? "delegated" : args.signingMode;
  if (signingMode !== "human" && signingMode !== "delegated") throw new Error("signingMode must be human or delegated");

  // The same references quote_payment_request derives; execute_payment checks
  // that the signed request really hashes to them before anything is prepared.
  const invoiceHash = createHash("sha256").update(canonicalPaymentRequest(payload), "utf8").digest("hex");
  const { paymentId, signatureReference } = derivePaymentReferences(invoiceHash, signature);

  let decimals: number | undefined;
  try {
    decimals = await context.client.getMintDecimals(mint);
  } catch {
    decimals = undefined;
  }
  const cluster = payload.cluster === "mainnet-beta" ? "Solana" : "Solana Devnet";
  const view: PaymentWidgetView = {
    version: 1,
    state: "paying",
    currentStep: 0,
    amount: decimals === undefined ? undefined : formatTokenAmount(BigInt(amount), decimals),
    symbol: tokenLabel(mint),
    decimals,
    cluster,
    recipientShort: shortAddress(recipient),
  };

  let flowId: string | undefined;
  try {
    flowId = await createFlow(context, view, relayPaymentId(context.principal!.wallet, `${mandate}:${invoiceHash}`));
  } catch (error) {
    console.error(`[chainpay] payment card could not be stored: ${error instanceof Error ? error.name : "unknown"}`);
  }

  const execute = {
    mandate,
    agent,
    signingMode,
    request: { payload, signature },
    invoiceHash,
    paymentId,
    signatureReference,
    mint,
    recipient,
    amount,
    tokenProgram: payload.tokenProgram,
    ...(flowId ? { flowId } : {}),
  };
  const link = flowId ? flowUrl(flowId) : undefined;
  return toolResult({
    action: "payment_opened",
    ...(flowId ? { flowId, flowUrl: link } : {}),
    widget: { ...view, ...(flowId ? { flowId, flowUrl: link } : {}) },
    continuation: { tool: "execute_payment", arguments: execute },
    message: flowId
      ? `Payment card opened. Nothing has been checked or paid yet. Call execute_payment now with continuation.arguments, then wait_for_payment with the returned paymentId and the same flowId. If this app can't show the card, give the owner this link to watch it live: ${link}`
      : "Live card unavailable on this connection. Call execute_payment with continuation.arguments to pay.",
  });
}
