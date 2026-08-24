import type { PreparePaymentInput } from "@chainpay/sdk";
import {
  hex32,
  requiredString,
  solanaAddress,
  tokenProgram,
  unsignedInteger,
} from "./common.js";

export function parsePaymentInput(args: Record<string, unknown>): {
  input: PreparePaymentInput;
  agent: string;
} {
  if (args.remainingAccounts !== undefined) {
    throw new Error("remainingAccounts cannot be supplied by callers; ChainPay resolves compatible extension requirements from on-chain state");
  }
  const input: PreparePaymentInput = {
    mandate: solanaAddress(args.mandate, "mandate"),
    invoiceHash: hex32(args.invoiceHash, "invoiceHash"),
    paymentId: hex32(args.paymentId, "paymentId"),
    signatureReference: hex32(args.signatureReference, "signatureReference"),
    mint: solanaAddress(args.mint, "mint"),
    recipient: solanaAddress(args.recipient, "recipient"),
    amount: unsignedInteger(args.amount, "amount"),
    tokenProgram: args.tokenProgram === undefined
      ? undefined
      : tokenProgram(args.tokenProgram),
  };

  return {
    input,
    agent: solanaAddress(args.agent, "agent"),
  };
}

export function requireObject(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}
