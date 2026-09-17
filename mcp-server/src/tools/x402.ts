import { submitSettlement } from "./settlement-submit.js";
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  bytesToHex,
  type PaymentReceipt,
  type PreparedPayment,
} from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import {
  materializeUnsignedTransaction,
  serializeTransaction,
  hex32,
  solanaAddress,
  tokenProgram as parseTokenProgram,
  toolResult,
} from "./common.js";
import { requireObject } from "./payment-input.js";
import {
  CUSTOM_PROTOCOL,
  CUSTOM_PROTOCOL_LABEL,
  customReceiptProofDocument,
  parseMppWwwAuthenticate,
  parsePaymentRequiredDocument,
  parsePaymentRequiredFromResponse,
  unsupportedSponsorResult,
  type CustomChallengeOption,
  type StandardV2Option,
} from "./x402-protocol.js";
import {
  detectedChallengeToPrepareFields,
  standardV2RecipientTokenAccount,
} from "@chainpay/sdk";
import { requirementsFromPreflight } from "./check_payment_requirements.js";

const MAX_RESOURCE_BODY_BYTES = 1_048_576;
const RESOURCE_TIMEOUT_MS = 10_000;

type NormalizedX402Challenge = CustomChallengeOption & {
  tokenProgram: "spl-token" | "token-2022";
  nonce: string;
  invoiceHash: string;
  paymentId: string;
  signatureReference: string;
};

function resourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("resource is required");
  const url = new URL(value.trim());
  if (url.username || url.password) throw new Error("x402 resource URLs must not contain credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.CHAINPAY_X402_ALLOW_HTTP === "true")) {
    throw new Error("x402 resources must use HTTPS; set CHAINPAY_X402_ALLOW_HTTP=true only for a local demo merchant");
  }
  const allowed = (process.env.CHAINPAY_X402_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const localDemo = process.env.CHAINPAY_X402_ALLOW_HTTP === "true" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!localDemo && !allowed.includes(url.origin)) throw new Error("Merchant origin is not in CHAINPAY_X402_ALLOWED_ORIGINS");
  if (url.protocol === "http:" && !localDemo) throw new Error("HTTP is allowed only for the explicit local demo merchant");
  return url.toString();
}

