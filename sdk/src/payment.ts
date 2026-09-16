import type {
  Address,
  BatchPreflightEntry,
  ChainPayInstruction,
  Mandate,
  PaymentBatchPreflight,
  PaymentPreflight,
  PaymentPreflightContext,
  PaymentRequest,
  PreparedTransaction,
  TokenProgram,
} from "./types.js";
import { DEFAULT_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "./constants.js";
import {
  address,
  bytes32,
  encodePayment,
  instruction,
  meta,
  publicKey,
  tokenProgramAddress,
} from "./encoding.js";
import { deriveAssetAddress, deriveConfigAddress, deriveReceiptAddress } from "./pda.js";

export type PreparePaymentInput = {
  mandate: Address;
  invoiceHash: Uint8Array;
  paymentId: Uint8Array;
  signatureReference: Uint8Array;
  mint: Address;
  recipient: Address;
  amount: bigint;
  tokenProgram?: TokenProgram;
};

export function preparePayment(input: PreparePaymentInput): PaymentRequest {
  publicKey(input.mandate);
  publicKey(input.mint);
  publicKey(input.recipient);
  const untrustedRemainingAccounts = (input as PreparePaymentInput & { remainingAccounts?: unknown[] }).remainingAccounts;
  if (untrustedRemainingAccounts?.length) {
    throw new Error("Caller-supplied remainingAccounts are not accepted; ChainPay must resolve extension accounts from verified on-chain state");
  }
  bytes32(input.invoiceHash, "invoiceHash");
  bytes32(input.paymentId, "paymentId");
  bytes32(input.signatureReference, "signatureReference");
  if (input.invoiceHash.length !== 32) {
    throw new Error("invoiceHash must be 32 bytes");
  }
  if (input.paymentId.length !== 32) {
    throw new Error("paymentId must be 32 bytes");
  }
  if (input.signatureReference.length !== 32) {
    throw new Error("signatureReference must be 32 bytes");
  }
  if (input.amount <= 0n) {
    throw new Error("amount must be positive");
  }
  return {
    ...input,
    invoiceHash: new Uint8Array(input.invoiceHash),
    paymentId: new Uint8Array(input.paymentId),
    signatureReference: new Uint8Array(input.signatureReference),
  };
}

export function buildExecutePaymentInstruction(
  request: PaymentRequest,
  agent: Address,
  mandate: Mandate,
  programId: Address = DEFAULT_PROGRAM_ID,
): ChainPayInstruction {
  publicKey(agent);
  if (address(request.mandate) !== mandate.address) {
    throw new Error("Payment request mandate does not match the loaded mandate");
  }

  const tokenProgram = request.tokenProgram ?? mandate.tokenProgram;
  if (!tokenProgram) {
    throw new Error("Token program is required to build an execute_payment instruction");
  }

  return instruction(
    "execute_payment",
    programId,
    [
      meta(deriveConfigAddress(programId)),
      meta(deriveAssetAddress(mandate.allowedMint, programId)),
      meta(mandate.address, true),
      meta(deriveReceiptAddress(mandate.address, request.invoiceHash, programId), true),
      meta(agent, true, true),
      meta(request.mint),
      meta(mandate.sourceTokenAccount, true),
      meta(request.recipient, true),
      meta(tokenProgramAddress(tokenProgram)),
      meta(SYSTEM_PROGRAM_ID),
    ],
    encodePayment(request),
  );
}

function check(name: string, ok: boolean, message: string) {
  return { name, ok, message };
}

function sourceAccountChecks(
  request: PaymentRequest,
  mandate: Mandate,
  context: PaymentPreflightContext,
) {
  return [
    check(
      "source_owner",
      address(context.sourceOwner) === mandate.owner,
      address(context.sourceOwner) === mandate.owner
        ? "Source token account owner matches the mandate owner"
        : "Source token account owner does not match the mandate owner",
    ),
    check(
      "source_balance",
      request.amount <= context.sourceBalance,
      request.amount <= context.sourceBalance
        ? "Source token account balance covers this payment"
        : "Source token account balance is insufficient for this payment",
    ),
    check(
      "delegate_identity",
      context.delegate !== null && address(context.delegate) === mandate.address,
      context.delegate !== null && address(context.delegate) === mandate.address
        ? "Source token account delegates spending authority to this mandate"
        : "Source token account is not delegated to this mandate",
    ),
    check(
      "delegated_amount",
      context.delegatedAmount > 0n && request.amount <= context.delegatedAmount,
      context.delegatedAmount > 0n && request.amount <= context.delegatedAmount
        ? "Remaining delegated allowance covers this payment"
        : context.delegatedAmount <= 0n
          ? "Source token account has no remaining delegated allowance"
          : "Payment exceeds the remaining delegated allowance",
    ),
  ];
}

export function preflightPayment(
  request: PaymentRequest,
  mandate: Mandate,
  currentSlot: bigint,
  agent?: Address,
  receiptAlreadyExists = false,
  sourceContext?: PaymentPreflightContext,
): PaymentPreflight {
  const checks = [
    check(
      "mandate_status",
      mandate.status === "active",
      mandate.status === "active"
        ? "Mandate is active"
        : `Mandate is ${mandate.status}`,
    ),
    check(
      "approved_agent",
      agent === undefined || address(agent) === mandate.approvedAgent,
      agent === undefined || address(agent) === mandate.approvedAgent
        ? "Payment agent matches the mandate"
        : "Payment agent does not match the mandate",
    ),
    check(
      "mint",
      address(request.mint) === mandate.allowedMint,
      address(request.mint) === mandate.allowedMint
        ? "Payment mint matches the mandate"
        : "Payment mint does not match the mandate",
    ),
    check(
      "recipient",
      address(request.recipient) !== SYSTEM_PROGRAM_ID,
      address(request.recipient) !== SYSTEM_PROGRAM_ID
        ? "Payment recipient is specified for this request"
        : "Payment recipient must be specified",
    ),
    check(
      "amount_positive",
      request.amount > 0n,
      request.amount > 0n ? "Payment amount is positive" : "Payment amount must be positive",
    ),
    check(
      "per_payment_limit",
      request.amount <= mandate.maxPerPayment,
      request.amount <= mandate.maxPerPayment
        ? "Payment is within the per-payment limit"
        : "Payment exceeds the per-payment limit",
    ),
    check(
      "total_limit",
      request.amount >= 0n && mandate.amountSpent + request.amount <= mandate.totalLimit,
      request.amount >= 0n && mandate.amountSpent + request.amount <= mandate.totalLimit
        ? "Payment is within the total spend limit"
        : "Payment exceeds the total spend limit",
    ),
    check(
      "payment_count_limit",
      mandate.maxPaymentCount === 0n || mandate.paymentCount + 1n <= mandate.maxPaymentCount,
      mandate.maxPaymentCount === 0n || mandate.paymentCount + 1n <= mandate.maxPaymentCount
        ? "Payment is within the payment-count limit"
        : "Payment exceeds the payment-count limit",
    ),
    check(
      "cooldown",
      mandate.lastPaymentSlot === 0n || currentSlot >= mandate.lastPaymentSlot + mandate.cooldownSlots,
      mandate.lastPaymentSlot === 0n || currentSlot >= mandate.lastPaymentSlot + mandate.cooldownSlots
        ? "Mandate cooldown has elapsed"
        : "Mandate cooldown is still active",
    ),
    check(
      "expiry",
      mandate.expiresAtSlot > currentSlot,
      mandate.expiresAtSlot > currentSlot ? "Mandate has not expired" : "Mandate has expired",
    ),
    check(
      "invoice_hash",
      request.invoiceHash.some((byte) => byte !== 0),
      request.invoiceHash.some((byte) => byte !== 0)
        ? "Invoice hash is non-zero"
        : "Invoice hash must not be all zeroes",
    ),
    check(
      "payment_id",
      request.paymentId.some((byte) => byte !== 0),
      request.paymentId.some((byte) => byte !== 0)
        ? "Payment ID is non-zero"
        : "Payment ID must not be all zeroes",
    ),
    check(
      "signature_reference",
      request.signatureReference.some((byte) => byte !== 0),
      request.signatureReference.some((byte) => byte !== 0)
        ? "Signature reference is non-zero"
        : "Signature reference must not be all zeroes",
    ),
    check(
      "duplicate_invoice",
      !receiptAlreadyExists,
      receiptAlreadyExists
        ? "This invoice hash already has a receipt under the mandate"
        : "No receipt exists for this invoice hash",
    ),
    check(
      "token_program",
      request.tokenProgram === undefined ||
        mandate.tokenProgram === undefined ||
        request.tokenProgram === mandate.tokenProgram,
      request.tokenProgram === undefined ||
        mandate.tokenProgram === undefined ||
        request.tokenProgram === mandate.tokenProgram
        ? "Token program matches the loaded mandate context"
        : "Token program does not match the source token account",
    ),
    ...(sourceContext ? sourceAccountChecks(request, mandate, sourceContext) : []),
  ];

  return { valid: checks.every((item) => item.ok), currentSlot, checks };
}

function batchChecksForMandateGroup(
  group: BatchPreflightEntry[],
  mandate: Mandate,
): ReturnType<typeof check>[] {
  const totalAmount = group.reduce((total, entry) => total + entry.request.amount, 0n);
  const checks: ReturnType<typeof check>[] = [
    check(
      "batch_total_limit",
      mandate.amountSpent + totalAmount <= mandate.totalLimit,
      mandate.amountSpent + totalAmount <= mandate.totalLimit
        ? "Batch total is within the mandate spending limit"
        : "Together, these payments exceed the mandate total spending limit",
    ),
    check(
      "batch_payment_count",
      mandate.maxPaymentCount === 0n || mandate.paymentCount + BigInt(group.length) <= mandate.maxPaymentCount,
      mandate.maxPaymentCount === 0n || mandate.paymentCount + BigInt(group.length) <= mandate.maxPaymentCount
        ? "Batch size is within the mandate payment-count limit"
        : "Together, these payments exceed the mandate payment-count limit",
    ),
    check(
      "batch_cooldown",
      group.length <= 1 || mandate.cooldownSlots === 0n,
      group.length <= 1 || mandate.cooldownSlots === 0n
        ? "Batch respects the mandate cooldown policy"
        : "This mandate has a cooldown and can only settle once per atomic batch",
    ),
  ];

  const context = group.find((entry) => entry.sourceContext)?.sourceContext;
  if (context) {
    checks.push(
      check(
        "batch_source_balance",
        totalAmount <= context.sourceBalance,
        totalAmount <= context.sourceBalance
          ? "Source token account balance covers the batch total"
          : "Source token account balance is insufficient for the batch total",
      ),
      check(
        "batch_delegated_amount",
        context.delegatedAmount > 0n && totalAmount <= context.delegatedAmount,
        context.delegatedAmount > 0n && totalAmount <= context.delegatedAmount
          ? "Remaining delegated allowance covers the batch total"
          : context.delegatedAmount <= 0n
            ? "Source token account has no remaining delegated allowance for this batch"
            : "Batch total exceeds the remaining delegated allowance",
      ),
    );
  }

  return checks;
}

/**
 * Run per-payment preflight plus cumulative batch checks grouped by mandate.
 * Dashboard batch import uses the same cumulative rules when source context
 * is supplied for each row.
 */
export function preflightPaymentBatch(
  entries: BatchPreflightEntry[],
  currentSlot: bigint,
): PaymentBatchPreflight {
  const preparedEntries = entries.map((entry) => ({
    request: entry.request,
    mandate: address(entry.mandate.address),
    preflight: preflightPayment(
      entry.request,
      entry.mandate,
      currentSlot,
      entry.agent,
      entry.receiptAlreadyExists ?? false,
      entry.sourceContext,
    ),
  }));

  const groups = new Map<string, BatchPreflightEntry[]>();
  for (const entry of entries) {
    const key = address(entry.mandate.address);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const batchChecks = [...groups.values()].flatMap((group) => batchChecksForMandateGroup(group, group[0].mandate));
  const valid = preparedEntries.every((entry) => entry.preflight.valid) && batchChecks.every((item) => item.ok);

  return {
    valid,
    currentSlot,
    entries: preparedEntries,
    batchChecks,
  };
}

export function preparedPaymentTransaction(
  instructionData: ChainPayInstruction,
  agent: Address,
): PreparedTransaction {
  return {
    instructions: [instructionData],
    requiredSigners: [agent],
    feePayer: agent,
  };
}
