import type { Address, Mandate, PaymentReceipt, PaymentStatus } from "./types.js";
import { decodeCurrentMandateFields, decodePaymentReceipt } from "./accounts.js";
import {
  ACCOUNT_DISCRIMINATORS,
  DEFAULT_PROGRAM_ID,
  RECEIPT_ACCOUNT_LENGTH,
  RECEIPT_STATUS_SETTLED,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./constants.js";
import { address } from "./encoding.js";
import { deriveReceiptAddress } from "./pda.js";

const MAX_U64 = 18_446_744_073_709_551_615n;
const ACCOUNT_DISCRIMINATOR_LENGTH = 8;

export type ReceiptAccountView = {
  address: Address;
  owner: Address;
  data: Uint8Array | Buffer;
};

export type ReceiptValidationCode =
  | "wrong_owner"
  | "wrong_discriminator"
  | "truncated"
  | "pda_mismatch"
  | "unsettled"
  | "not_found";

export type ReceiptReadFailure = {
  valid: false;
  code: ReceiptValidationCode;
  reason: string;
};

export type ReceiptReadSuccess = {
  valid: true;
  receipt: PaymentReceipt;
  programId: Address;
  derivedAddress: Address;
  settled: boolean;
};

export type ReceiptReadResult = ReceiptReadSuccess | ReceiptReadFailure;

export type ReadReceiptOptions = {
  programId?: Address;
  requireSettled?: boolean;
  transactionSignature?: string;
};

export type TokenAmountDisplay = {
  /** Exact unsigned integer string of base units. Never a JS Number. */
  baseUnits: string;
  decimals: number | null;
  /**
   * Decimal-inserted UI amount when a supported mint owner and decimals
   * are known. Otherwise the exact base-unit string. Never rounded.
   */
  display: string;
  displayKind: "ui-amount" | "base-units";
};

export type MintDecimalsRead =
  | { ok: true; decimals: number }
  | { ok: false; reason: "unsupported_owner" | "truncated" | "missing" };

export type CurrentMandateRead =
  | { status: "present"; mandate: Mandate }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type PublicReceiptProof = {
  receipt: ReceiptReadResult;
  amount: TokenAmountDisplay | null;
  currentMandate: CurrentMandateRead;
};

function accountBytes(data: Uint8Array | Buffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function discriminatorsEqual(data: Uint8Array, expected: Uint8Array): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (data[index] !== expected[index]) return false;
  }
  return true;
}

function failure(code: ReceiptValidationCode, reason: string): ReceiptReadFailure {
  return { valid: false, code, reason };
}

export function createReceiptReference(
  address: Address,
  mandate: Address,
  invoiceHash: Uint8Array,
  status: PaymentStatus,
): Pick<PaymentReceipt, "address" | "mandate" | "invoiceHash" | "status"> {
  return { address, mandate, invoiceHash, status };
}

export function receiptAddress(
  mandate: Address,
  invoiceHash: Uint8Array,
  programId: Address = DEFAULT_PROGRAM_ID,
): Address {
  return deriveReceiptAddress(mandate, invoiceHash, programId);
}

