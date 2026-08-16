import type { ChainPayMcpContext } from "./context.js";
import { bytesToHex } from "@chainpay/sdk";
import { serializeTransaction, toolResult } from "./common.js";
import { parsePaymentInput, requireObject } from "./payment-input.js";
import { requirementsFromPreflight } from "./check_payment_requirements.js";

export async function executePayment(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  const input = requireObject(args);
  const parsed = parsePaymentInput(input);
  const prepared = await context.client.preparePayment(parsed.input, parsed.agent);
  if (!prepared.preflight.valid) {
    return toolResult(
      {
        action: "rejected_by_preflight",
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        requirements: requirementsFromPreflight(prepared.preflight),
        transaction: serializeTransaction(prepared.transaction),
      },
      true,
    );
  }

  const signedTransaction = typeof input.signedTransaction === "string"
    ? input.signedTransaction.trim()
    : undefined;
  if (signedTransaction) {
    if (!context.backendUrl) {
      return toolResult(
        {
          action: "backend_required",
          message: "CHAINPAY_BACKEND_URL must be configured to relay a signed transaction.",
          receiptAddress: prepared.receiptAddress,
          preflight: prepared.preflight,
          requirements: requirementsFromPreflight(prepared.preflight),
          transaction: serializeTransaction(prepared.transaction),
        },
        true,
      );
    }

    const response = await fetch(`${context.backendUrl.replace(/\/$/, "")}/v1/payments`, {
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
      return toolResult({ action: "backend_rejected", ...payload }, true);
    }
    return toolResult({
      action: "backend_relayed",
      ...payload,
      receiptAddress: prepared.receiptAddress,
      preflight: prepared.preflight,
      requirements: requirementsFromPreflight(prepared.preflight),
    }, payload.status === "failed");
  }

  if (!context.paymentExecutor) {
    return toolResult(
      {
        action: "execution_adapter_required",
        message: "No transaction execution adapter is configured. Return this transaction to a wallet or approved signer service.",
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        transaction: serializeTransaction(prepared.transaction),
      },
      true,
    );
  }

  if (context.agentAddress && parsed.agent !== context.agentAddress) {
    return toolResult(
      {
        action: "agent_identity_mismatch",
        message: "The requested agent does not match the configured approved-agent signer.",
        configuredAgent: context.agentAddress,
        requestedAgent: parsed.agent,
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        requirements: requirementsFromPreflight(prepared.preflight),
      },
      true,
    );
  }

  const result = await context.client.executePayment(prepared, context.paymentExecutor);
  return toolResult({ ...result, requirements: requirementsFromPreflight(prepared.preflight) }, result.status === "failed");
}
