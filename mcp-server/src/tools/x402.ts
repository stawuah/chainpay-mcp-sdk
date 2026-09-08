import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveAssociatedTokenAddress,
  type TokenProgram,
} from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, toolResult, unsignedInteger } from "./common.js";

const CORBITS_FACILITATOR_URL = "https://facilitator.corbits.dev";
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MAX_RESOURCE_BODY_BYTES = 1_048_576;
const RESOURCE_TIMEOUT_MS = 10_000;
const X402_HTTP = new x402HTTPClient(new x402Client());

type JsonObject = Record<string, unknown>;

type PaymentRequirement = {
  scheme: "exact";
  network: typeof SOLANA_DEVNET_CAIP2;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: JsonObject;
};

type StandardPaymentRequired = {
  x402Version: 2;
  resource: JsonObject & { url: string };
  accepts: PaymentRequirement[];
  extensions: JsonObject;
};

type ExpectedPayment = {
  requirement: PaymentRequirement;
  payer: string;
  sourceTokenAccount: string;
  merchantTokenAccount: string;
  feePayer: string;
  tokenProgram: TokenProgram;
  decimals: number;
};

function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function resourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("resource is required");
  const url = new URL(value.trim());
  if (url.username || url.password) throw new Error("x402 resource URLs must not contain credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.CHAINPAY_X402_ALLOW_HTTP === "true")) {
    throw new Error("x402 resources must use HTTPS; enable CHAINPAY_X402_ALLOW_HTTP=true only for a local merchant");
  }
  return url.toString();
}

function normalizedFacilitator(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("CHAINPAY_X402_FACILITATOR_URL must be a credential-free HTTPS origin");
  }
  return url.toString().replace(/\/$/, "");
}

function configuredFacilitator(advertised: string | null): string {
  const configured = normalizedFacilitator(process.env.CHAINPAY_X402_FACILITATOR_URL ?? CORBITS_FACILITATOR_URL);
  if (!advertised) return configured;
  if (normalizedFacilitator(advertised) !== configured) {
    throw new Error("merchant advertised an untrusted x402 facilitator; ChainPay is configured only for Corbits");
  }
  return configured;
}

async function fetchResource(url: string, paymentHeaders?: HeadersInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        ...paymentHeaders,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function limitedResponseBody(response: Response): Promise<{ text: string; parsed?: unknown }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESOURCE_BODY_BYTES) throw new Error("x402 resource response is too large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESOURCE_BODY_BYTES) throw new Error("x402 resource response is too large");
  try {
    return { text, parsed: JSON.parse(text) };
  } catch {
    return { text };
  }
}

function standardPaymentRequired(value: unknown, expectedResource: string): StandardPaymentRequired {
  const payment = requireObject(value, "x402 payment requirements");
  if (payment.x402Version !== 2) throw new Error("only x402 version 2 is supported");
  const resource = requireObject(payment.resource, "x402 resource");
  if (resourceUrl(resource.url) !== expectedResource) throw new Error("x402 resource does not match the requested URL");
  if (!Array.isArray(payment.accepts)) throw new Error("x402 payment requirements have no accepts array");

  const accepts = payment.accepts.map((candidate) => {
    const item = requireObject(candidate, "x402 payment option");
    if (item.scheme !== "exact" || item.network !== SOLANA_DEVNET_CAIP2) return undefined;
    const asset = solanaAddress(item.asset, "x402 asset");
    const payTo = solanaAddress(item.payTo, "x402 payTo");
    const amount = unsignedInteger(item.amount, "x402 amount").toString();
    if (BigInt(amount) === 0n) throw new Error("x402 amount must be greater than zero");
    if (!Number.isSafeInteger(item.maxTimeoutSeconds) || (item.maxTimeoutSeconds as number) <= 0) {
      throw new Error("x402 maxTimeoutSeconds must be a positive integer");
    }
    return {
      scheme: "exact" as const,
      network: SOLANA_DEVNET_CAIP2,
      asset,
      amount,
      payTo,
      maxTimeoutSeconds: item.maxTimeoutSeconds as number,
      extra: item.extra === undefined ? {} : requireObject(item.extra, "x402 payment option extra"),
    };
  }).filter((candidate): candidate is PaymentRequirement => Boolean(candidate));

  if (accepts.length === 0) throw new Error("x402 response has no Corbits-compatible Solana Devnet exact option");
  return {
    x402Version: 2,
    resource: resource as JsonObject & { url: string },
    accepts,
    extensions: payment.extensions === undefined ? {} : requireObject(payment.extensions, "x402 extensions"),
  };
}

