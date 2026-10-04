import { PublicKey, type Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  buildDelegateCardInstruction,
  buildInitCardInstruction,
  buildRestoreInstruction,
  cardIdFromHex,
  CARD_ISSUER,
  decodeCardInstructionData,
  deriveCardAccounts,
  DELEGATION_PROGRAM_ID,
  type CardPeriod,
  type CardPolicyView,
  type ChainPayInstruction,
  type PreparedCard,
  type RestoreArgs,
} from "@chainpay/sdk";
import { RECOVERY_NUMBER_KEYS, type RecoveryNumberKey, type RecoveryReport, type RecoveryRules } from "./source";

/*
 * Checks on server-built transactions, run in the owner's browser before the
 * wallet is asked to sign. Each one decodes what will actually be signed and
 * refuses anything but the exact instruction the owner was told about.
 */

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** Axum's `program::PREFUND_LAMPORTS` and `ESCROW_TOP_UP_LAMPORTS`. A larger amount is refused, never signed. */
export const MAX_PREFUND_LAMPORTS = 5_000_000n;
export const MAX_ESCROW_TOP_UP_LAMPORTS = 20_000_000n;
/** Delegation program `top_up_ephemeral_balance` discriminator (u64 LE 9) and the card escrow index. */
const TOP_UP_DISCRIMINATOR = 9n;
const ESCROW_INDEX = 255;

const SETUP_REFUSED = "ChainPay sent a card setup step that does something other than set up this card, so it wasn't signed.";
const RESTORE_MISMATCH = "The restore ChainPay prepared doesn't match the numbers you reviewed, so it wasn't signed.";

/**
 * One instruction equals the one we build ourselves: program, every account in
 * order with its signer flag and writable flag, and the data byte for byte.
 * A deserialized transaction marks the fee payer (the owner) writable, so only
 * the owner's writable flag is not compared.
 */
function sameInstruction(actual: TransactionInstruction, want: ChainPayInstruction, owner: string): boolean {
  if (actual.programId.toBase58() !== want.programId) return false;
  if (actual.keys.length !== want.keys.length) return false;
  const keysMatch = want.keys.every((key, i) => {
    const got = actual.keys[i];
    return got.pubkey.toBase58() === key.address && got.isSigner === key.isSigner && (key.address === owner || got.isWritable === key.isWritable);
  });
  return keysMatch && Buffer.from(actual.data).equals(Buffer.from(want.data));
}

function onlyInstruction(transaction: Transaction, owner: string, refused: string): TransactionInstruction {
  if (!transaction.feePayer || transaction.feePayer.toBase58() !== owner) throw new Error(refused);
  // Exactly one instruction: no compute-budget price, no transfer riding along.
  if (transaction.instructions.length !== 1) throw new Error(refused);
  // The owner is the only signer the transaction may ask for.
  if (transaction.signatures.some((entry) => entry.publicKey.toBase58() !== owner && entry.signature === null)) throw new Error(refused);
  return transaction.instructions[0];
}

/**
 * The 3 card setup transactions, each checked against the exact instruction for
 * THIS card: 0 `init_card`, 1 `delegate_card` to an allowed TEE validator,
 * 2 one escrow top-up into this card's own escrow, capped. A transfer, a close,
 * an undelegate or anything aimed at another card is refused.
 */
