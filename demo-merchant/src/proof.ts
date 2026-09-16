import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { createRequire } from "node:module";
import {
  DISCRIMINATORS,
  DEFAULT_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  bytesToHex,
  decodeSupportedTransaction,
  deriveAssetAddress,
  deriveConfigAddress,
  deriveReceiptAddress,
  hexToBytes,
  publicKey,
  type PaymentReceipt,
  type X402PaymentReferences,
} from "@chainpay/sdk";
import type { MerchantConfig } from "./config.js";

const require = createRequire(import.meta.url);
const bs58 = require("bs58") as {
  encode(data: Uint8Array | Buffer | number[]): string;
  decode(data: string): Buffer;
};

export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const CUSTOM_X402_VERSION = "x402/1.0" as const;

const MAX_HEADER_CHARS = 16 * 1024;
const MAX_DECODED_CHARS = 16 * 1024;
const MAX_RPC_BYTES = 1_048_576;
const MAX_WIRE_BYTES = 4096;
const MAX_BASE64_WIRE_CHARS = 5464;
const MAX_ACCOUNT_KEYS = 256;
const MAX_INSTRUCTIONS = 64;
const MAX_LOADED_ADDRESSES = 256;
const VERIFY_TIMEOUT_MS = 10_000;
const EXECUTE_PAYMENT_DATA_LENGTH = 112;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type ProofErrorCategory =
  | "invalid_proof"
  | "receipt_not_found"
  | "receipt_mismatch"
  | "transaction_unavailable"
  | "rpc_unavailable"
  | "unsupported_protocol";

const PUBLIC_MESSAGES: Record<ProofErrorCategory, string> = {
  invalid_proof: "Payment verification failed",
  receipt_not_found: "Payment verification failed",
  receipt_mismatch: "Payment verification failed",
  transaction_unavailable:
    "Settlement confirmation is temporarily unavailable; retry this resource with the same proof and do not settle again",
  rpc_unavailable:
    "Settlement confirmation is temporarily unavailable; retry this resource with the same proof and do not settle again",
  unsupported_protocol: "Standard x402 exactSVM is unsupported without a ChainPay-accepted sponsor",
};

export class MerchantProofError extends Error {
  readonly category: ProofErrorCategory;
  readonly httpStatus: 402 | 503;
  readonly publicMessage: string;
  readonly mode?: "unsupported-sponsor";

  constructor(category: ProofErrorCategory) {
    super(PUBLIC_MESSAGES[category]);
    this.name = "MerchantProofError";
    this.category = category;
    this.httpStatus = category === "rpc_unavailable" || category === "transaction_unavailable" ? 503 : 402;
    this.publicMessage = PUBLIC_MESSAGES[category];
    if (category === "unsupported_protocol") this.mode = "unsupported-sponsor";
  }
}

export type CustomReceiptProof = {
  version: "x402/1.0";
  scheme: "exact";
  network: "solana-devnet";
  payload: { signature: string; receiptPDA: string };
};

export type StandardV2Document = {
  x402Version: 2;
  accepted?: unknown;
  accepts?: unknown;
  payload?: unknown;
  resource?: unknown;
};

export type DetectedPayment =
  | { kind: "custom"; proof: CustomReceiptProof }
  | { kind: "standard-v2"; document: StandardV2Document }
  | { kind: "malformed" };

export type VerifiedMerchantPayment = {
  receipt: PaymentReceipt;
  transactionSignature: string;
  resource: string;
};

export type MerchantVerificationDependencies = {
  getFinalizedReceipt(address: string): Promise<PaymentReceipt | null>;
  getFinalizedTransaction(signature: string): Promise<unknown>;
};

export type SettlementExpectation = {
  programId: string;
  mint: string;
  recipient: string;
  amount: bigint;
  agent: string;
  tokenProgram: string;
  configPda: string;
  assetPda: string;
  invoiceHash: Uint8Array;
  paymentId: Uint8Array;
  signatureReference: Uint8Array;
};

type AccountRole = { address: string; isSigner: boolean; isWritable: boolean };

type CompiledInstruction = {
  programAddressIndex: number;
  accountIndices: number[];
  data: Uint8Array;
};

