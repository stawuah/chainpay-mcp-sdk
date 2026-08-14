import type { AccountMeta, PreparePaymentInput } from "@chainpay/sdk";
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
    remainingAccounts: parseRemainingAccounts(args.remainingAccounts),
  };

  return {
    input,
    agent: solanaAddress(args.agent, "agent"),
  };
}

export function parseRemainingAccounts(value: unknown): AccountMeta[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("remainingAccounts must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`remainingAccounts[${index}] must be an object`);
    }
    const account = item as Record<string, unknown>;
    if (typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") {
      throw new Error(`remainingAccounts[${index}] must declare boolean isSigner and isWritable fields`);
    }
    return {
      address: solanaAddress(account.address, `remainingAccounts[${index}].address`),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    };
  });
}

export function requireObject(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}