export function assertCardSetupTransaction(transaction: Transaction, step: number, input: { owner: string; prepared: PreparedCard; programId: string }): void {
  const { owner, prepared, programId } = input;
  const only = onlyInstruction(transaction, owner, SETUP_REFUSED);
  let cardId: Uint8Array;
  try {
    cardId = cardIdFromHex(prepared.cardId);
  } catch {
    throw new Error(SETUP_REFUSED);
  }
  const accounts = deriveCardAccounts(owner, cardId, programId);
  const served = prepared.accounts;
  if (!served || served.binding !== accounts.binding || served.policy !== accounts.policy || served.period !== accounts.period || served.commitment !== accounts.commitment || served.escrow !== accounts.escrow) {
    throw new Error(SETUP_REFUSED);
  }

  if (step === 0 || step === 1) {
    let decoded: ReturnType<typeof decodeCardInstructionData>;
    try {
      decoded = decodeCardInstructionData(only.data);
    } catch {
      throw new Error(SETUP_REFUSED);
    }
    let want: ChainPayInstruction;
    try {
      if (step === 0) {
        if (decoded.name !== "initCard") throw new Error("wrong");
        const args = decoded.args;
        const issuers: number[] = Object.values(CARD_ISSUER);
        if (bytesToHexLower(args.cardId) !== bytesToHexLower(cardId) || !issuers.includes(args.issuer)) throw new Error("wrong");
        if (args.prefundLamports > MAX_PREFUND_LAMPORTS || args.prefundLamports.toString() !== String(prepared.prefundLamports)) throw new Error("wrong");
        want = buildInitCardInstruction({ owner, cardId, issuer: args.issuer, issuerCardRefHash: args.issuerCardRefHash, prefundLamports: args.prefundLamports }, programId);
      } else {
        if (decoded.name !== "delegateCard" || decoded.args.validator !== prepared.teeValidator) throw new Error("wrong");
        // Throws for a validator outside the TEE allowlist.
        want = buildDelegateCardInstruction({ owner, cardId, validator: decoded.args.validator }, programId);
      }
    } catch {
      throw new Error(SETUP_REFUSED);
    }
    if (!sameInstruction(only, want, owner)) throw new Error(SETUP_REFUSED);
    return;
  }

  if (step === 2) {
    const data = Buffer.from(only.data);
    if (only.programId.toBase58() !== DELEGATION_PROGRAM_ID || data.length !== 17) throw new Error(SETUP_REFUSED);
    const lamports = data.readBigUInt64LE(8);
    if (data.readBigUInt64LE(0) !== TOP_UP_DISCRIMINATOR || data[16] !== ESCROW_INDEX || lamports <= 0n || lamports > MAX_ESCROW_TOP_UP_LAMPORTS) throw new Error(SETUP_REFUSED);
    const want: ChainPayInstruction = {
      name: "top_up_escrow",
      programId: DELEGATION_PROGRAM_ID,
      keys: [
        { address: owner, isSigner: true, isWritable: true },
        { address: accounts.policy, isSigner: false, isWritable: false },
        { address: accounts.escrow, isSigner: false, isWritable: true },
        { address: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Uint8Array.from(data),
    };
    if (!sameInstruction(only, want, owner)) throw new Error(SETUP_REFUSED);
    return;
  }
  throw new Error(SETUP_REFUSED);
}

function bytesToHexLower(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every value the restore writes must equal a number the owner was shown (report.numbers). */
export function assertRestoreMatchesReport(args: RestoreArgs, report: RecoveryReport): void {
  const shown = new Map(report.numbers.map((row) => [row.key, row.cents ?? (row.count === undefined ? undefined : String(row.count))]));
  const signed: Record<RecoveryNumberKey, string> = {
    budget: args.policy.budgetCents.toString(),
    captured: args.capturedCents.toString(),
    reserved: args.reservedCents.toString(),
    refunded: args.refundedCents.toString(),
    purchases: String(args.purchasesCount),
    exceptions: args.exceptionCents.toString(),
    outstanding: args.statementOutstandingCents.toString(),
  };
  for (const key of RECOVERY_NUMBER_KEYS) {
    if (shown.get(key) !== signed[key]) throw new Error(RESTORE_MISMATCH);
  }
}

/** Card rules as the owner's own private records hold them (TEE read through the owner's session). */
export function rulesFromPolicy(policy: CardPolicyView, period?: CardPeriod | null): RecoveryRules {
  const expires = policy.expiresAt === null ? "0" : policy.expiresAt.startsWith("unix:") ? policy.expiresAt.slice(5) : String(Math.floor(Date.parse(policy.expiresAt) / 1000));
  return {
    maxPurchaseCents: policy.maxPurchaseCents,
    maxPurchasesPerPeriod: policy.maxPurchasesPerPeriod,
    periodSeconds: policy.periodSeconds,
    currency: policy.currency,
    merchantIdHashes: [...policy.merchantIdHashes],
    mccs: [...policy.mccs],
    expiresAt: expires,
    recurringAllowed: policy.recurringAllowed,
    feeBps: policy.feeBps,
    authorizer: policy.authorizer,
    ...(period ? { periodIndex: period.periodIndex } : {}),
  };
}

const RULE_NAMES: Record<keyof Omit<RecoveryRules, "periodIndex">, string> = {
  maxPurchaseCents: "max per purchase",
  maxPurchasesPerPeriod: "purchases per period",
  periodSeconds: "period length",
  currency: "currency",
  merchantIdHashes: "shops",
  mccs: "categories",
  expiresAt: "end date",
  recurringAllowed: "repeat charges",
  feeBps: "fee",
  authorizer: "ChainPay approver",
};

const sortedHex = (values: string[]) => values.map((value) => value.toLowerCase()).sort().join(",");
const sortedNumbers = (values: number[]) => [...values].sort((a, b) => a - b).join(",");

/** Plain names of the rules two sets disagree on. Shop and category lists compare as sets (order has no effect on-chain). */
export function rulesDifferences(a: RecoveryRules, b: RecoveryRules): string[] {
  const differs: Record<keyof typeof RULE_NAMES, boolean> = {
    maxPurchaseCents: a.maxPurchaseCents !== b.maxPurchaseCents,
    maxPurchasesPerPeriod: a.maxPurchasesPerPeriod !== b.maxPurchasesPerPeriod,
    periodSeconds: a.periodSeconds !== b.periodSeconds,
    currency: a.currency !== b.currency,
    merchantIdHashes: a.merchantIdHashes.length !== b.merchantIdHashes.length || sortedHex(a.merchantIdHashes) !== sortedHex(b.merchantIdHashes),
    mccs: a.mccs.length !== b.mccs.length || sortedNumbers(a.mccs) !== sortedNumbers(b.mccs),
    expiresAt: a.expiresAt !== b.expiresAt,
    recurringAllowed: a.recurringAllowed !== b.recurringAllowed,
    feeBps: a.feeBps !== b.feeBps,
    authorizer: a.authorizer !== b.authorizer,
  };
  return (Object.keys(RULE_NAMES) as (keyof typeof RULE_NAMES)[]).filter((key) => differs[key]).map((key) => RULE_NAMES[key]);
}

export type ReviewedRestore = { rules: RecoveryRules; periodIndex: number };

/**
 * What the restore may write besides the reviewed numbers: the card's rules and
 * period. The owner's own private records are the anchor; ChainPay's report must
 * agree with them when both exist. With neither, nothing can be checked, so
 * nothing is signed.
 */
export function reviewedRestore(report: RecoveryReport, current: { policy: CardPolicyView | null; period: CardPeriod | null }): ReviewedRestore {
  const mine = current.policy ? rulesFromPolicy(current.policy, current.period) : null;
  const theirs = report.rules ?? null;
  if (mine && theirs) {
    const differs = rulesDifferences(mine, theirs);
    if (differs.length) throw new Error(`ChainPay's report shows different card rules than your private records (${differs.join(", ")}), so nothing was signed.`);
  }
  const rules = mine ?? theirs;
  if (!rules) throw new Error("ChainPay's report doesn't show this card's rules and your private records can't be read, so the restore can't be checked. Nothing was signed.");
  const periodIndex = theirs?.periodIndex ?? mine?.periodIndex;
  if (periodIndex === undefined) throw new Error("ChainPay's report doesn't say which period it restores, so nothing was signed.");
  return { rules, periodIndex };
}

/**
 * The co-signed restore must be exactly one card_policy `restore` for this card,
 * paid by the owner, already signed by an authorizer other than the owner, with
 * the account list the program expects. Every value it writes must equal what
 * the owner reviewed: the 7 numbers, and every rule the program stores (max
 * purchase, purchase count, period, currency, shops, categories, end date,
 * repeat charges, fee, the ChainPay approver key) plus the period. The ledger
 * position may not go back before the reviewed snapshot. Checks what will
 * actually be signed.
 */
export function assertCoSignedRestore(transaction: Transaction, input: { owner: string; cardId: Uint8Array; programId: string; report: RecoveryReport; reviewed: ReviewedRestore }): RestoreArgs {
  const [only] = transaction.instructions;
  if (transaction.instructions.length !== 1 || !only.programId.equals(new PublicKey(input.programId))) throw new Error(RESTORE_MISMATCH);
  if (!transaction.feePayer || transaction.feePayer.toBase58() !== input.owner) throw new Error(RESTORE_MISMATCH);
  let decoded: ReturnType<typeof decodeCardInstructionData>;
  try {
    decoded = decodeCardInstructionData(only.data);
  } catch {
    throw new Error(RESTORE_MISMATCH);
  }
  if (decoded.name !== "restore") throw new Error(RESTORE_MISMATCH);
  const args = decoded.args.restore;
  if (bytesToHexLower(args.reconDigest) !== input.report.digest) throw new Error(RESTORE_MISMATCH);
  assertRestoreMatchesReport(args, input.report);

  const reviewed = input.reviewed.rules;
  const signedRules: RecoveryRules = {
    maxPurchaseCents: args.policy.maxPurchaseCents.toString(),
    maxPurchasesPerPeriod: args.policy.maxPurchasesPerPeriod,
    periodSeconds: args.policy.periodSeconds,
    currency: args.policy.currency,
    merchantIdHashes: args.policy.merchantIdHashes.map(bytesToHexLower),
    mccs: [...args.policy.mccs],
    expiresAt: args.policy.expiresAt.toString(),
    recurringAllowed: args.policy.recurringAllowed,
    feeBps: args.policy.feeBps,
    authorizer: args.policy.authorizer,
  };
  const differs = rulesDifferences(signedRules, reviewed);
  if (args.periodIndex !== input.reviewed.periodIndex) differs.push("period");
  if (differs.length) throw new Error(`The restore ChainPay prepared changes ${differs.join(", ")}, which you didn't review, so it wasn't signed.`);
  let snapshotSeq: bigint;
  try {
    snapshotSeq = BigInt(input.report.snapshotLedgerSeq);
  } catch {
    throw new Error(RESTORE_MISMATCH);
  }
  if (args.ledgerSeq < snapshotSeq) throw new Error(RESTORE_MISMATCH);

  // The co-signer is the approver the owner's card already names, never a new key.
  const authorizer = only.keys[1]?.pubkey.toBase58();
  if (!authorizer || authorizer === input.owner || authorizer !== reviewed.authorizer || args.policy.authorizer !== reviewed.authorizer) throw new Error(RESTORE_MISMATCH);
  const want = buildRestoreInstruction({ owner: input.owner, cardId: input.cardId, authorizer, restore: args }, input.programId);
  if (!sameInstruction(only, want, input.owner)) throw new Error(RESTORE_MISMATCH);
  const authorizerSigned = transaction.signatures.some((entry) => entry.publicKey.toBase58() === authorizer && entry.signature !== null);
  if (!authorizerSigned) throw new Error("ChainPay's half of the restore isn't signed yet, so it wasn't signed.");
  return args;
}