type DecodedMessage = {
  version: "legacy" | 0 | 1;
  header: {
    numSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  };
  staticAccounts: string[];
  instructions?: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>;
  instructionHeaders?: Array<{
    programAccountIndex: number;
    numInstructionAccounts: number;
    numInstructionDataBytes: number;
  }>;
  instructionPayloads?: Array<{ instructionAccountIndices: number[]; instructionData: Uint8Array }>;
  addressTableLookups?: Array<{
    lookupTableAddress: string;
    writableIndexes: readonly number[];
    readonlyIndexes: readonly number[];
  }>;
};

function fail(category: ProofErrorCategory): never {
  throw new MerchantProofError(category);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left[index] ^ right[index];
  return different === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function encodeCanonicalBase58(bytes: Uint8Array): string {
  return bs58.encode(Buffer.from(bytes));
}

export function decodeCanonicalBase58(value: string, expectedLength: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) fail("invalid_proof");
  let decoded: Buffer;
  try {
    decoded = bs58.decode(value);
  } catch {
    fail("invalid_proof");
  }
  if (decoded.length !== expectedLength) fail("invalid_proof");
  if (bs58.encode(decoded) !== value) fail("invalid_proof");
  return new Uint8Array(decoded);
}

function canonicalPublicKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) fail("invalid_proof");
  let encoded: string;
  try {
    encoded = publicKey(value).toBase58();
  } catch {
    fail("invalid_proof");
  }
  if (encoded !== value) fail("invalid_proof");
  return encoded;
}

function decodeHeaderDocument(header: string): unknown {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER_CHARS) fail("invalid_proof");
  try {
    return JSON.parse(header);
  } catch {
    let decoded: string;
    try {
      decoded = Buffer.from(header, "base64").toString("utf8");
    } catch {
      fail("invalid_proof");
    }
    if (!decoded || decoded.length > MAX_DECODED_CHARS) fail("invalid_proof");
    try {
      return JSON.parse(decoded);
    } catch {
      fail("invalid_proof");
    }
  }
}

function parseCustomObject(value: Record<string, unknown>): CustomReceiptProof {
  if (!exactKeys(value, ["version", "scheme", "network", "payload"])) fail("invalid_proof");
  if (value.version !== CUSTOM_X402_VERSION || value.scheme !== "exact" || value.network !== "solana-devnet") {
    fail("invalid_proof");
  }
  if (!isRecord(value.payload) || !exactKeys(value.payload, ["signature", "receiptPDA"])) fail("invalid_proof");
  const signature = value.payload.signature;
  const receiptPDA = value.payload.receiptPDA;
  if (typeof signature !== "string" || typeof receiptPDA !== "string") fail("invalid_proof");
  decodeCanonicalBase58(signature, 64);
  return {
    version: CUSTOM_X402_VERSION,
    scheme: "exact",
    network: "solana-devnet",
    payload: {
      signature,
      receiptPDA: canonicalPublicKey(receiptPDA),
    },
  };
}

function canonicalIntegerString(value: unknown): boolean {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}

function readV2Requirement(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.accepted)) return value.accepted;
  if (Array.isArray(value.accepts) && isRecord(value.accepts[0])) return value.accepts[0];
  return undefined;
}

/**
 * Discriminate custom ChainPay receipt-proof vs standard x402 v2 from document shape.
 * Header names are not a protocol signal.
 */
export function detectPaymentProtocol(value: unknown): DetectedPayment {
  if (!isRecord(value)) return { kind: "malformed" };
  const mixed = value.x402Version === 2 && value.version === CUSTOM_X402_VERSION;
  if (mixed) return { kind: "malformed" };
  if (value.x402Version === 2) {
    return { kind: "standard-v2", document: value as StandardV2Document };
  }
  if (value.version === CUSTOM_X402_VERSION) {
    try {
      return { kind: "custom", proof: parseCustomObject(value) };
    } catch (error) {
      if (error instanceof MerchantProofError) return { kind: "malformed" };
      throw error;
    }
  }
  return { kind: "malformed" };
}

export function parseCustomReceiptProof(header: string): CustomReceiptProof {
  const detected = detectPaymentProtocol(decodeHeaderDocument(header));
  if (detected.kind !== "custom") fail("invalid_proof");
  return detected.proof;
}

export function inspectPaymentHeader(header: string): DetectedPayment {
  return detectPaymentProtocol(decodeHeaderDocument(header));
}