function paymentRequiredFromResponse(response: Response, body: { parsed?: unknown }, resource: string): StandardPaymentRequired {
  try {
    const parsed = X402_HTTP.getPaymentRequiredResponse(
      (name) => response.headers.get(name),
      body.parsed,
    );
    return standardPaymentRequired(parsed, resource);
  } catch (error) {
    throw new Error(`could not parse standard x402 PAYMENT-REQUIRED response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function corbitsFeePayer(facilitator: string): Promise<string> {
  const response = await fetch(`${facilitator}/supported`, { method: "GET", redirect: "error" });
  if (!response.ok) throw new Error(`Corbits /supported returned HTTP ${response.status}`);
  const payload = requireObject(await response.json(), "Corbits /supported response");
  if (!Array.isArray(payload.kinds)) throw new Error("Corbits /supported response has no kinds array");
  const kind = payload.kinds
    .map((candidate) => requireObject(candidate, "Corbits supported kind"))
    .find((candidate) => candidate.x402Version === 2 && candidate.scheme === "exact" && candidate.network === SOLANA_DEVNET_CAIP2);
  if (!kind) throw new Error("Corbits does not currently advertise x402 v2 exact support for Solana Devnet");
  return solanaAddress(requireObject(kind.extra, "Corbits supported kind extra").feePayer, "Corbits fee payer");
}

async function expectedPayment(
  context: ChainPayMcpContext,
  paymentRequired: StandardPaymentRequired,
  payer: string,
  facilitator: string,
): Promise<ExpectedPayment> {
  const requirement = paymentRequired.accepts[0];
  const asset = await context.client.getSupportedAsset(requirement.asset);
  if (!asset?.enabled) throw new Error("x402 asset is not enabled in ChainPay's on-chain asset registry");
  const tokenProgram = asset.tokenProgram === SPL_TOKEN_PROGRAM_ID
    ? "spl-token"
    : asset.tokenProgram === TOKEN_2022_PROGRAM_ID
      ? "token-2022"
      : undefined;
  if (!tokenProgram) throw new Error(`x402 asset uses unsupported token program ${asset.tokenProgram}`);
  if (await context.client.getTokenProgram(requirement.asset) !== tokenProgram) {
    throw new Error("x402 asset registry token program does not match the live mint account");
  }
  const sourceTokenAccount = deriveAssociatedTokenAddress(payer, requirement.asset, tokenProgram);
  const merchantTokenAccount = deriveAssociatedTokenAddress(requirement.payTo, requirement.asset, tokenProgram);
  const [source, merchant, feePayer] = await Promise.all([
    context.client.connection.getAccountInfo(new PublicKey(sourceTokenAccount), "confirmed"),
    context.client.connection.getAccountInfo(new PublicKey(merchantTokenAccount), "confirmed"),
    corbitsFeePayer(facilitator),
  ]);
  assertTokenAccount(source, sourceTokenAccount, payer, requirement.asset, tokenProgram);
  assertTokenAccount(merchant, merchantTokenAccount, requirement.payTo, requirement.asset, tokenProgram);
  return {
    requirement,
    payer,
    sourceTokenAccount,
    merchantTokenAccount,
    feePayer,
    tokenProgram,
    decimals: await context.client.getMintDecimals(requirement.asset),
  };
}

function assertTokenAccount(
  account: AccountInfo<Buffer> | null,
  accountAddress: string,
  expectedOwner: string,
  mint: string,
  tokenProgram: TokenProgram,
): void {
  if (!account) throw new Error(`required associated token account does not exist: ${accountAddress}`);
  const expectedProgram = tokenProgram === "spl-token" ? SPL_TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  if (account.owner.toBase58() !== expectedProgram) throw new Error(`token account ${accountAddress} has the wrong token program`);
  if (account.data.length < 64) throw new Error(`token account ${accountAddress} is truncated`);
  if (!new PublicKey(account.data.subarray(0, 32)).equals(new PublicKey(mint))) {
    throw new Error(`token account ${accountAddress} has the wrong mint`);
  }
  if (!new PublicKey(account.data.subarray(32, 64)).equals(new PublicKey(expectedOwner))) {
    throw new Error(`token account ${accountAddress} has the wrong owner`);
  }
}

function transferCheckedInstruction(expected: ExpectedPayment): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12; // SPL Token TransferChecked
  data.writeBigUInt64LE(BigInt(expected.requirement.amount), 1);
  data[9] = expected.decimals;
  return new TransactionInstruction({
    programId: new PublicKey(expected.tokenProgram === "spl-token" ? SPL_TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(expected.sourceTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(expected.requirement.asset), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(expected.merchantTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(expected.payer), isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildUnsignedTransaction(expected: ExpectedPayment, blockhash: string): Transaction {
  return new Transaction({ feePayer: new PublicKey(expected.feePayer), recentBlockhash: blockhash })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }))
    .add(transferCheckedInstruction(expected));
}

function encodeUnsigned(transaction: Transaction): string {
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

function signedTransaction(value: unknown, expected: ExpectedPayment): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("signedTransaction is required after wallet signing");
  let transaction: Transaction;
  try {
    transaction = Transaction.from(Buffer.from(value.trim(), "base64"));
  } catch {
    throw new Error("signedTransaction must be a valid base64 Solana legacy transaction");
  }
  if (!transaction.feePayer?.equals(new PublicKey(expected.feePayer))) throw new Error("signed x402 transaction has an unexpected fee payer");
  const allowedPrograms = new Set([
    ComputeBudgetProgram.programId.toBase58(),
    expected.tokenProgram === "spl-token" ? SPL_TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
  ]);
  if (transaction.instructions.some((instruction) => !allowedPrograms.has(instruction.programId.toBase58()))) {
    throw new Error("signed x402 transaction contains an unapproved instruction");
  }
  const transfers = transaction.instructions.filter((instruction) => instruction.programId.toBase58() === (expected.tokenProgram === "spl-token" ? SPL_TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID));
  if (transfers.length !== 1) throw new Error("signed x402 transaction must contain exactly one token transfer");
  const transfer = transfers[0];
  if (transfer.data.length !== 10 || transfer.data[0] !== 12 || transfer.data.readBigUInt64LE(1) !== BigInt(expected.requirement.amount) || transfer.data[9] !== expected.decimals) {
    throw new Error("signed x402 transaction transfer does not match the payment requirement");
  }
  const expectedAccounts = [expected.sourceTokenAccount, expected.requirement.asset, expected.merchantTokenAccount, expected.payer];
  if (transfer.keys.length !== expectedAccounts.length || transfer.keys.some((key, index) => key.pubkey.toBase58() !== expectedAccounts[index])) {
    throw new Error("signed x402 transaction transfer accounts do not match the payment requirement");
  }
  const payerSignature = transaction.signatures.find((signature) => signature.publicKey.equals(new PublicKey(expected.payer)))?.signature;
  if (!payerSignature || !transaction.verifySignatures(false)) throw new Error("signed x402 transaction has no valid payer signature");
  return value.trim();
}

async function persistExternalSettlement(
  context: ChainPayMcpContext,
  input: JsonObject,
): Promise<void> {
  if (!context.backendUrl || !context.backendAuthToken) {
    throw new Error("CHAINPAY_BACKEND_URL and CHAINPAY_BACKEND_AUTH_TOKEN are required to record x402 settlement");
  }
  const response = await fetch(`${context.backendUrl.replace(/\/$/, "")}/v1/x402-payments/external-settlement`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${context.backendAuthToken}` },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Axum could not persist standard x402 settlement (${response.status}): ${await response.text()}`);
}

function paymentHeaders(payment: JsonObject): HeadersInit {
  return X402_HTTP.encodePaymentSignatureHeader(payment as never) as HeadersInit;
}

export async function prepareX402Payment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const resource = resourceUrl(args.resource);
  const payer = solanaAddress(args.payer, "payer");
  if (args.signingMode !== undefined && args.signingMode !== "human") {
    throw new Error("standard Corbits x402 currently supports human wallet signing only; delegated x402 is a separate implementation");
  }
  const paymentRequired = standardPaymentRequired(args.paymentRequired, resource);
  const facilitator = configuredFacilitator(null);
  const expected = await expectedPayment(context, paymentRequired, payer, facilitator);
  const latest = await context.client.connection.getLatestBlockhash("confirmed");
  const transaction = buildUnsignedTransaction(expected, latest.blockhash);
  return toolResult({
    action: "x402_wallet_signature_required",
    protocol: "x402/2",
    facilitator,
    resource,
    paymentRequired,
    payer,
    sourceTokenAccount: expected.sourceTokenAccount,
    merchantTokenAccount: expected.merchantTokenAccount,
    feePayer: expected.feePayer,
    decimals: expected.decimals,
    transaction: encodeUnsigned(transaction),
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    message: "Review and sign this standard direct SPL transfer in the wallet, then call execute_x402_payment with the same paymentRequired and signedTransaction.",
  });
}

export async function executeX402Payment(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const resource = resourceUrl(args.resource);
  const payer = solanaAddress(args.payer, "payer");
  if (args.signingMode !== undefined && args.signingMode !== "human") {
    throw new Error("standard Corbits x402 currently supports human wallet signing only; it does not use a ChainPay mandate");
  }
  if (!context.backendUrl || !context.backendAuthToken) {
    throw new Error("CHAINPAY_BACKEND_URL and CHAINPAY_BACKEND_AUTH_TOKEN are required before starting an auditable x402 payment");
  }

  let facilitator: string;
  let paymentRequired: StandardPaymentRequired;
  if (args.paymentRequired === undefined) {
    if (typeof args.signedTransaction === "string" && args.signedTransaction.trim() !== "") {
      throw new Error("paymentRequired from the first x402 call is required when submitting a signed transaction");
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
    facilitator = configuredFacilitator(initial.headers.get("x-payment-facilitator"));
    paymentRequired = paymentRequiredFromResponse(initial, initialBody, resource);
  } else {
    // The signed transaction must be retried against exactly the quote the
    // wallet reviewed. Do not fetch a fresh 402 that could change its amount,
    // recipient, or expiry between the two MCP calls.
    facilitator = configuredFacilitator(null);
    paymentRequired = standardPaymentRequired(args.paymentRequired, resource);
  }
  const expected = await expectedPayment(context, paymentRequired, payer, facilitator);

  if (typeof args.signedTransaction !== "string" || args.signedTransaction.trim() === "") {
    const latest = await context.client.connection.getLatestBlockhash("confirmed");
    return toolResult({
      action: "x402_wallet_signature_required",
      protocol: "x402/2",
      facilitator,
      resource,
      paymentRequired,
      payer,
      sourceTokenAccount: expected.sourceTokenAccount,
      merchantTokenAccount: expected.merchantTokenAccount,
      feePayer: expected.feePayer,
      decimals: expected.decimals,
      transaction: encodeUnsigned(buildUnsignedTransaction(expected, latest.blockhash)),
      recentBlockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      message: "The merchant returned x402. Review and sign the direct token transfer, then resend this same paymentRequired and signedTransaction.",
    });
  }

  const signaturePayload = signedTransaction(args.signedTransaction, expected);
  const payment = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: expected.requirement,
    payload: { transaction: signaturePayload },
    extensions: paymentRequired.extensions,
  };
  const paid = await fetchResource(resource, paymentHeaders(payment));
  const paidBody = await limitedResponseBody(paid);
  let settlement: JsonObject | undefined;
  try {
    settlement = requireObject(X402_HTTP.getPaymentSettleResponse((name) => paid.headers.get(name)), "x402 PAYMENT-RESPONSE");
  } catch (error) {
    throw new Error(`merchant did not return a valid x402 PAYMENT-RESPONSE: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (settlement.success !== true || typeof settlement.transaction !== "string") {
    throw new Error(`facilitator did not confirm settlement: ${JSON.stringify(settlement)}`);
  }
  const idempotencyKey = `x402-external:${createHash("sha256").update(JSON.stringify(payment)).digest("hex")}`;
  await persistExternalSettlement(context, {
    idempotency_key: idempotencyKey,
    resource,
    facilitator,
    challenge: paymentRequired,
    payment_payload: payment,
    settlement,
    transaction_signature: settlement.transaction,
    response_status: paid.status,
    ...(paid.ok ? {} : { error: "merchant rejected the resource after facilitator settlement" }),
  });
  return toolResult({
    action: paid.ok ? "x402_facilitator_verified" : "x402_settled_resource_rejected",
    protocol: "x402/2",
    status: settlement.success ? "confirmed" : "failed",
    resource,
    facilitator,
    paymentRequired,
    settlement,
    httpStatus: paid.status,
    resourceResponse: paidBody.parsed ?? paidBody.text,
    message: paid.ok
      ? "Corbits settled the standard x402 payment and the merchant accepted the request."
      : "Corbits settled the payment, but the merchant rejected the protected request.",
  }, !paid.ok);
}
