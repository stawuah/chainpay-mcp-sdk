import { hexToBytes } from "./receipt.js";
import type { PreparePaymentInput } from "./payment.js";
import type { Address, TokenProgram } from "./types.js";
import {
  CROSSMINT_CONNECTOR,
  CROSSMINT_CONNECTOR_LABEL,
  crossmintPaymentTerms,
  deriveCrossmintPaymentReferences,
  parseCrossmintOrder,
  type CrossmintPaymentTerms,
} from "./crossmint-order.js";

export type CrossmintPrepareFields = {
  connector: typeof CROSSMINT_CONNECTOR;
  connectorLabel: string;
  orderId: string;
  mint: Address;
  recipient: Address;
  amount: string;
  tokenProgram: TokenProgram;
  invoiceHash: string;
  paymentId: string;
  signatureReference: string;
};

/** Terms plus the references the receipt PDA is derived from. */
export async function crossmintTermsToPrepareFields(
  terms: CrossmintPaymentTerms,
): Promise<CrossmintPrepareFields> {
  const references = await deriveCrossmintPaymentReferences(terms.orderId);
  return {
    connector: CROSSMINT_CONNECTOR,
    connectorLabel: CROSSMINT_CONNECTOR_LABEL,
    orderId: terms.orderId,
    mint: terms.mint,
    recipient: terms.recipient,
    amount: terms.amount,
    tokenProgram: terms.tokenProgram,
    ...references,
  };
}

export function crossmintFieldsToPreparePaymentInput(
  mandate: Address,
  fields: CrossmintPrepareFields,
): PreparePaymentInput {
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

/** One call from a raw Crossmint order response to a ChainPay payment input. */
export async function crossmintOrderToPreparePaymentInput(
  mandate: Address,
  order: unknown,
  expected: { mint?: Address; tokenProgram?: TokenProgram } = {},
): Promise<{ terms: CrossmintPaymentTerms; fields: CrossmintPrepareFields; input: PreparePaymentInput }> {
  const terms = crossmintPaymentTerms(parseCrossmintOrder(order), expected);
  const fields = await crossmintTermsToPrepareFields(terms);
  return { terms, fields, input: crossmintFieldsToPreparePaymentInput(mandate, fields) };
}