function rejectStandardV2(document: StandardV2Document): never {
  const requirement = readV2Requirement(document);
  if (requirement) {
    const amount = requirement.amount ?? requirement.maxAmountRequired;
    if (typeof amount === "number") fail("invalid_proof");
    if (amount !== undefined && !canonicalIntegerString(amount)) fail("invalid_proof");
    const network = requirement.network;
    if (typeof network === "string" && network !== SOLANA_DEVNET_CAIP2 && !network.startsWith("solana:")) {
      fail("invalid_proof");
    }
  }
  fail("unsupported_protocol");
}

function asSlot(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    fail("receipt_mismatch");
  }
  return BigInt(value);
}

function verifyMessageSignature(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || signature.every((byte) => byte === 0)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey(address).toBytes())]),
      format: "der",
      type: "spki",
    });
    return verifyEd25519(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

function compiledInstructions(message: DecodedMessage): CompiledInstruction[] {
  if (message.version === 1) {
    const headers = message.instructionHeaders;
    const payloads = message.instructionPayloads;
    if (!headers || !payloads || headers.length !== payloads.length || headers.length !== message.instructionHeaders?.length) {
      fail("receipt_mismatch");
    }
    const numInstructions = (message as DecodedMessage & { numInstructions?: unknown }).numInstructions;
    if (typeof numInstructions === "number" && numInstructions !== headers.length) {
      fail("receipt_mismatch");
    }
    if (headers.length > MAX_INSTRUCTIONS) fail("receipt_mismatch");
    return headers.map((header, index) => {
      const payload = payloads[index];
      if (header.numInstructionAccounts !== payload.instructionAccountIndices.length) fail("receipt_mismatch");
      if (header.numInstructionDataBytes !== payload.instructionData.length) fail("receipt_mismatch");
      return {
        programAddressIndex: header.programAccountIndex,
        accountIndices: payload.instructionAccountIndices,
        data: Uint8Array.from(payload.instructionData),
      };
    });
  }
  const instructions = message.instructions;
  if (!instructions || instructions.length > MAX_INSTRUCTIONS) fail("receipt_mismatch");
  return instructions.map((instruction) => ({
    programAddressIndex: instruction.programAddressIndex,
    accountIndices: [...(instruction.accountIndices ?? [])],
    data: instruction.data ? Uint8Array.from(instruction.data) : new Uint8Array(),
  }));
}

function resolveAccounts(
  message: DecodedMessage,
  loadedAddresses: { writable: string[]; readonly: string[] },
): AccountRole[] {
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = message.header;
  const staticAccounts = message.staticAccounts;
  if (!Array.isArray(staticAccounts) || staticAccounts.length === 0 || staticAccounts.length > MAX_ACCOUNT_KEYS) {
    fail("receipt_mismatch");
  }
  if (
    !Number.isInteger(numSignerAccounts)
    || !Number.isInteger(numReadonlySignerAccounts)
    || !Number.isInteger(numReadonlyNonSignerAccounts)
    || numSignerAccounts < 1
    || numReadonlySignerAccounts < 0
    || numReadonlyNonSignerAccounts < 0
    || numReadonlySignerAccounts > numSignerAccounts
    || numSignerAccounts > staticAccounts.length
  ) {
    fail("receipt_mismatch");
  }
  const writableSigners = numSignerAccounts - numReadonlySignerAccounts;
  const writableNonSigners = staticAccounts.length - numSignerAccounts - numReadonlyNonSignerAccounts;
  if (writableSigners < 1 || writableNonSigners < 0) fail("receipt_mismatch");

  const roles: AccountRole[] = staticAccounts.map((address, index) => ({
    address: canonicalPublicKey(address),
    isSigner: index < numSignerAccounts,
    isWritable:
      index < writableSigners
      || (index >= numSignerAccounts && index < numSignerAccounts + writableNonSigners),
  }));

  if (message.version === "legacy" || message.version === 1) {
    if (loadedAddresses.writable.length > 0 || loadedAddresses.readonly.length > 0) fail("receipt_mismatch");
    return roles;
  }

  const lookups = message.addressTableLookups ?? [];
  const declaredWritable = lookups.reduce((total, lookup) => total + lookup.writableIndexes.length, 0);
  const declaredReadonly = lookups.reduce((total, lookup) => total + lookup.readonlyIndexes.length, 0);
  if (loadedAddresses.writable.length !== declaredWritable || loadedAddresses.readonly.length !== declaredReadonly) {
    fail("receipt_mismatch");
  }
  if (loadedAddresses.writable.length + loadedAddresses.readonly.length > MAX_LOADED_ADDRESSES) fail("receipt_mismatch");
  for (const address of [...loadedAddresses.writable, ...loadedAddresses.readonly]) canonicalPublicKey(address);
  if (roles.length + loadedAddresses.writable.length + loadedAddresses.readonly.length > MAX_ACCOUNT_KEYS) {
    fail("receipt_mismatch");
  }
  for (const address of loadedAddresses.writable) roles.push({ address, isSigner: false, isWritable: true });
  for (const address of loadedAddresses.readonly) roles.push({ address, isSigner: false, isWritable: false });
  return roles;
}

function requireAccount(
  roles: AccountRole[],
  index: number,
  expected: { address: string; isSigner: boolean; isWritable: boolean },
): void {
  const actual = roles[index];
  if (!actual) fail("receipt_mismatch");
  if (actual.address !== expected.address || actual.isSigner !== expected.isSigner || actual.isWritable !== expected.isWritable) {
    fail("receipt_mismatch");
  }
}

function loadedAddressLists(meta: Record<string, unknown>): { writable: string[]; readonly: string[] } {
  const loaded = meta.loadedAddresses;
  if (loaded === undefined) return { writable: [], readonly: [] };
  if (!isRecord(loaded)) fail("receipt_mismatch");
  const writable = loaded.writable ?? [];
  const readonly = loaded.readonly ?? [];
  if (!Array.isArray(writable) || !Array.isArray(readonly)) fail("receipt_mismatch");
  if (writable.length > MAX_LOADED_ADDRESSES || readonly.length > MAX_LOADED_ADDRESSES) fail("receipt_mismatch");
  for (const address of [...writable, ...readonly]) {
    if (typeof address !== "string") fail("receipt_mismatch");
  }
  return { writable: writable as string[], readonly: readonly as string[] };
}

// TODO(PR-09 SDK): import a shared verifyExecutePaymentSettlement helper from @chainpay/sdk when exported.
export async function validateSettlementTransaction(
  wireResult: unknown,
  proof: CustomReceiptProof,
  receipt: PaymentReceipt,
  expected: SettlementExpectation,
): Promise<void> {
  if (!isRecord(wireResult)) fail("transaction_unavailable");
  const meta = wireResult.meta;
  if (!isRecord(meta)) fail("receipt_mismatch");
  if (meta.err !== null) fail("receipt_mismatch");
  const slot = asSlot(wireResult.slot);
  if (slot !== receipt.executedAtSlot) fail("receipt_mismatch");
  const transactionField = wireResult.transaction;
  if (!Array.isArray(transactionField) || transactionField.length !== 2) fail("receipt_mismatch");
  const [wire, encoding] = transactionField;
  if (encoding !== "base64" || typeof wire !== "string" || wire.length === 0 || wire.length > MAX_BASE64_WIRE_CHARS) {
    fail("receipt_mismatch");
  }
  let decodedWire: Buffer;
  try {
    decodedWire = Buffer.from(wire, "base64");
  } catch {
    fail("receipt_mismatch");
  }
  if (decodedWire.length === 0 || decodedWire.length > MAX_WIRE_BYTES) fail("receipt_mismatch");

  let decoded: ReturnType<typeof decodeSupportedTransaction>;
  try {
    decoded = decodeSupportedTransaction(decodedWire);
  } catch {
    fail("receipt_mismatch");
  }
  const message = decoded.message as unknown as DecodedMessage;
  const signatures = decoded.transaction.signatures as Record<string, Uint8Array | null>;
  const messageBytes = Uint8Array.from(decoded.transaction.messageBytes);
  const requiredSigners = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  if (requiredSigners.length < 1) fail("receipt_mismatch");
  for (const signer of requiredSigners) {
    const signature = signatures[signer];
    if (!signature || !verifyMessageSignature(signer, messageBytes, Uint8Array.from(signature))) fail("receipt_mismatch");
  }
  const firstSignature = signatures[requiredSigners[0]];
  if (!firstSignature) fail("receipt_mismatch");
  const proofSignature = decodeCanonicalBase58(proof.payload.signature, 64);
  if (!bytesEqual(proofSignature, Uint8Array.from(firstSignature))) fail("invalid_proof");

  const roles = resolveAccounts(message, loadedAddressLists(meta));
  const instructions = compiledInstructions(message);
  let matches = 0;
  for (const instruction of instructions) {
    if (instruction.programAddressIndex < 0 || instruction.programAddressIndex >= roles.length) fail("receipt_mismatch");
    const programAddress = roles[instruction.programAddressIndex].address;
    if (programAddress !== expected.programId) continue;
    if (instruction.data.length < 8) continue;
    const discriminator = DISCRIMINATORS.executePayment;
    if (!bytesEqual(instruction.data.subarray(0, 8), discriminator)) continue;
    if (instruction.data.length !== EXECUTE_PAYMENT_DATA_LENGTH) fail("receipt_mismatch");
    if (instruction.accountIndices.length < 10 || instruction.accountIndices.length > 42) fail("receipt_mismatch");
    for (const accountIndex of instruction.accountIndices) {
      if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= roles.length) fail("receipt_mismatch");
    }
    // Outer ExecutePayment only. Inner-only ChainPay CPI is unsupported, not parsed as settlement.
    if (roles[instruction.accountIndices[3]]?.address !== receipt.address) continue;
    requireAccount(roles, instruction.accountIndices[0], { address: expected.configPda, isSigner: false, isWritable: false });
    requireAccount(roles, instruction.accountIndices[1], { address: expected.assetPda, isSigner: false, isWritable: false });
    requireAccount(roles, instruction.accountIndices[2], { address: receipt.mandate, isSigner: false, isWritable: true });
    requireAccount(roles, instruction.accountIndices[3], { address: receipt.address, isSigner: false, isWritable: true });
    requireAccount(roles, instruction.accountIndices[4], { address: expected.agent, isSigner: true, isWritable: true });
    requireAccount(roles, instruction.accountIndices[5], { address: expected.mint, isSigner: false, isWritable: false });
    requireAccount(roles, instruction.accountIndices[6], {
      address: receipt.sourceTokenAccount,
      isSigner: false,
      isWritable: true,
    });
    requireAccount(roles, instruction.accountIndices[7], { address: expected.recipient, isSigner: false, isWritable: true });
    requireAccount(roles, instruction.accountIndices[8], {
      address: expected.tokenProgram,
      isSigner: false,
      isWritable: false,
    });
    requireAccount(roles, instruction.accountIndices[9], {
      address: SYSTEM_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    });
    if (!requiredSigners.includes(expected.agent)) fail("receipt_mismatch");
    if (!bytesEqual(instruction.data.subarray(8, 40), expected.invoiceHash)) fail("receipt_mismatch");
    if (!bytesEqual(instruction.data.subarray(40, 72), expected.paymentId)) fail("receipt_mismatch");
    if (!bytesEqual(instruction.data.subarray(72, 104), expected.signatureReference)) fail("receipt_mismatch");
    const amount = new DataView(
      instruction.data.buffer,
      instruction.data.byteOffset + 104,
      8,
    ).getBigUint64(0, true);
    if (amount !== expected.amount || amount !== receipt.amount) fail("receipt_mismatch");
    matches += 1;
  }
  if (matches !== 1) fail("receipt_mismatch");
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new MerchantProofError("rpc_unavailable")), VERIFY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyMerchantProof(
  config: MerchantConfig,
  references: X402PaymentReferences,
  proof: CustomReceiptProof,
  deps: MerchantVerificationDependencies,
): Promise<VerifiedMerchantPayment> {
  const receiptAddress = proof.payload.receiptPDA;
  let receipt: PaymentReceipt | null;
  try {
    receipt = await withTimeout(deps.getFinalizedReceipt(receiptAddress));
  } catch (error) {
    if (error instanceof MerchantProofError) throw error;
    fail("rpc_unavailable");
  }
  if (!receipt) fail("receipt_not_found");
  if (receipt.status !== "confirmed" || receipt.onChainStatus !== 1) fail("receipt_mismatch");
  const derived = deriveReceiptAddress(receipt.mandate, receipt.invoiceHash, config.programId);
  if (derived !== receiptAddress || receipt.address !== receiptAddress) fail("receipt_mismatch");
  if (bytesToHex(receipt.invoiceHash) !== references.invoiceHash) fail("receipt_mismatch");
  if (bytesToHex(receipt.paymentId) !== references.paymentId) fail("receipt_mismatch");
  if (bytesToHex(receipt.signatureReference) !== references.signatureReference) fail("receipt_mismatch");
  if (receipt.mint !== config.mint) fail("receipt_mismatch");
  if (receipt.recipient !== config.recipient || receipt.recipientTokenAccount !== config.recipient) fail("receipt_mismatch");
  if (receipt.amount !== BigInt(config.amount)) fail("receipt_mismatch");
  if (receipt.agent !== config.allowedAgent) fail("receipt_mismatch");

  let wire: unknown;
  try {
    wire = await withTimeout(deps.getFinalizedTransaction(proof.payload.signature));
  } catch (error) {
    if (error instanceof MerchantProofError) throw error;
    fail("rpc_unavailable");
  }
  if (wire === null || wire === undefined) fail("transaction_unavailable");

  const tokenProgram = config.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  await validateSettlementTransaction(wire, proof, receipt, {
    programId: config.programId || DEFAULT_PROGRAM_ID,
    mint: config.mint,
    recipient: config.recipient,
    amount: BigInt(config.amount),
    agent: config.allowedAgent,
    tokenProgram,
    configPda: deriveConfigAddress(config.programId),
    assetPda: deriveAssetAddress(config.mint, config.programId),
    invoiceHash: hexToBytes(references.invoiceHash, "invoiceHash"),
    paymentId: hexToBytes(references.paymentId, "paymentId"),
    signatureReference: hexToBytes(references.signatureReference, "signatureReference"),
  });

  return {
    receipt,
    transactionSignature: proof.payload.signature,
    resource: config.resource,
  };
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) fail("rpc_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel("oversized");
      fail("rpc_unavailable");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail("rpc_unavailable");
  }
}