export { decodePaymentReceipt };

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value: string, name: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length !== 64) {
    throw new Error(`${name} must be exactly 32 bytes encoded as hexadecimal`);
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Read mint decimals only after confirming the account owner is a supported
 * token program. Callers must not inspect the decimals byte first.
 */
export function readVerifiedMintDecimals(
  account: { owner: Address; data: Uint8Array | Buffer } | null | undefined,
): MintDecimalsRead {
  if (!account) return { ok: false, reason: "missing" };
  const owner = address(account.owner);
  if (owner !== SPL_TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) {
    return { ok: false, reason: "unsupported_owner" };
  }
  const data = accountBytes(account.data);
  if (data.length <= 44) return { ok: false, reason: "truncated" };
  return { ok: true, decimals: data[44] };
}

/**
 * Format a u64 token amount without Number conversion or rounding.
 * Unknown decimals stay exact base units so a public card never invents
 * a UI amount.
 */
export function formatExactTokenAmount(
  amount: bigint,
  decimals?: number | null,
): TokenAmountDisplay {
  if (amount < 0n || amount > MAX_U64) {
    throw new Error("amount must fit in an unsigned 64-bit integer");
  }
  const baseUnits = amount.toString();
  if (
    decimals === null
    || decimals === undefined
    || !Number.isInteger(decimals)
    || decimals < 0
    || decimals > 255
  ) {
    return { baseUnits, decimals: null, display: baseUnits, displayKind: "base-units" };
  }
  if (decimals === 0) {
    return { baseUnits, decimals, display: baseUnits, displayKind: "ui-amount" };
  }
  const padded = baseUnits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  return { baseUnits, decimals, display: `${whole}.${fraction}`, displayKind: "ui-amount" };
}

export function amountDisplayFromMint(
  amount: bigint,
  mintAccount?: { owner: Address; data: Uint8Array | Buffer } | null,
): TokenAmountDisplay {
  const mint = readVerifiedMintDecimals(mintAccount);
  return formatExactTokenAmount(amount, mint.ok ? mint.decimals : null);
}

/**
 * Optional current-mandate enrichment. Independent of creation history
 * and source token metadata. Missing or undecodable accounts never
 * become fabricated limits.
 */
export function readCurrentMandateFields(
  account: ReceiptAccountView | null | undefined,
  options: { programId?: Address; currentSlot?: bigint; expectedAddress?: Address } = {},
): CurrentMandateRead {
  if (!account) return { status: "absent" };
  const programId = address(options.programId ?? DEFAULT_PROGRAM_ID);
  try {
    if (address(account.owner) !== programId) {
      return { status: "unavailable", reason: "Mandate account is not owned by the ChainPay program" };
    }
    if (options.expectedAddress !== undefined && address(account.address) !== address(options.expectedAddress)) {
      return { status: "unavailable", reason: "Mandate account address does not match the receipt mandate" };
    }
    return {
      status: "present",
      mandate: decodeCurrentMandateFields(account.data, account.address, options.currentSlot),
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validating receipt reader for public `/verify` and shared ledger cards.
 * Confirms program owner, discriminator, length, PDA seeds
 * `["receipt", mandate, invoice_hash]`, and optional settled status.
 * `signatureReference` is never treated as seller delivery.
 */
export function readPaymentReceiptAccount(
  account: ReceiptAccountView,
  options: ReadReceiptOptions = {},
): ReceiptReadResult {
  const programId = address(options.programId ?? DEFAULT_PROGRAM_ID);
  let requestedAddress: Address;
  try {
    requestedAddress = address(account.address);
  } catch {
    return failure("not_found", "Receipt address is not a valid Solana public key");
  }

  try {
    if (address(account.owner) !== programId) {
      return failure("wrong_owner", "Receipt account is not owned by the ChainPay program");
    }
  } catch {
    return failure("wrong_owner", "Receipt account is not owned by the ChainPay program");
  }

  const data = accountBytes(account.data);
  if (data.length < ACCOUNT_DISCRIMINATOR_LENGTH) {
    return failure("truncated", "PaymentReceipt account data is truncated");
  }
  if (!discriminatorsEqual(data, ACCOUNT_DISCRIMINATORS.paymentReceipt)) {
    return failure("wrong_discriminator", "Invalid PaymentReceipt account discriminator");
  }
  if (data.length < RECEIPT_ACCOUNT_LENGTH) {
    return failure("truncated", "PaymentReceipt account data is truncated");
  }

  const receipt = decodePaymentReceipt(data, requestedAddress, options.transactionSignature);
  const derivedAddress = deriveReceiptAddress(receipt.mandate, receipt.invoiceHash, programId);
  if (derivedAddress !== requestedAddress) {
    return failure(
      "pda_mismatch",
      "Receipt address does not match PDA seeds [\"receipt\", mandate, invoice_hash]",
    );
  }

  const settled = receipt.onChainStatus === RECEIPT_STATUS_SETTLED;
  if ((options.requireSettled ?? false) && !settled) {
    return failure("unsettled", "Receipt is not settled");
  }

  return {
    valid: true,
    receipt,
    programId,
    derivedAddress,
    settled,
  };
}

/** Public verify path: same checks plus settled status. */
export function readPublicSettledReceipt(
  account: ReceiptAccountView,
  options: Omit<ReadReceiptOptions, "requireSettled"> = {},
): ReceiptReadResult {
  return readPaymentReceiptAccount(account, { ...options, requireSettled: true });
}

export function requirePaymentReceiptAccount(
  account: ReceiptAccountView,
  options: ReadReceiptOptions = {},
): PaymentReceipt {
  const result = readPaymentReceiptAccount(account, options);
  if (!result.valid) throw new Error(result.reason);
  return result.receipt;
}

export function assemblePublicReceiptProof(input: {
  receiptAccount: ReceiptAccountView;
  programId?: Address;
  mintAccount?: { owner: Address; data: Uint8Array | Buffer } | null;
  mandateAccount?: ReceiptAccountView | null;
  currentSlot?: bigint;
  transactionSignature?: string;
}): PublicReceiptProof {
  const receipt = readPublicSettledReceipt(input.receiptAccount, {
    programId: input.programId,
    transactionSignature: input.transactionSignature,
  });
  if (!receipt.valid) {
    return {
      receipt,
      amount: null,
      currentMandate: readCurrentMandateFields(input.mandateAccount, {
        programId: input.programId,
        currentSlot: input.currentSlot,
      }),
    };
  }
  return {
    receipt,
    amount: amountDisplayFromMint(receipt.receipt.amount, input.mintAccount),
    currentMandate: readCurrentMandateFields(input.mandateAccount, {
      programId: input.programId,
      currentSlot: input.currentSlot,
      expectedAddress: receipt.receipt.mandate,
    }),
  };
}
