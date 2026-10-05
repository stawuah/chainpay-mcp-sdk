import { hexToBytes } from "./receipt.js";
import type { PreparePaymentInput } from "./payment.js";
import type { Address, ChainPayInstruction, PreparedTransaction, TokenProgram } from "./types.js";
import { MEMO_PROGRAM_ID } from "./constants.js";
import {
  CROSSMINT_CONNECTOR,
  CROSSMINT_CONNECTOR_LABEL,
  MAX_CROSSMINT_MEMO_BYTES,
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

/**
 * Crossmint's order memo as a top-level SPL Memo instruction with no accounts.
 *
 * Crossmint's own preparation has the payer sign the memo. In ChainPay the
 * approved agent signs and pays fees, never the owner, so the memo names no
 * signer; the memo program accepts an unsigned memo. The bytes are Crossmint's
 * memo exactly, because Crossmint matches a payment to its order by this text.
 */
export function crossmintMemoInstruction(memo: string): ChainPayInstruction {
  const data = new TextEncoder().encode(memo);
  if (data.length === 0 || data.length > MAX_CROSSMINT_MEMO_BYTES) {
    throw new Error("Crossmint memo is empty or too long");
  }
  return { name: "crossmint_order_memo", programId: MEMO_PROGRAM_ID, keys: [], data };
}

/**
 * The transaction a Crossmint checkout signs: the unchanged mandate payment,
 * then Crossmint's memo. Nothing else is added and nothing is dropped; a
 * prepared payment that is not exactly one `execute_payment` is refused.
 * The receipt PDA and invoice hash are untouched: they come from the order id.
 */
export function crossmintPaymentTransaction(
  prepared: PreparedTransaction,
  terms: Pick<CrossmintPaymentTerms, "memo">,
): PreparedTransaction {
  if (!terms.memo) throw new Error("Crossmint terms carry no checked order memo");
  if (prepared.instructions.length !== 1 || prepared.instructions[0].name !== "execute_payment") {
    throw new Error("A Crossmint payment must start from exactly one execute_payment instruction");
  }
  return {
    ...prepared,
    requiredSigners: [...prepared.requiredSigners],
    instructions: [prepared.instructions[0], crossmintMemoInstruction(terms.memo)],
  };
}
