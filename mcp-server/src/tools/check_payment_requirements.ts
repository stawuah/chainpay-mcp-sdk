import { bytesToHex, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, verifyPaymentRequest, type PaymentPreflight, type PolicyCheck, type SignedPaymentRequest } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { tokenProgram, toolResult } from "./common.js";
import { parsePaymentInput, requireObject } from "./payment-input.js";
import { derivePaymentReferences } from "./payment-request-references.js";

type RequirementKey = "limits" | "token" | "recipient" | "expiry" | "policy";
type RequirementStatus = "pass" | "fail" | "missing" | "pending";
export type RequirementCheck = {
  key: RequirementKey;
  label: string;
  status: RequirementStatus;
  detail: string;
};

export type PaymentRequirements = {
  status: "ready" | "needs_details" | "blocked";
  missing: string[];
  checks: RequirementCheck[];
};

const labels: Record<RequirementKey, string> = {
  limits: "Limits",
  token: "Token",
  recipient: "Recipient",
  expiry: "Expiry",
  policy: "Policy",
};

function check(key: RequirementKey, status: RequirementStatus, detail: string): RequirementCheck {
  return { key, label: labels[key], status, detail };
}

function preflightChecks(preflight: PaymentPreflight): RequirementCheck[] {
  const byName = new Map(preflight.checks.map((item) => [item.name, item]));
  const grouped = (key: RequirementKey, names: string[], pendingDetail: string) => {
    const relevant = names.map((name) => byName.get(name)).filter((item): item is PolicyCheck => Boolean(item));
    if (relevant.length === 0) return check(key, "pending", pendingDetail);
    const failed = relevant.filter((item) => !item.ok);
    return check(
      key,
      failed.length ? "fail" : "pass",
      failed.length ? failed.map((item) => item.message).join("; ") : relevant.map((item) => item.message).join("; "),
    );
  };

  return [
    grouped("limits", ["amount_positive", "per_payment_limit", "total_limit", "payment_count_limit", "cooldown"], "Payment amount and mandate limits are waiting for a policy preflight."),
    grouped("token", ["mint", "token_program", "asset_registry"], "Provide the token mint and token program."),
    grouped("recipient", ["recipient"], "Provide the recipient token account from the invoice."),
    grouped("expiry", ["expiry"], "An active, unexpired mandate is required."),
    grouped("policy", ["mandate_status", "approved_agent", "invoice_hash", "payment_id", "signature_reference", "duplicate_invoice"], "Provide an active mandate and a verified merchant request."),
  ];
}

export function requirementsFromPreflight(preflight: PaymentPreflight): PaymentRequirements {
  const checks = preflightChecks(preflight);
  return {
    status: preflight.valid ? "ready" : "blocked",
    missing: preflight.valid ? [] : checks.filter((item) => item.status === "fail").map((item) => item.detail),
    checks,
  };
}

function incompleteChecks(args: Record<string, unknown>): { checks: RequirementCheck[]; missing: string[] } {
  const has = (name: string) => typeof args[name] === "string" && String(args[name]).trim() !== "";
  const checks: RequirementCheck[] = [
    has("amount") ? check("limits", "pending", "Limits will be checked against the active mandate.") : check("limits", "missing", "Provide the payment amount."),
    has("mint") && has("tokenProgram") ? check("token", "pending", "The token will be checked against the mandate.") : check("token", "missing", "Provide the token mint and token program."),
    has("recipient") ? check("recipient", "pending", "The recipient will be checked against the request and policy.") : check("recipient", "missing", "Provide the recipient token account."),
    has("mandate") ? check("expiry", "pending", "The mandate expiry will be checked on-chain.") : check("expiry", "missing", "Provide an active mandate so I can check its expiry."),
    has("mandate") && has("agent") ? check("policy", "pending", "The mandate, approved agent, and request references will be checked.") : check("policy", "missing", "Provide the active mandate and approved agent."),
  ];
  const missing: string[] = [];
  if (!has("amount")) missing.push("payment amount");
  if (!has("mint") || !has("tokenProgram")) missing.push("token mint and token program");
  if (!has("recipient")) missing.push("recipient token account");
  if (!has("mandate")) missing.push("active mandate");
  if (!has("agent")) missing.push("approved agent address");
  if (!has("invoiceHash") || !has("paymentId") || !has("signatureReference")) {
      checks[4] = check("policy", "missing", "Provide a merchant-signed ChainPay request with invoice, payment, and signature references.");
    missing.push("a merchant-signed ChainPay payment request");
  }
  return { checks, missing };
}

