import type { TokenProgram } from "./types.js";
import { hexToBytes } from "./receipt.js";
import { deriveAssociatedTokenAddress } from "./token.js";
import type { PreparePaymentInput } from "./payment.js";
import { deriveX402PaymentReferences } from "./x402.js";
import {
  type CustomChallengeOption,
  type StandardV2Option,
  type DetectedChallenge,
} from "./x402-challenge.js";

export type X402PrepareFields = {
  mint: string;
  recipient: string;
  amount: string;
  resource: string;
  tokenProgram: TokenProgram;
  invoiceHash: string;
  paymentId: string;
  signatureReference: string;
  nonce: string;
  merchantOwner?: string;
};

export function standardV2RecipientTokenAccount(
  option: StandardV2Option,
  tokenProgram: TokenProgram,
): string {
  return deriveAssociatedTokenAddress(option.merchantOwner, option.asset, tokenProgram);
}

export async function customChallengeToPrepareFields(
  option: CustomChallengeOption,
  tokenProgram: TokenProgram,
): Promise<X402PrepareFields> {
  const references = await deriveX402PaymentReferences({
    mint: option.mint,
    recipient: option.recipient,
    amount: option.amount,
    resource: option.resource,
    tokenProgram,
    ...(option.nonce ? { nonce: option.nonce } : {}),
    ...(option.expiresAtSlot ? { expiresAtSlot: option.expiresAtSlot } : {}),
  });
  return {
    mint: option.mint,
    recipient: option.recipient,
    amount: option.amount,
    resource: option.resource,
    tokenProgram,
    ...references,
  };
}

export async function standardV2ChallengeToPrepareFields(
  option: StandardV2Option,
  tokenProgram: TokenProgram,
): Promise<X402PrepareFields> {
  const recipient = standardV2RecipientTokenAccount(option, tokenProgram);
  const references = await deriveX402PaymentReferences({
    mint: option.asset,
    recipient,
    amount: option.amount,
    resource: option.resource,
    tokenProgram,
  });
  return {
    mint: option.asset,
    recipient,
    amount: option.amount,
    resource: option.resource,
    tokenProgram,
    merchantOwner: option.merchantOwner,
    ...references,
  };
}

export async function toPreparePaymentInput(
  mandate: string,
  fields: X402PrepareFields,
): Promise<PreparePaymentInput> {
  return {
    mandate,
    invoiceHash: hexToBytes(fields.invoiceHash, "invoiceHash"),
    paymentId: hexToBytes(fields.paymentId, "paymentId"),
    signatureReference: hexToBytes(fields.signatureReference, "signatureReference"),
    mint: fields.mint,
    recipient: fields.recipient,
    amount: BigInt(fields.amount),
    tokenProgram: fields.tokenProgram,
  };
}

export async function detectedChallengeToPrepareFields(
  detected: DetectedChallenge,
  tokenProgram: TokenProgram,
): Promise<X402PrepareFields> {
  if (detected.kind === "custom") {
    return customChallengeToPrepareFields(detected.option, tokenProgram);
  }
  return standardV2ChallengeToPrepareFields(detected.option, tokenProgram);
}
