import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildConfirmReconciledInstruction,
  buildDisclosureBundle,
  buildInitPermissionInstruction,
  buildResolveExceptionInstruction,
  buildRestoreInstruction,
  buildSetPolicyInstruction,
  buildUnfreezeInstruction,
  buildUpdatePermissionInstruction,
  cardIdFromHex,
  CardsApiClient,
  CardsApiError,
  centsToTokenBaseUnits,
  commitmentRoot,
  decodeCardCommitment,
  decodeCardPeriod,
  decodeCardPolicy,
  deriveCardAccounts,
  DEVNET_TEE_URL,
  DELEGATION_PROGRAM_ID,
  getTeeSession,
  keypairSigner,
  loadMagicBlockIntegrityProvider,
  merchantIdHashesForRefs,
  readCardPeriod,
  readCardPolicy,
  readTeeAccount,
  toWeb3Instruction,
  toWeb3Transaction,
  verifyTee,
  walletAdapterSigner,
  type CardActivityRow,
  type CardView,
  type ChainPayInstruction,
  type PolicyArgs,
  type PreparedCard,
  type RestoreArgs,
  type TeeRead,
  type TeeSession,
} from "@chainpay/sdk";
import { authorizedFetch } from "../../session";
import { BACKEND_URL, CARD_PARTNER_TOKEN_ACCOUNT, CARD_POLICY_PROGRAM_ID, DEVNET_USDC_MINT } from "../../config/public";
import { chainpayClient } from "../../config/client";
import { sha256Hex, submitSignedTransaction } from "../../owner/runtime";
import {
  CardsNotEnabledError,
  type CardPrivateRead,
  type CardRecoveryView,
  type CardsSource,
  type CreateCardInput,
  type PrivacyCheckResult,
  type ReaderMember,
  type ReadResult,
  type RecoveryNumberKey,
  type RecoveryReport,
  RECOVERY_NUMBER_KEYS,
} from "./source";

/*
 * Live Cards source: Axum card routes through the SDK client (owner session
 * via authorizedFetch, so the session token never leaves session.ts), and
 * owner-signed card_policy instructions over the owner's own TEE connection.
 */

type McpResponse = { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };

export type LiveCardsDeps = {
  wallet: string;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<McpResponse>;
};

const NOT_ENABLED = new Set([404, 405, 501]);
const hexBytes = (value: string) => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Expected a 32-byte hex value");
  return Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
};

/** RPC errors can carry the tokenized TEE URL. Never surface them verbatim. */
function teeError(step: string): Error {
  return new Error(`The private rollup didn't accept "${step}". Nothing else was changed.`);
}

function rawOf(read: TeeRead<unknown>): string {
  if (read.state === "not_visible") return "value: null";
  if (read.state === "rpc_error") return `error: ${read.code}`;
  return "value: { … }";
}

/**
 * `getDeps` is read on every call, so a wallet adapter that attaches or
 * reconnects after the first render is used immediately (never a stale signer).
 */
