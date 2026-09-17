import { submitSettlement } from "./settlement-submit.js";
import type { ChainPayMcpContext } from "./context.js";
import { bytesToHex } from "@chainpay/sdk";
import { materializeUnsignedTransaction, serializeTransaction, toolResult } from "./common.js";
import { parsePaymentInput, requireObject } from "./payment-input.js";
import { requirementsFromPreflight } from "./check_payment_requirements.js";

export async function executePayment(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const input = requireObject(args);
  const signingMode = input.signingMode === undefined ? "human" : input.signingMode;
  if (signingMode !== "human" && signingMode !== "delegated") {
    throw new Error("signingMode must be human or delegated");
  }
  const parsed = parsePaymentInput(input);
  const prepared = await context.client.preparePayment(parsed.input, parsed.agent);
  if (!prepared.preflight.valid) {
    return toolResult(
      {
        action: "rejected_by_preflight",
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        capabilityProfile: prepared.capabilityProfile,
        requirements: requirementsFromPreflight(prepared.preflight),
        transaction: serializeTransaction(prepared.transaction),
      },
      true,
    );
  }

  if (signingMode === "human" && context.agentAddress && parsed.agent !== context.agentAddress) {
    return toolResult(
      {
        action: "agent_identity_mismatch",
        message: "The requested agent does not match the configured approved-agent public identity.",
        configuredAgent: context.agentAddress,
        requestedAgent: parsed.agent,
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        capabilityProfile: prepared.capabilityProfile,
        requirements: requirementsFromPreflight(prepared.preflight),
      },
      true,
    );
  }

  const signedTransaction = typeof input.signedTransaction === "string"
    ? input.signedTransaction.trim()
    : undefined;
  if (signingMode === "delegated") {
    if (signedTransaction) {
      return toolResult({
        action: "delegated_signature_rejected",
        message: "Delegated mode accepts only an unsigned ChainPay transaction; Axum obtains the provider signature after validation.",
        receiptAddress: prepared.receiptAddress,
      }, true);
    }
    if (!context.backendUrl || !context.backendAuthToken) {
      return toolResult({
        action: "managed_backend_required",
        message: "Delegated mode requires CHAINPAY_BACKEND_URL and a verified caller session or scoped connection.",
        receiptAddress: prepared.receiptAddress,
      }, true);
    }
    const unsignedTransaction = await materializeUnsignedTransaction(context.client, prepared.transaction);
    const response = await submitSettlement(context, `${context.backendUrl.replace(/\/$/, "")}/v1/managed-payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.backendAuthToken}`,
      },
      body: JSON.stringify({
        idempotency_key: `${parsed.input.mandate}:${bytesToHex(parsed.input.invoiceHash)}`,
        mandate: parsed.input.mandate,
        invoice_hash: bytesToHex(parsed.input.invoiceHash),
        receipt_address: prepared.receiptAddress,
        unsigned_transaction: unsignedTransaction.value,
        agent: parsed.agent,
        mint: parsed.input.mint,
        recipient: parsed.input.recipient,
        amount: parsed.input.amount.toString(),
        token_program: parsed.input.tokenProgram,
      }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return toolResult({ action: "managed_backend_rejected", httpStatus: response.status, ...payload }, true);
    }
    if (payload.status !== "confirmed" || typeof payload.signature !== "string") {
      return toolResult({
        action: payload.status === "failed" ? "managed_payment_failed" : "payment_pending",
        ...payload,
        receiptAddress: prepared.receiptAddress,
        message: "Keep payment_id and signature. Use wait_for_payment to reconcile this operation; do not sign or submit a replacement.",
      }, payload.status === "failed");
    }
    return toolResult({
      action: "managed_payment_settled",
      signingMode,
      ...payload,
      receiptAddress: prepared.receiptAddress,
      preflight: prepared.preflight,
      capabilityProfile: prepared.capabilityProfile,
      requirements: requirementsFromPreflight(prepared.preflight),
    });
  }
  if (signedTransaction) {
    if (!context.backendUrl) {
      return toolResult(
        {
          action: "backend_required",
          message: "CHAINPAY_BACKEND_URL must be configured to relay a signed transaction.",
          receiptAddress: prepared.receiptAddress,
          preflight: prepared.preflight,
          capabilityProfile: prepared.capabilityProfile,
          requirements: requirementsFromPreflight(prepared.preflight),
          transaction: serializeTransaction(prepared.transaction),
        },
        true,
      );
    }

    const response = await submitSettlement(context, `${context.backendUrl.replace(/\/$/, "")}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(context.backendAuthToken
          ? { Authorization: `Bearer ${context.backendAuthToken}` }
          : {}),
      },
      body: JSON.stringify({
        idempotency_key: `${parsed.input.mandate}:${bytesToHex(parsed.input.invoiceHash)}`,
        mandate: parsed.input.mandate,
        invoice_hash: bytesToHex(parsed.input.invoiceHash),
        receipt_address: prepared.receiptAddress,
        signed_transaction: signedTransaction,
        agent: parsed.agent,
        mint: parsed.input.mint,
        recipient: parsed.input.recipient,
        amount: parsed.input.amount.toString(),
        token_program: parsed.input.tokenProgram,
      }),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      return toolResult({ action: "backend_rejected", httpStatus: response.status, ...payload }, true);
    }
    if (payload.status !== "confirmed" || typeof payload.signature !== "string") {
      return toolResult({
        action: payload.status === "failed" ? "payment_failed" : "payment_pending",
        ...payload,
        receiptAddress: prepared.receiptAddress,
        message: "Keep payment_id and signature. Use wait_for_payment to reconcile this operation; do not sign or submit a replacement.",
      }, payload.status === "failed");
    }
    return toolResult({
      action: "backend_relayed",
      ...payload,
      receiptAddress: prepared.receiptAddress,
      preflight: prepared.preflight,
      capabilityProfile: prepared.capabilityProfile,
      requirements: requirementsFromPreflight(prepared.preflight),
    });
  }

  return toolResult({
    action: "agent_signature_required",
    signingMode,
    message: "Sign this transaction in the browser wallet or external agent runtime, then call execute_payment again with signedTransaction.",
    receiptAddress: prepared.receiptAddress,
    preflight: prepared.preflight,
    capabilityProfile: prepared.capabilityProfile,
    requirements: requirementsFromPreflight(prepared.preflight),
    transaction: serializeTransaction(prepared.transaction),
    unsignedTransaction: await materializeUnsignedTransaction(context.client, prepared.transaction),
  });
}
