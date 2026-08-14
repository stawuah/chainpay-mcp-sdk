import type {
  AccountMeta,
  Address,
  ChainPayInstruction,
  Mandate,
  PaymentPreflight,
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
  /** Extra accounts required by a Token-2022 extension such as transfer-hook. */
  remainingAccounts?: AccountMeta[];
};

export function preparePayment(input: PreparePaymentInput): PaymentRequest {
  publicKey(input.mandate);
  publicKey(input.mint);
  publicKey(input.recipient);
  input.remainingAccounts?.forEach((account, index) => {
    publicKey(account.address);
    if (typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") {
      throw new Error(`remainingAccounts[${index}] must declare boolean isSigner and isWritable fields`);
    }
  });
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
    remainingAccounts: input.remainingAccounts?.map((account) => ({ ...account })),
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
      ...(request.remainingAccounts ?? []),
    ],
    encodePayment(request),
  );
}

function check(name: string, ok: boolean, message: string) {
  return { name, ok, message };
}

export function preflightPayment(
  request: PaymentRequest,
  mandate: Mandate,
  currentSlot: bigint,
  agent?: Address,
  receiptAlreadyExists = false,
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
  ];

  return { valid: checks.every((item) => item.ok), currentSlot, checks };
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