export function createRpcTransactionReader(rpcUrl: string): MerchantVerificationDependencies["getFinalizedTransaction"] {
  assertSafeRpcUrl(rpcUrl);
  return async (signature: string) => {
    let response: Response;
    try {
      response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 1 }],
        }),
      });
    } catch {
      fail("rpc_unavailable");
    }
    if (!response.ok) fail("rpc_unavailable");
    const envelope = await readBoundedJson(response, MAX_RPC_BYTES);
    if (!isRecord(envelope)) fail("rpc_unavailable");
    if (envelope.error !== undefined) fail("rpc_unavailable");
    if (!("result" in envelope) || envelope.result === null) fail("transaction_unavailable");
    return envelope.result;
  };
}

function assertSafeRpcUrl(rpcUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    fail("rpc_unavailable");
  }
  if (parsed.username || parsed.password) fail("rpc_unavailable");
}

export function publicProofErrorBody(error: unknown): {
  status: 402 | 503;
  body: { error: string; code: ProofErrorCategory; mode?: "unsupported-sponsor" };
} {
  const proofError = error instanceof MerchantProofError ? error : new MerchantProofError("invalid_proof");
  return {
    status: proofError.httpStatus,
    body: {
      error: proofError.publicMessage,
      code: proofError.category,
      ...(proofError.mode ? { mode: proofError.mode } : {}),
    },
  };
}

export function logSafeProofEvent(
  category: ProofErrorCategory,
  details: { receipt?: string; signature?: string } = {},
): void {
  const receipt = details.receipt ? ` receipt=${details.receipt}` : "";
  const signature = details.signature ? ` signature=${details.signature}` : "";
  process.stderr.write(`demo-merchant ${category}${receipt}${signature}\n`);
}

export function resolvePaymentHeader(headers: { payment?: string; paymentSignature?: string; paymentRequired?: string }): string | undefined {
  return headers.payment ?? headers.paymentSignature ?? headers.paymentRequired;
}

export function detectAndParsePaymentHeader(header: string): CustomReceiptProof {
  const detected = inspectPaymentHeader(header);
  if (detected.kind === "standard-v2") rejectStandardV2(detected.document);
  if (detected.kind !== "custom") fail("invalid_proof");
  return detected.proof;
}