export function createLiveCardsSource(getDeps: () => LiveCardsDeps): CardsSource {
  const wallet = getDeps().wallet;
  const deps = {
    get wallet() { return wallet; },
    get signTransaction() { return getDeps().signTransaction; },
    get signMessage() { return getDeps().signMessage; },
    get onCallMcp() { return getDeps().onCallMcp; },
  };
  const programId = CARD_POLICY_PROGRAM_ID;
  const api = new CardsApiClient({
    baseUrl: BACKEND_URL,
    // Placeholder: authorizedFetch replaces the header with the real session token.
    authToken: "owner-session",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => authorizedFetch(String(input), init ?? {})) as typeof fetch,
  });
  let session: TeeSession | null = null;
  /** Resumable create attempts: same Axum operation ids and skipped finished steps on "Try again". */
  const attempts = new Map<string, { prepared?: PreparedCard; baseDone: number; rulesDone: boolean; activated?: string }>();
  const ALLOWED_BASE_PROGRAMS = new Set([programId, "11111111111111111111111111111111", DELEGATION_PROGRAM_ID, "ComputeBudget111111111111111111111111111111"]);

  const accounts = (cardId: string) => deriveCardAccounts(deps.wallet, cardIdFromHex(cardId), programId);
  const cardRef = (cardId: string) => ({ owner: deps.wallet, cardId: cardIdFromHex(cardId) });

  async function guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CardsApiError && NOT_ENABLED.has(error.status)) throw new CardsNotEnabledError();
      throw error;
    }
  }

  async function ensureSession(): Promise<TeeSession> {
    if (session) return session;
    if (!deps.signMessage) throw new Error("This wallet can't sign messages, so it can't open your private card details.");
    session = await getTeeSession(walletAdapterSigner({ publicKey: deps.wallet, signMessage: deps.signMessage }), { teeUrl: DEVNET_TEE_URL });
    return session;
  }

  async function sendTee(step: string, instructions: ChainPayInstruction[]): Promise<string> {
    if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
    const tee = await ensureSession();
    let connection: Connection;
    let latest: { blockhash: string; lastValidBlockHeight: number };
    try {
      connection = new Connection(await tee.endpoint(), "confirmed");
      latest = await connection.getLatestBlockhash("confirmed");
    } catch {
      throw teeError(step);
    }
    const transaction = new Transaction({ feePayer: new PublicKey(deps.wallet), recentBlockhash: latest.blockhash }).add(...instructions.map(toWeb3Instruction));
    const signed = await deps.signTransaction(transaction);
    try {
      const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      if (result.value.err) throw new Error("rejected");
      return signature;
    } catch {
      throw teeError(step);
    }
  }

  /** Owner co-signs an authorizer-signed PER transaction after checking it is exactly one card_policy `restore` with the reviewed args. */
  async function sendCoSignedTee(step: string, encoded: string, expected: RestoreArgs, cardId: string): Promise<string> {
    if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
    const transaction = Transaction.from(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
    const want = buildRestoreInstruction({ ...cardRef(cardId), restore: expected }, programId);
    const [only] = transaction.instructions;
    const sameData = only && Buffer.from(only.data).equals(Buffer.from(want.data));
    if (transaction.instructions.length !== 1 || !only.programId.equals(new PublicKey(programId)) || !sameData) {
      throw new Error("The restore ChainPay prepared doesn't match the numbers you reviewed, so it wasn't signed.");
    }
    const tee = await ensureSession();
    const signed = await deps.signTransaction(transaction);
    try {
      const connection = new Connection(await tee.endpoint(), "confirmed");
      const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      const result = await connection.confirmTransaction(signature, "confirmed");
      if (result.value.err) throw new Error("rejected");
      return signature;
    } catch {
      throw teeError(step);
    }
  }

  function assertBaseTransaction(transaction: Transaction) {
    assertBaseTransactionWith(ALLOWED_BASE_PROGRAMS, deps.wallet, transaction);
  }

  async function readRaw(cardId: string) {
    const tee = await ensureSession();
    const a = accounts(cardId);
    const [policy, period] = await Promise.all([readTeeAccount(tee, a.policy), readTeeAccount(tee, a.period)]);
    if (policy.state !== "visible" || period.state !== "visible") throw new Error("Your private card details aren't readable right now. Try again in a moment.");
    return { policy: decodeCardPolicy(policy.account.data), period: decodeCardPeriod(period.account.data) };
  }

  async function readCommitment(cardId: string) {
    const info = await chainpayClient.connection.getAccountInfo(new PublicKey(accounts(cardId).commitment), "finalized");
    return info ? decodeCardCommitment(info.data) : null;
  }

  return {
    mode: "live",
    listCards: () => guard(async () => (await api.listCards()).cards),
    getCard: (cardId) => guard(() => api.getCard(cardId)),
    activity: (cardId) => guard(async () => (await api.getCardActivity(cardId, { limit: 100 })).rows),
    statements: (cardId) => guard(async () => (await api.listStatements(cardId)).statements),

    recovery(card): CardRecoveryView {
      const raw = card.recovery as { state?: unknown; report?: Partial<RecoveryReport> } | undefined;
      const state = raw?.state === "recovery_frozen" || raw?.state === "restored_pending_reconcile" ? raw.state : "normal";
      const report = raw?.report;
      const valid = report && typeof report.digest === "string" && /^[0-9a-f]{64}$/.test(report.digest) && Array.isArray(report.numbers);
      return valid ? { state, report: report as RecoveryReport } : { state };
    },

    async unlock() { await ensureSession(); },
    isUnlocked: () => session !== null,

    async readPrivate(card): Promise<CardPrivateRead> {
      if (!session) return { policy: { state: "not_visible", slot: null }, period: { state: "not_visible", slot: null } };
      const a = accounts(card.cardId);
      const [policy, period] = await Promise.all([readCardPolicy(session, a.policy, programId), readCardPeriod(session, a.period, programId)]);
      return { policy, period };
    },

    members(_card, read): ReaderMember[] {
      if (read?.policy.state !== "visible") return [];
      const policy = read.policy.account;
      return policy.members.map((member) => ({
        pubkey: member.pubkey,
        role: member.pubkey === deps.wallet ? "owner" : member.pubkey === policy.authorizer ? "approver" : "reader",
      }));
    },

    async createCard(input: CreateCardInput, progress, attemptId) {
      if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
      const attempt = attempts.get(attemptId) ?? { baseDone: 0, rulesDone: false };
      attempts.set(attemptId, attempt);
      progress("prepare", "active");
      // Same clientOperationId on every retry: Axum returns the same card instead of issuing a second one.
      const prepared = attempt.prepared ?? await guard(() => api.prepareCard({ label: input.label, clientOperationId: `card-prepare-${attemptId}` }));
      attempt.prepared = prepared;
      const merchantIdHashes = await merchantIdHashesForRefs(input.merchants);
      progress("prepare", "done");

      progress("base", "active");
      const encodedTxs = [prepared.initTx, prepared.delegateTx, prepared.escrowTopUpTx];
      for (let index = attempt.baseDone; index < encodedTxs.length; index += 1) {
        progress("base", "active", `Approval ${index + 1} of 3`);
        const transaction = Transaction.from(Uint8Array.from(atob(encodedTxs[index]), (char) => char.charCodeAt(0)));
        assertBaseTransaction(transaction);
        // Server-built, owner-only transactions: refresh the blockhash right before
        // signing so a slow wallet prompt can't push it past its lifetime.
        if (transaction.signatures.every((entry) => entry.publicKey.toBase58() === deps.wallet && !entry.signature)) {
          transaction.recentBlockhash = (await chainpayClient.connection.getLatestBlockhash("confirmed")).blockhash;
        }
        const signed = await deps.signTransaction(transaction);
        await submitSignedTransaction(`card-base:${prepared.cardId}:${index}`, signed.serialize());
        attempt.baseDone = index + 1;
      }
      progress("base", "done");

      progress("session", "active");
      await ensureSession();
      progress("session", "done");

      progress("rules", "active");
      if (!attempt.rulesDone) {
        const policy: PolicyArgs = {
          budgetCents: BigInt(input.budgetCents),
          maxPurchaseCents: BigInt(input.maxPurchaseCents),
          maxPurchasesPerPeriod: input.maxPurchasesPerPeriod,
          periodSeconds: input.periodDays * 86_400,
          currency: "USD",
          merchantIdHashes,
          mccs: input.mccs,
          expiresAt: input.expiresAt ? BigInt(Math.floor(Date.parse(input.expiresAt) / 1000)) : 0n,
          recurringAllowed: input.recurringAllowed,
          feeBps: input.feeBps,
          authorizer: prepared.authorizer,
        };
        const ref = cardRef(prepared.cardId);
        await sendTee("Save rules privately", [
          buildInitPermissionInstruction({ ...ref, authorizer: prepared.authorizer }, programId),
          buildSetPolicyInstruction({ ...ref, policy }, programId),
        ]);
        attempt.rulesDone = true;
      }
      progress("rules", "done");

      progress("activate", "active");
      await guard(() => api.activateCard(prepared.cardId, 1, `card-activate-${attemptId}`));
      progress("activate", "done");
      attempts.delete(attemptId);
      return prepared.cardId;
    },

    freeze: (cardId, reason, operationId) => guard(() => api.freezeCard(cardId, reason, operationId)),

    async unfreeze(card, policyVersion, operationId) {
      await sendTee("Unfreeze", [buildUnfreezeInstruction(cardRef(card.cardId), programId)]);
      return guard(() => api.unfreezeMirror(card.cardId, policyVersion, operationId));
    },

    async addReader(card, pubkey) {
      await sendTee("Add a reader", [buildUpdatePermissionInstruction({ ...cardRef(card.cardId), op: { kind: "add_reader", pubkey: new PublicKey(pubkey).toBase58() } }, programId)]);
    },
    async removeReader(card, pubkey) {
      await sendTee("Remove a reader", [buildUpdatePermissionInstruction({ ...cardRef(card.cardId), op: { kind: "remove_reader", pubkey } }, programId)]);
    },

    async resolveException(card, row: CardActivityRow) {
      const eventIdHash = row.eventIdHash;
      if (typeof eventIdHash !== "string") throw new Error("ChainPay didn't send this charge's reference, so it can't be marked reviewed yet.");
      await sendTee("Mark reviewed", [buildResolveExceptionInstruction({ ...cardRef(card.cardId), eventIdHash: hexBytes(eventIdHash), resolution: 1 }, programId)]);
    },

    repaymentTarget: () => ({ recipientTokenAccount: CARD_PARTNER_TOKEN_ACCOUNT, mint: DEVNET_USDC_MINT, decimals: 6, cluster: "devnet" }),

    async payStatement(_card, statement, mandateAddress) {
      if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
      if (!CARD_PARTNER_TOKEN_ACCOUNT) throw new Error("ChainPay hasn't set the simulated partner's account yet, so statements can't be paid.");
      if (!statement.digest) throw new Error("This statement has no reference yet.");
      const total = BigInt(statement.totalCents);
      if (total <= 0n) throw new Error("Nothing to pay on this statement.");
      // Repayment = execute_payment with invoice_hash = statement digest (contracts §7.2).
      const [paymentId, signatureReference] = await Promise.all([sha256Hex(`${statement.digest}:payment`), sha256Hex(`${statement.digest}:signature`)]);
      const prepared = await chainpayClient.preparePayment({
        mandate: mandateAddress,
        invoiceHash: hexBytes(statement.digest),
        paymentId: hexBytes(paymentId),
        signatureReference: hexBytes(signatureReference),
        mint: DEVNET_USDC_MINT,
        recipient: CARD_PARTNER_TOKEN_ACCOUNT,
        amount: centsToTokenBaseUnits(total, 6),
      }, deps.wallet);
      if (!prepared.preflight.valid) throw new Error(prepared.preflight.checks.filter((check) => !check.ok).map((check) => check.message).join(" · ") || "This spending permission can't pay the statement.");
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await deps.signTransaction(toWeb3Transaction(prepared.transaction, latest.blockhash));
      const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await deps.onCallMcp("execute_payment", {
        mandate: prepared.request.mandate,
        agent: deps.wallet,
        invoiceHash: hex(prepared.request.invoiceHash),
        paymentId: hex(prepared.request.paymentId),
        signatureReference: hex(prepared.request.signatureReference),
        mint: prepared.request.mint,
        recipient: prepared.request.recipient,
        amount: prepared.request.amount.toString(),
        signingMode: "human",
        ...(prepared.request.tokenProgram ? { tokenProgram: prepared.request.tokenProgram } : {}),
        signedTransaction: btoa(String.fromCharCode(...signed.serialize())),
      });
      const body = result.structuredContent as { status?: string; signature?: string; receiptAddress?: string; error?: string } | undefined;
      if (result.isError || body?.status !== "confirmed" || body.receiptAddress !== prepared.receiptAddress) {
        throw new Error(body?.error ?? "The payment wasn't confirmed. Check Payments before trying again.");
      }
      return { receiptPda: prepared.receiptAddress, mandatePda: mandateAddress, signature: body.signature };
    },

    submitRepayment: (cardId, statementId, input) => guard(() => api.submitRepayment(cardId, statementId, { ...input, cluster: "devnet" })),

    async restore(card, report) {
      const prepared = await guard(() => api.prepareRestore(card.cardId, { clientOperationId: `card-restore-${report.digest.slice(0, 32)}`, reconReportDigest: report.digest }));
      // card_policy (Lane 1 review fix) requires owner + authorizer co-sign on restore.
      // Axum returns the PER transaction already signed by the authorizer; the owner
      // checks it carries exactly the reviewed values, adds a signature and sends it.
      if (typeof prepared.transaction === "string") {
        await sendCoSignedTee("Approve restore", prepared.transaction, parseRestoreArgs(prepared, report), card.cardId);
        return;
      }
      await sendTee("Approve restore", [buildRestoreInstruction({ ...cardRef(card.cardId), restore: parseRestoreArgs(prepared, report) }, programId)]);
    },

    async confirmReconciled(card, report) {
      await sendTee("Confirm it all matches", [buildConfirmReconciledInstruction({ ...cardRef(card.cardId), reconDigest: hexBytes(report.digest) }, programId)]);
    },

    async privacyCheck(card): Promise<PrivacyCheckResult> {
      const owner = await ensureSession();
      const a = accounts(card.cardId);
      const ownerReads = await Promise.all([readCardPolicy(owner, a.policy, programId), readCardPeriod(owner, a.period, programId)]);
      const strangerKey = Keypair.generate();
      const stranger = await getTeeSession(await keypairSigner(strangerKey.secretKey), { teeUrl: DEVNET_TEE_URL });
      strangerKey.secretKey.fill(0);
      const strangerReads = await Promise.all([readTeeAccount(stranger, a.policy), readTeeAccount(stranger, a.period)]);
      const labels = ["Card rules", "This period"];
      const toResult = (read: TeeRead<unknown>, i: number, summary?: string): ReadResult => ({ label: labels[i], state: read.state, raw: rawOf(read), summary });
      const policyRead = ownerReads[0];

      let publicChain: PrivacyCheckResult["publicChain"];
      try {
        const info = await chainpayClient.connection.getAccountInfo(new PublicKey(a.policy), "confirmed");
        if (!info) throw Object.assign(new Error("missing"), { missing: true });
        const data = info.data;
        const after = Array.from(data.slice(8 + 64));
        const nonZero = after.filter((byte) => byte !== 0).length;
        publicChain = { address: a.policy, bytes: data.length, nonZeroAfterOwnerLink: nonZero, preview: `card + owner link, then ${after.length - nonZero} zero bytes`, state: nonZero === 0 ? "empty" : "has_data" };
      } catch (error) {
        // A missing account proves nothing about privacy; never report it as "no limits".
        publicChain = { address: a.policy, bytes: 0, nonZeroAfterOwnerLink: 0, preview: "", state: (error as { missing?: boolean }).missing ? "missing" : "rpc_error" };
      }

      let attestation: PrivacyCheckResult["attestation"];
      try {
        const provider = await loadMagicBlockIntegrityProvider();
        const result = await verifyTee({ mode: "report", teeUrl: DEVNET_TEE_URL, provider });
        attestation = { hardware: result.hardware, measurements: result.measurements, label: result.label };
      } catch {
        attestation = { hardware: "not_checked", measurements: "unavailable", label: "This browser can't run the hardware check. ChainPay's server runs it every 10 minutes." };
      }

      return {
        checkedAt: new Date().toISOString(),
        owner: ownerReads.map((read, i) => toResult(read, i, i === 0 && policyRead.state === "visible" ? `Rules version ${policyRead.account.policyVersion}` : undefined)),
        stranger: { wallet: stranger.wallet, reads: strangerReads.map((read, i) => toResult(read, i)) },
        publicChain,
        attestation,
      };
    },

    async disclose(card, indices) {
      const { policy, period } = await readRaw(card.cardId);
      const commitment = await readCommitment(card.cardId);
      if (!commitment) throw new Error("This card has no public checkpoint yet.");
      // The salt for the latest checkpoint lives in the owner's encrypted recovery record.
      const response = await authorizedFetch(`${BACKEND_URL.replace(/\/$/, "")}/v1/cards/${card.cardId}/disclosure-salt?seq=${commitment.seq}`, { method: "GET" });
      if (NOT_ENABLED.has(response.status)) throw new Error("Sharing card records needs a ChainPay service that isn't live yet.");
      if (!response.ok) throw new Error("ChainPay couldn't open this card's sharing key.");
      const body = await response.json() as { masterSalt?: unknown };
      if (typeof body.masterSalt !== "string") throw new Error("ChainPay sent an unexpected sharing key.");
      const masterSalt = hexBytes(body.masterSalt);
      try {
        const root = await commitmentRoot(policy, period, masterSalt);
        if (Array.from(root).join() !== Array.from(commitment.root).join()) {
          throw new Error("This card changed since its last public checkpoint. Try again after the next one, within 15 minutes.");
        }
        return await buildDisclosureBundle({ policy, period, masterSalt, commitmentSeq: commitment.seq, indices });
      } finally {
        masterSalt.fill(0);
      }
    },
  };
}

