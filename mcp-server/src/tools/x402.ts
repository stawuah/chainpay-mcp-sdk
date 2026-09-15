import { submitSettlement } from "./settlement-submit.js";
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  bytesToHex,
  deriveX402PaymentReferences,
  type PaymentReceipt,
  type PreparedPayment,
} from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import {
  materializeUnsignedTransaction,
  serializeTransaction,
  solanaAddress,
  tokenProgram as parseTokenProgram,
  toolResult,
  unsignedInteger,
} from "./common.js";
import { requireObject } from "./payment-input.js";

const MAX_RESOURCE_BODY_BYTES = 1_048_576;
const RESOURCE_TIMEOUT_MS = 10_000;

type X402Challenge = {
  network?: unknown;
  scheme?: unknown;
  asset?: unknown;
  mint?: unknown;
  payTo?: unknown;
  recipient?: unknown;
  amount?: unknown;
  maxAmountRequired?: unknown;
  resource?: unknown;
  nonce?: unknown;
  expiresAtSlot?: unknown;
  tokenProgram?: unknown;
};

type NormalizedX402Challenge = {
  network: "solana-devnet";
  scheme: "exact";
  mint: string;
  recipient: string;
  amount: string;
  tokenProgram: "spl-token" | "token-2022";
  resource: string;
  nonce: string;
  invoiceHash: string;
  paymentId: string;
  signatureReference: string;
  expiresAtSlot?: string;
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

function parseHeaderJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    } catch {
      throw new Error("x402 payment-required header is neither JSON nor base64 JSON");
    }
  }
}

function challengeOptions(value: unknown): X402Challenge[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.accepts)) {
    return object.accepts.filter((item): item is X402Challenge => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  if (object.paymentRequired) return challengeOptions(object.paymentRequired);
  return [object as X402Challenge];
}

function selectChallenge(value: unknown): X402Challenge {
  const options = challengeOptions(value);
  const selected = options.find((option) => {
    const network = typeof option.network === "string" ? option.network : "solana-devnet";
    const scheme = typeof option.scheme === "string" ? option.scheme : "exact";
    return (network === "devnet" || network === "solana-devnet") && scheme === "exact";
  });
  if (!selected) throw new Error("x402 response has no Solana Devnet exact payment option");
  return selected;
}

async function challengeFromResponse(response: Response, body: { text: string; parsed?: unknown }): Promise<X402Challenge> {
  const header = response.headers.get("x-payment-required") ?? response.headers.get("payment-required");
  const source = header ? parseHeaderJson(header) : body.parsed;
  if (!source) throw new Error("HTTP 402 response did not include payment requirements");
  return selectChallenge(source);
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

async function normalizeChallenge(
  context: ChainPayMcpContext,
  challenge: X402Challenge,
  expectedResource?: string,
): Promise<NormalizedX402Challenge> {
  const network = typeof challenge.network === "string" ? challenge.network : "solana-devnet";
  if (network !== "devnet" && network !== "solana-devnet") {
    throw new Error("Only Solana Devnet x402 challenges are enabled");
  }
  const scheme = typeof challenge.scheme === "string" ? challenge.scheme : "exact";
  if (scheme !== "exact") throw new Error("Only the x402 exact scheme is enabled");
  const mint = solanaAddress(challenge.asset ?? challenge.mint, "asset");
  const recipient = solanaAddress(challenge.payTo ?? challenge.recipient, "payTo");
  const amountValue = challenge.amount ?? challenge.maxAmountRequired;
  const amount = typeof amountValue === "number" ? String(amountValue) : amountValue;
  if (typeof amount !== "string" || amount.trim() === "") throw new Error("x402 challenge amount is required");
  unsignedInteger(amount, "amount");
  const resource = resourceUrl(challenge.resource ?? expectedResource);
  if (expectedResource && resource !== expectedResource) {
    throw new Error("x402 challenge resource does not match the requested resource URL");
  }
  const tokenProgram = await normalizedTokenProgram(context, mint, challenge.tokenProgram);
  const expiresAtSlot = challenge.expiresAtSlot === undefined
    ? undefined
    : unsignedInteger(challenge.expiresAtSlot, "expiresAtSlot").toString();
  const references = await deriveX402PaymentReferences({
    mint,
    recipient,
    amount,
    resource,
    tokenProgram,
    ...(typeof challenge.nonce === "string" && challenge.nonce.trim() ? { nonce: challenge.nonce.trim() } : {}),
    ...(expiresAtSlot ? { expiresAtSlot } : {}),
  });
  return {
    network: "solana-devnet",
    scheme: "exact",
    mint,
    recipient,
    amount,
    tokenProgram,
    resource,
    ...references,
    ...(expiresAtSlot ? { expiresAtSlot } : {}),
  };
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
    invoiceHash: hexBytes(challenge.invoiceHash),
    paymentId: hexBytes(challenge.paymentId),
    signatureReference: hexBytes(challenge.signatureReference),
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
  return JSON.stringify({
    version: "x402/1.0",
    scheme: "exact",
    network: "solana-devnet",
    payload: { signature, receiptPDA: receiptAddress },
  });
}

export async function prepareX402Payment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const mandate = solanaAddress(args.mandate, "mandate");
  const agent = solanaAddress(args.agent, "agent");
  const challenge = await normalizeChallenge(context, selectChallenge(requireObject(args.challenge)));
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
    message: "Sign outside ChainPay, then call execute_x402_payment with resource, mandate, agent, and signedTransaction.",
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

  const challenge = await normalizeChallenge(context, await challengeFromResponse(initial, initialBody), resource);
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
      message: "The live resource returned HTTP 402. Sign this transaction outside ChainPay and call execute_x402_payment again with signedTransaction.",
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
  const receipt = verifyReceipt(await context.client.getPayment(receiptAddress), challenge, { receiptAddress }, mandate, agent);
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
      challenge,
      settlement,
      receipt,
      proof: proofObject,
      httpStatus: retried.status,
      resourceResponse: resourceBody.parsed ?? resourceBody.text,
      message: "The payment is confirmed on-chain, but the resource rejected the proof retry.",
    }, true);
  }
  return toolResult({
    action: "x402_verified",
    status: "confirmed",
    signingMode: settlement.signing_mode,
    resource,
    challenge,
    settlement,
    receipt,
    proof: proofObject,
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
  return deliverX402(context,resourceUrl(saved.resource),saved.challenge,payment.receipt_address,payment.mandate,payment.agent,payment,saved.idempotency_key);
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