async function fetchResource(url: string, paymentHeader?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        ...(paymentHeader ? { "X-PAYMENT": paymentHeader } : {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function limitedResponseBody(response: Response): Promise<{ text: string; parsed?: unknown }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESOURCE_BODY_BYTES) {
    throw new Error("x402 resource response is too large");
  }
  if (!response.body) return { text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESOURCE_BODY_BYTES) {
      await reader.cancel();
      throw new Error("x402 resource response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return { text, parsed: JSON.parse(text) };
  } catch {
    return { text };
  }
}

async function normalizedTokenProgram(
  context: ChainPayMcpContext,
  mint: string,
  requested: unknown,
): Promise<"spl-token" | "token-2022"> {
  const asset = await context.client.getSupportedAsset(mint);
  if (!asset || !asset.enabled) throw new Error("x402 asset is not enabled in the ChainPay SupportedAsset registry");
  const registered = asset.tokenProgram === SPL_TOKEN_PROGRAM_ID
    ? "spl-token"
    : asset.tokenProgram === TOKEN_2022_PROGRAM_ID
      ? "token-2022"
      : undefined;
  if (!registered) throw new Error(`x402 asset uses an unsupported token program: ${asset.tokenProgram}`);
  if (requested !== undefined && parseTokenProgram(requested) !== registered) {
    throw new Error(`x402 challenge token program does not match the on-chain SupportedAsset registry (${registered})`);
  }
  return registered;
}

async function normalizeCustomChallenge(
  context: ChainPayMcpContext,
  option: CustomChallengeOption,
  expectedResource?: string,
): Promise<NormalizedX402Challenge> {
  const resource = resourceUrl(option.resource);
  if (expectedResource && resource !== expectedResource) {
    throw new Error("x402 challenge resource does not match the requested resource URL");
  }
  const tokenProgram = await normalizedTokenProgram(context, option.mint, option.tokenProgram);
  const fields = await detectedChallengeToPrepareFields(
    { kind: "custom", option: { ...option, resource }, envelope: {} },
    tokenProgram,
  );
  return {
    ...option,
    resource,
    tokenProgram,
    nonce: fields.nonce,
    invoiceHash: fields.invoiceHash,
    paymentId: fields.paymentId,
    signatureReference: fields.signatureReference,
  };
}

async function normalizeV2Challenge(
  context: ChainPayMcpContext,
  option: StandardV2Option,
  expectedResource?: string,
): Promise<NormalizedX402Challenge> {
  const resource = resourceUrl(option.resource);
  if (expectedResource && resource !== expectedResource) {
    throw new Error("x402 challenge resource does not match the requested resource URL");
  }
  const tokenProgram = await normalizedTokenProgram(context, option.asset, undefined);
  const fields = await detectedChallengeToPrepareFields(
    { kind: "standard-v2", option: { ...option, resource }, envelope: {} },
    tokenProgram,
  );
  return {
    protocol: CUSTOM_PROTOCOL,
    protocolLabel: "Standard x402 v2 challenge settled through ChainPay mandate receipt proof",
    proofKind: "settled-receipt-pda",
    network: "solana-devnet",
    scheme: "exact",
    mint: fields.mint,
    recipient: fields.recipient,
    amount: fields.amount,
    resource,
    tokenProgram,
    nonce: fields.nonce,
    invoiceHash: fields.invoiceHash,
    paymentId: fields.paymentId,
    signatureReference: fields.signatureReference,
  };
}

/**
 * Settling a standard x402 v2 challenge is not the same permission as being allowed to
 * fetch a resource. `CHAINPAY_X402_ALLOWED_ORIGINS` says "ChainPay may read this merchant";
 * this says "this merchant verifies a ChainPay receipt PDA and will deliver against it".
 *
 * `resourceUrl` has already rejected every origin outside the read allowlist by the time
 * a settle gate runs, so checking the read allowlist again always returned true and the
 * effective gate was the caller's own `settleIfReceiptMerchant` argument. This list is
 * separate, is never satisfied by the local-HTTP demo escape hatch, and fails closed when
 * unset: no receipt merchants configured means no v2 settlement.
 */
function receiptMerchantAllowlisted(resource: string): boolean {
  const configured = (process.env.CHAINPAY_X402_RECEIPT_MERCHANTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length === 0) return false;
  let origin: string;
  try {
    origin = new URL(resource).origin;
  } catch {
    return false;
  }
  return configured.includes(origin);
}

async function quoteStandardV2AgainstMandate(
  context: ChainPayMcpContext,
  option: StandardV2Option,
  mandate: string,
  agent: string,
) {
  const tokenProgram = await normalizedTokenProgram(context, option.asset, undefined);
  const derivedRecipientTokenAccount = standardV2RecipientTokenAccount(option, tokenProgram);
  let mandateQuote: ReturnType<typeof unsupportedSponsorResult>["mandateQuote"];
  try {
    const fields = await detectedChallengeToPrepareFields(
      { kind: "standard-v2", option, envelope: {} },
      tokenProgram,
    );
    const prepared = await context.client.preparePayment({
      mandate,
      invoiceHash: hex32(fields.invoiceHash, "invoiceHash"),
      paymentId: hex32(fields.paymentId, "paymentId"),
      signatureReference: hex32(fields.signatureReference, "signatureReference"),
      mint: fields.mint,
      recipient: fields.recipient,
      amount: BigInt(fields.amount),
      tokenProgram,
    }, agent);
    mandateQuote = {
      status: prepared.preflight.valid ? "ready" : "blocked",
      preflightValid: prepared.preflight.valid,
      checks: requirementsFromPreflight(prepared.preflight).checks,
    };
  } catch (error) {
    mandateQuote = {
      status: "blocked",
      preflightValid: false,
      checks: [{
        key: "policy",
        label: "Policy",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  return unsupportedSponsorResult(option, {
    derivedRecipientTokenAccount,
    mandateQuote,
  });
}

function mppFromResponse(response: Response): ReturnType<typeof parseMppWwwAuthenticate> {
  return parseMppWwwAuthenticate(response.headers.get("www-authenticate"));
}

async function prepareChallenge(
  context: ChainPayMcpContext,
  challenge: NormalizedX402Challenge,
  mandate: string,
  agent: string,
): Promise<PreparedPayment> {
  if (challenge.expiresAtSlot !== undefined && BigInt(challenge.expiresAtSlot) <= await context.client.getCurrentSlot()) {
    throw new Error("x402 challenge has expired");
  }
  return context.client.preparePayment({
    mandate,
    invoiceHash: hex32(challenge.invoiceHash, "invoiceHash"),
    paymentId: hex32(challenge.paymentId, "paymentId"),
    signatureReference: hex32(challenge.signatureReference, "signatureReference"),
    mint: challenge.mint,
    recipient: challenge.recipient,
    amount: BigInt(challenge.amount),
    tokenProgram: challenge.tokenProgram,
  }, agent);
}

async function relaySignedPayment(
  context: ChainPayMcpContext,
  challenge: NormalizedX402Challenge,
  prepared: PreparedPayment,
  mandate: string,
  agent: string,
  signedTransaction: string,
): Promise<Record<string, unknown>> {
  if (!context.backendUrl) throw new Error("CHAINPAY_BACKEND_URL must be configured to relay a signed x402 transaction");
  const response = await submitSettlement(context, `${context.backendUrl.replace(/\/$/, "")}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(context.backendAuthToken ? { Authorization: `Bearer ${context.backendAuthToken}` } : {}),
    },
    body: JSON.stringify({
      idempotency_key: `x402:${mandate}:${challenge.invoiceHash}`,
      mandate,
      invoice_hash: challenge.invoiceHash,
      receipt_address: prepared.receiptAddress,
      signed_transaction: signedTransaction,
      agent,
      mint: challenge.mint,
      recipient: challenge.recipient,
      amount: challenge.amount,
      token_program: challenge.tokenProgram,
      x402: {
        resource: challenge.resource,
        challenge,
      },
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Axum rejected x402 settlement (${response.status}): ${JSON.stringify(payload)}`);

  return payload;
}

async function relayManagedPayment(
  context: ChainPayMcpContext,
  challenge: NormalizedX402Challenge,
  prepared: PreparedPayment,
  mandate: string,
  agent: string,
): Promise<Record<string, unknown>> {
  if (!context.backendUrl || !context.backendAuthToken) {
    throw new Error("Delegated x402 requires CHAINPAY_BACKEND_URL and a verified caller session or scoped connection");
  }
  const unsigned = await materializeUnsignedTransaction(context.client, prepared.transaction);
  const response = await submitSettlement(context, `${context.backendUrl.replace(/\/$/, "")}/v1/managed-payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.backendAuthToken}`,
    },
    body: JSON.stringify({
      idempotency_key: `x402:${mandate}:${challenge.invoiceHash}`,
      mandate,
      invoice_hash: challenge.invoiceHash,
      receipt_address: prepared.receiptAddress,
      unsigned_transaction: unsigned.value,
      agent,
      mint: challenge.mint,
      recipient: challenge.recipient,
      amount: challenge.amount,
      token_program: challenge.tokenProgram,
      x402: {
        resource: challenge.resource,
        challenge,
      },
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Axum rejected delegated x402 settlement (${response.status}): ${JSON.stringify(payload)}`);

  return payload;
}

async function persistX402Proof(
  context: ChainPayMcpContext,
  idempotencyKey: string,
  mandate: string,
  proof: Record<string, unknown>,
  responseStatus: number,
  error?: string,
): Promise<void> {
  if (!context.backendUrl) throw new Error("CHAINPAY_BACKEND_URL is required for x402 proof persistence");
  const response = await fetch(`${context.backendUrl.replace(/\/$/, "")}/v1/x402-payments/proof`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(context.backendAuthToken ? { Authorization: `Bearer ${context.backendAuthToken}` } : {}),
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      mandate,
      proof,
      response_status: responseStatus,
      ...(error ? { error } : {}),
    }),
  });
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Axum could not persist x402 proof (${response.status}): ${payload}`);
  }
}

function verifyReceipt(receipt: PaymentReceipt | null, challenge: NormalizedX402Challenge, prepared: Pick<PreparedPayment, "receiptAddress">, mandate: string, agent: string): PaymentReceipt {
  if (!receipt) throw new Error("confirmed x402 settlement has no on-chain receipt PDA");
  if (receipt.status !== "confirmed") throw new Error("x402 receipt is not settled");
  if (receipt.address !== prepared.receiptAddress) throw new Error("x402 receipt address mismatch");
  if (receipt.mandate !== mandate) throw new Error("x402 receipt mandate mismatch");
  if (bytesToHex(receipt.invoiceHash) !== challenge.invoiceHash) throw new Error("x402 receipt invoice hash mismatch");
  if (receipt.mint !== challenge.mint) throw new Error("x402 receipt mint mismatch");
  if (receipt.recipient !== challenge.recipient) throw new Error("x402 receipt recipient mismatch");
  if (receipt.amount !== BigInt(challenge.amount)) throw new Error("x402 receipt amount mismatch");
  if (receipt.agent !== agent) throw new Error("x402 receipt agent mismatch");
  return receipt;
}

function proofHeader(signature: string, receiptAddress: string): string {
  return JSON.stringify(customReceiptProofDocument(signature, receiptAddress));
}

export async function prepareX402Payment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const mandate = solanaAddress(args.mandate, "mandate");
  const agent = solanaAddress(args.agent, "agent");
  const settleIfReceiptMerchant = args.settleIfReceiptMerchant === true;
  const detected = parsePaymentRequiredDocument(requireObject(args.challenge));
  if (detected.kind === "standard-v2") {
    if (settleIfReceiptMerchant && receiptMerchantAllowlisted(detected.option.resource)) {
      const challenge = await normalizeV2Challenge(context, detected.option);
      const prepared = await prepareChallenge(context, challenge, mandate, agent);
      if (!prepared.preflight.valid) {
        return toolResult({ action: "x402_rejected_by_preflight", challenge, receiptAddress: prepared.receiptAddress, preflight: prepared.preflight }, true);
      }
      return toolResult({
        action: "x402_agent_signature_required",
        challenge,
        receiptAddress: prepared.receiptAddress,
        preflight: prepared.preflight,
        capabilityProfile: prepared.capabilityProfile,
        transaction: serializeTransaction(prepared.transaction),
        unsignedTransaction: await materializeUnsignedTransaction(context.client, prepared.transaction),
        message: "Standard x402 v2 challenge on an allowlisted receipt merchant. Sign outside ChainPay, then call execute_x402_payment with signedTransaction.",
      });
    }
    return toolResult(await quoteStandardV2AgainstMandate(context, detected.option, mandate, agent), true);
  }
  const challenge = await normalizeCustomChallenge(context, detected.option);
  const prepared = await prepareChallenge(context, challenge, mandate, agent);
  if (!prepared.preflight.valid) {
    return toolResult({ action: "x402_rejected_by_preflight", challenge, receiptAddress: prepared.receiptAddress, preflight: prepared.preflight }, true);
  }
  return toolResult({
    action: "x402_agent_signature_required",
    challenge,
    receiptAddress: prepared.receiptAddress,
    preflight: prepared.preflight,
    capabilityProfile: prepared.capabilityProfile,
    transaction: serializeTransaction(prepared.transaction),
    unsignedTransaction: await materializeUnsignedTransaction(context.client, prepared.transaction),
    message: "Custom ChainPay x402/1.0 receipt-proof challenge is ready. Sign outside ChainPay, then call execute_x402_payment with resource, mandate, agent, and signedTransaction.",
  });
}

export async function executeX402Payment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  if (typeof args.paymentId === "string") return resumeX402Payment(context, args.paymentId);
  const resource = resourceUrl(args.resource);
  const mandate = solanaAddress(args.mandate, "mandate");
  const agent = solanaAddress(args.agent, "agent");
  const signingMode = args.signingMode;
  if (signingMode !== "human" && signingMode !== "delegated") {
    throw new Error("signingMode must be human or delegated");
  }
  const settleIfReceiptMerchant = args.settleIfReceiptMerchant === true;
  const initial = await fetchResource(resource);
  const initialBody = await limitedResponseBody(initial);
  if (initial.status !== 402) {
    return toolResult({
      action: initial.ok ? "x402_resource_available" : "x402_resource_rejected",
      resource,
      httpStatus: initial.status,
      resourceResponse: initialBody.parsed ?? initialBody.text,
      message: initial.ok ? "The resource did not require payment." : "The resource did not return an x402 challenge.",
    }, !initial.ok);
  }

  const mpp = mppFromResponse(initial);
  if (mpp) {
    return toolResult(mpp, true);
  }

  const detected = parsePaymentRequiredFromResponse(initial.headers, initialBody, resource);
  if (detected.kind === "standard-v2") {
    resourceUrl(detected.option.resource);
    if (settleIfReceiptMerchant && receiptMerchantAllowlisted(resource)) {
      const challenge = await normalizeV2Challenge(context, detected.option, resource);
      const prepared = await prepareChallenge(context, challenge, mandate, agent);
      if (!prepared.preflight.valid) {
        return toolResult({ action: "x402_rejected_by_preflight", challenge, receiptAddress: prepared.receiptAddress, preflight: prepared.preflight }, true);
      }
      const signedTransaction = typeof args.signedTransaction === "string" ? args.signedTransaction.trim() : "";
      if (signingMode === "human" && !signedTransaction) {
        return toolResult({
          action: "x402_agent_signature_required",
          challenge,
          receiptAddress: prepared.receiptAddress,
          preflight: prepared.preflight,
          capabilityProfile: prepared.capabilityProfile,
          transaction: serializeTransaction(prepared.transaction),
          unsignedTransaction: await materializeUnsignedTransaction(context.client, prepared.transaction),
          message: "Allowlisted receipt merchant returned standard x402 v2. Sign this mandate payment, then call execute_x402_payment again with signedTransaction.",
        });
      }
      if (signingMode === "delegated" && signedTransaction) {
        return toolResult({
          action: "delegated_signature_rejected",
          message: "Delegated x402 accepts only the unsigned transaction prepared by ChainPay; Axum obtains and validates the provider signature.",
          challenge,
          receiptAddress: prepared.receiptAddress,
        }, true);
      }
      const settlement = signingMode === "delegated"
        ? await relayManagedPayment(context, challenge, prepared, mandate, agent)
        : await relaySignedPayment(context, challenge, prepared, mandate, agent, signedTransaction);
      if (settlement.status !== "confirmed" || typeof settlement.signature !== "string") {
        return toolResult({ action: settlement.status === "failed" ? "x402_payment_failed" : "x402_payment_pending", status: settlement.status, resource, challenge, settlement, receiptAddress: prepared.receiptAddress,
          continuation: { tool: "execute_x402_payment", arguments: { paymentId: settlement.payment_id } }, message: "Resume execute_x402_payment with paymentId to check settlement and deliver the original resource; do not request another approval." }, settlement.status === "failed");
      }
      return deliverX402(context, resource, challenge, prepared.receiptAddress, mandate, agent, settlement, `x402:${mandate}:${challenge.invoiceHash}`);
    }
    return toolResult(await quoteStandardV2AgainstMandate(context, detected.option, mandate, agent), true);
  }
  const challenge = await normalizeCustomChallenge(context, detected.option, resource);
  const prepared = await prepareChallenge(context, challenge, mandate, agent);
  if (!prepared.preflight.valid) {
    return toolResult({ action: "x402_rejected_by_preflight", challenge, receiptAddress: prepared.receiptAddress, preflight: prepared.preflight }, true);
  }

  const signedTransaction = typeof args.signedTransaction === "string" ? args.signedTransaction.trim() : "";
  if (signingMode === "human" && !signedTransaction) {
    return toolResult({
      action: "x402_agent_signature_required",
      challenge,
      receiptAddress: prepared.receiptAddress,
      preflight: prepared.preflight,
      capabilityProfile: prepared.capabilityProfile,
      transaction: serializeTransaction(prepared.transaction),
      unsignedTransaction: await materializeUnsignedTransaction(context.client, prepared.transaction),
      message: "The live resource returned a custom ChainPay x402/1.0 receipt-proof challenge. Sign this transaction outside ChainPay and call execute_x402_payment again with signedTransaction.",
    });
  }
  if (signingMode === "delegated" && signedTransaction) {
    return toolResult({
      action: "delegated_signature_rejected",
      message: "Delegated x402 accepts only the unsigned transaction prepared by ChainPay; Axum obtains and validates the provider signature.",
      challenge,
      receiptAddress: prepared.receiptAddress,
    }, true);
  }

  const settlement = signingMode === "delegated"
    ? await relayManagedPayment(context, challenge, prepared, mandate, agent)
    : await relaySignedPayment(context, challenge, prepared, mandate, agent, signedTransaction);
  if (settlement.status !== "confirmed" || typeof settlement.signature !== "string") {
    return toolResult({ action: settlement.status === "failed" ? "x402_payment_failed" : "x402_payment_pending", status: settlement.status, resource, challenge, settlement, receiptAddress: prepared.receiptAddress,
      continuation: { tool: "execute_x402_payment", arguments: { paymentId: settlement.payment_id } }, message: "Resume execute_x402_payment with paymentId to check settlement and deliver the original resource; do not request another approval." }, settlement.status === "failed");
  }
  return deliverX402(context, resource, challenge, prepared.receiptAddress, mandate, agent, settlement, `x402:${mandate}:${challenge.invoiceHash}`);
}

async function deliverX402(context: ChainPayMcpContext, resource: string, challenge: NormalizedX402Challenge, receiptAddress: string, mandate: string, agent: string, settlement: Record<string, unknown>, idempotencyKey: string) {
  const labeled = labelStoredChallenge(challenge);
  const receipt = verifyReceipt(await context.client.getPayment(receiptAddress), labeled, { receiptAddress }, mandate, agent);
  const signature = settlement.signature as string;
  const proof = proofHeader(signature, receiptAddress);
  const proofObject = JSON.parse(proof) as Record<string, unknown>;
  const retried = await fetchResource(resource, proof);
  const resourceBody = await limitedResponseBody(retried);
  await persistX402Proof(
    context,
    idempotencyKey,
    mandate,
    proofObject,
    retried.status,
    retried.ok ? undefined : "resource rejected the confirmed ChainPay proof",
  );
  if (!retried.ok) {
    return toolResult({
      action: "x402_settled_resource_rejected",
      status: "confirmed",
      resource,
      challenge: labeled,
      settlement,
      receipt,
      proof: proofObject,
      proofKind: labeled.proofKind,
      httpStatus: retried.status,
      resourceResponse: resourceBody.parsed ?? resourceBody.text,
      message: "The custom ChainPay x402/1.0 payment is confirmed on-chain, but the resource rejected the receipt-proof retry. Resume execute_x402_payment with paymentId; do not settle again.",
    }, true);
  }
  return toolResult({
    action: "x402_verified",
    status: "confirmed",
    signingMode: settlement.signing_mode,
    resource,
    challenge: labeled,
    settlement,
    receipt,
    proof: proofObject,
    proofKind: labeled.proofKind,
    httpStatus: retried.status,
    resourceResponse: resourceBody.parsed ?? resourceBody.text,
  });
}

async function resumeX402Payment(context: ChainPayMcpContext, paymentId: string) {
  if (!/^payment_[a-f0-9]{64}$/.test(paymentId) || !context.backendUrl) throw new Error("A valid existing paymentId and backend are required");
  const response=await fetch(`${context.backendUrl.replace(/\/$/, "")}/v1/payments/${paymentId}/x402`, {headers:context.backendAuthToken?{Authorization:`Bearer ${context.backendAuthToken}`}:{},signal:AbortSignal.timeout(20_000)});
  if (!response.ok) throw new Error(`Existing x402 operation unavailable (${response.status})`);
  const saved=await response.json() as {payment:Record<string,unknown>;resource:string;challenge:NormalizedX402Challenge;idempotency_key:string};
  const payment=saved.payment;
  if (payment.status!=="confirmed") return toolResult({action:payment.status==="failed"?"x402_payment_failed":"x402_payment_pending",status:payment.status,settlement:payment,continuation:{tool:"execute_x402_payment",arguments:{paymentId}},message:"Resume this paymentId; no new preparation or approval is needed."},payment.status==="failed");
  if (saved.challenge.resource!==saved.resource || typeof payment.signature!=="string" || typeof payment.receipt_address!=="string" || typeof payment.mandate!=="string" || typeof payment.agent!=="string") throw new Error("Stored x402 settlement context is incomplete");
  return deliverX402(context,resourceUrl(saved.resource),labelStoredChallenge(saved.challenge),payment.receipt_address,payment.mandate,payment.agent,payment,saved.idempotency_key);
}

function labelStoredChallenge(challenge: NormalizedX402Challenge): NormalizedX402Challenge {
  return {
    ...challenge,
    protocol: challenge.protocol ?? CUSTOM_PROTOCOL,
    protocolLabel: challenge.protocolLabel ?? CUSTOM_PROTOCOL_LABEL,
    proofKind: challenge.proofKind ?? "settled-receipt-pda",
    network: challenge.network ?? "solana-devnet",
    scheme: challenge.scheme ?? "exact",
  };
}