/** Axum's prepared restore args (cent strings, hex hashes) → SDK RestoreArgs. Anything unexpected stops the restore. */
export function parseRestoreArgs(value: Record<string, unknown>, report: RecoveryReport): RestoreArgs {
  const reconDigest = report.digest;
  const cents = (v: unknown, name: string) => {
    if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(v)) throw new Error(`Restore value "${name}" is malformed`);
    return BigInt(v);
  };
  const int = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`Restore value "${name}" is malformed`);
    return v;
  };
  const p = value.policy as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") throw new Error("Restore values are missing the card's rules");
  if (value.reconDigest !== reconDigest) throw new Error("Restore values don't match the report you reviewed");
  const args: RestoreArgs = {
    policy: {
      budgetCents: cents(p.budgetCents, "budget"),
      maxPurchaseCents: cents(p.maxPurchaseCents, "max purchase"),
      maxPurchasesPerPeriod: int(p.maxPurchasesPerPeriod, "purchase count"),
      periodSeconds: int(p.periodSeconds, "period"),
      currency: "USD",
      merchantIdHashes: (Array.isArray(p.merchantIdHashes) ? p.merchantIdHashes : []).map((h) => hexBytesStrict(h)),
      mccs: (Array.isArray(p.mccs) ? p.mccs : []).map((m) => int(m, "category")),
      expiresAt: BigInt(int(p.expiresAt ?? 0, "end date")),
      recurringAllowed: p.recurringAllowed === true,
      feeBps: int(p.feeBps, "fee"),
      authorizer: new PublicKey(String(p.authorizer)).toBase58(),
    },
    periodIndex: int(value.periodIndex, "period number"),
    capturedCents: cents(value.capturedCents, "charged"),
    reservedCents: cents(value.reservedCents, "held"),
    refundedCents: cents(value.refundedCents, "refunded"),
    purchasesCount: int(value.purchasesCount, "purchases"),
    statementOutstandingCents: cents(value.statementOutstandingCents, "owed"),
    ledgerHead: hexBytesStrict(value.ledgerHead),
    ledgerSeq: cents(value.ledgerSeq, "log position"),
    reconDigest: hexBytesStrict(reconDigest),
  };
  assertRestoreMatchesReport(args, report);
  return args;
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
    outstanding: args.statementOutstandingCents.toString(),
  };
  for (const key of RECOVERY_NUMBER_KEYS) {
    if (shown.get(key) !== signed[key]) throw new Error("The restore ChainPay prepared doesn't match the numbers you reviewed, so it wasn't signed.");
  }
}

function assertBaseTransactionWith(allowed: Set<string>, owner: string, transaction: Transaction): void {
  if (!transaction.feePayer || transaction.feePayer.toBase58() !== owner) throw new Error("ChainPay sent a card setup step paid by another wallet, so it wasn't signed.");
  for (const instruction of transaction.instructions) {
    if (!allowed.has(instruction.programId.toBase58())) throw new Error("ChainPay sent a card setup step for an unexpected program, so it wasn't signed.");
  }
}

function hexBytesStrict(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Restore hash is malformed");
  return Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
}