export async function checkPaymentRequirements(
  context: ChainPayMcpContext,
  args: Record<string, unknown>,
) {
  let normalizedArgs = args;
  let verification: Record<string, unknown> | undefined;
  if (args.request !== undefined) {
    try {
      const request = requireObject(args.request) as unknown as SignedPaymentRequest;
      const currentSlot = await context.client.getCurrentSlot();
      const checkedRequest = await verifyPaymentRequest(request, currentSlot);
      if (!checkedRequest.valid) {
        return toolResult({ action: "payment_request_rejected", status: "blocked", verification: checkedRequest, message: "The signed payment request must be corrected before its requirements can be checked." }, true);
      }
      const invoiceHash = bytesToHex(checkedRequest.invoiceHash);
      const references = derivePaymentReferences(invoiceHash, request.signature);
      normalizedArgs = {
        ...args,
        ...references,
        invoiceHash,
        mint: checkedRequest.payload.mint,
        recipient: checkedRequest.payload.recipient,
        amount: checkedRequest.payload.amount,
        tokenProgram: checkedRequest.payload.tokenProgram,
      };
      verification = {
        valid: true,
        invoiceHash,
        payload: checkedRequest.payload,
      };
    } catch (error) {
      return toolResult({ action: "details_required", status: "needs_details", missing: [error instanceof Error ? error.message : String(error)], message: "The signed payment request could not be verified." }, true);
    }
  }

  const incomplete = incompleteChecks(normalizedArgs);
  if (incomplete.missing.length > 0) {
    const requirements: PaymentRequirements = {
      status: "needs_details",
      missing: incomplete.missing,
      checks: incomplete.checks,
    };
    return toolResult({
      action: "details_required",
      status: "needs_details",
      missing: incomplete.missing,
      checks: incomplete.checks,
      requirements,
      message: "I need the missing payment details before I can quote, prepare, or settle this payment.",
    }, true);
  }

  let parsed;
  try {
    parsed = parsePaymentInput({
      ...normalizedArgs,
      tokenProgram: tokenProgram(normalizedArgs.tokenProgram),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolResult({
      action: "details_required",
      status: "needs_details",
      missing: [detail],
      checks: incomplete.checks,
      requirements: {
        status: "needs_details",
        missing: [detail],
        checks: incomplete.checks,
      },
      message: "The payment details need correction before I can continue.",
    }, true);
  }

  const prepared = await context.client.preparePayment(parsed.input, parsed.agent);
  let assetCheck: PolicyCheck;
  try {
    const asset = await context.client.getSupportedAsset(parsed.input.mint);
    const expectedProgram = parsed.input.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
    const validAsset = Boolean(asset?.enabled && asset.tokenProgram === expectedProgram);
    assetCheck = {
      name: "asset_registry",
      ok: validAsset,
      message: validAsset
        ? "The token is enabled in the ChainPay asset registry."
        : "The token is not enabled for this token program in the ChainPay asset registry.",
    };
  } catch (error) {
    assetCheck = {
      name: "asset_registry",
      ok: false,
      message: `The token registry could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const preflight = {
    ...prepared.preflight,
    valid: prepared.preflight.valid && assetCheck.ok,
    checks: [...prepared.preflight.checks, assetCheck],
  };
  const checks = preflightChecks(preflight);
  const valid = preflight.valid;
  const requirements = requirementsFromPreflight(preflight);
  return toolResult({
    action: valid ? "requirements_ready" : "requirements_blocked",
    status: valid ? "ready" : "blocked",
    missing: valid ? [] : checks.filter((item) => item.status === "fail").map((item) => item.detail),
    checks,
    requirements,
    receiptAddress: prepared.receiptAddress,
    preflight,
    ...(verification ? { verification } : {}),
    request: {
      mandate: parsed.input.mandate,
      agent: parsed.agent,
      invoiceHash: bytesToHex(parsed.input.invoiceHash),
      paymentId: bytesToHex(parsed.input.paymentId),
      signatureReference: bytesToHex(parsed.input.signatureReference),
      mint: parsed.input.mint,
      recipient: parsed.input.recipient,
      amount: parsed.input.amount,
      tokenProgram: parsed.input.tokenProgram,
    },
    message: valid
      ? "Limits, token, recipient, expiry, and policy checks passed. The payment can proceed to routing."
      : "The payment is blocked until the failed policy checks are resolved.",
  }, !valid);
}
