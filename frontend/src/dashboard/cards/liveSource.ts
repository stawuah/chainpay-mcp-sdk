import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildConfirmReconciledInstruction,
  buildDisclosureBundle,
  buildInitPermissionInstruction,
  buildResolveExceptionInstruction,
  buildRestoreInstruction,
  decodeCardInstructionData,
  buildSetPolicyInstruction,
  buildUnfreezeInstruction,
  buildUpdatePermissionInstruction,
  cardIdFromHex,
  CardsApiClient,
  CardsApiError,
  centsToTokenBaseUnits,
  CARD_POLICY_LENGTH,
  commitmentRoot,
  decodeCardCommitment,
  decodeCardPeriod,
  decodeCardPolicy,
  deriveCardAccounts,
  DEVNET_TEE_URL,
  DELEGATION_PROGRAM_ID,
  getTeeSession,
  keypairSigner,
  readCardPeriod,
  readCardPolicy,
  readTeeAccount,
  toWeb3Instruction,
  toWeb3Transaction,
  walletAdapterSigner,
  type CardActivityRow,
  type CardMerchantListing,
  type CardView,
  type StatementView,
  type ChainPayInstruction,
  type PolicyArgs,
  type PreparedCard,
  type RestoreArgs,
  type TeeRead,
  type TeeSession,
} from "@chainpay/sdk";
import { authorizedFetch } from "../../session";
import { BACKEND_URL, CARD_PARTNER_TOKEN_ACCOUNT, CARD_POLICY_PROGRAM_ID, DEVNET_USDC_MINT, MCP_URL } from "../../config/public";
import { registerMcpConnection } from "../../owner/runtime";
import { payStatementPrivately, preparePrivateRepayment, submitPrivateRepayment, waitForPrivateRepayment, type ChainPayRoutesOptions } from "@chainpay/sdk/cards/private-repayment";
import { chainpayClient } from "../../config/client";
import { sha256Hex, submitSignedTransaction } from "../../owner/runtime";
import { checkTeeAttestation } from "./teeAttestation";
import { statementAmountDue } from "./statementMath";
import {
  CardsNotEnabledError,
  CARD_AGENT_TOOLS,
  type CardPrivateRead,
  type CardShop,
  type CardStatements,
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

  /** Owner co-signs an authorizer-signed PER transaction after checking it is exactly one card_policy `restore` with the reviewed values. */
  async function sendCoSignedTee(step: string, encoded: string, report: RecoveryReport, cardId: string): Promise<string> {
    if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
    const transaction = Transaction.from(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
    assertCoSignedRestore(transaction, { ...cardRef(cardId), programId, report });
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

  let merchantList: Promise<CardMerchantListing[]> | null = null;
  /** Axum's shop registry is the source of truth for allowlist hashes; fetched once, refetched after a failure. */
  function listMerchants(): Promise<CardMerchantListing[]> {
    merchantList ??= guard(() => api.listMerchants()).catch((error) => { merchantList = null; throw error; });
    return merchantList;
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
    statements: (cardId) => guard(async (): Promise<CardStatements> => {
      const list = await api.listStatements(cardId);
      return { closed: (list.statements ?? []).map(normalizeStatement), open: list.open ?? null };
    }),
    async closeStatement(cardId, operationId) {
      await guard(() => api.closeStatement(cardId, operationId));
    },
    async merchants(): Promise<CardShop[]> {
      return (await listMerchants()).map((m) => ({ ref: m.merchantRef, displayName: m.displayName, mcc: m.mcc, merchantIdHash: m.merchantIdHash }));
    },
    async connectAgent(cardId, agentName) {
      const name = agentName.trim();
      if (!name || name.length > 60) throw new Error("Give the agent a name (up to 60 characters).");
      // Cards-only scope: checkout, activity and statement reads for this one card. The MCP
      // server confirms the card is this owner's before it stores the connection.
      const scope = JSON.stringify({ version: 1, mandates: [], agents: {}, cards: [cardId], tools: [...CARD_AGENT_TOOLS] });
      const { connection, token } = await registerMcpConnection(deps.wallet, name, scope);
      return { id: connection.id, agentName: connection.agentName || name, token, mcpUrl: MCP_URL, tools: [...CARD_AGENT_TOOLS] };
    },

    recovery(card): CardRecoveryView {
      return recoveryView(card);
    },

    async requestRecoveryReport(card) {
      const prepared = await guard(() => api.prepareRestore(card.cardId, { clientOperationId: `card-recovery-report-${card.cardId.slice(0, 16)}-${Date.now()}` }));
      if (prepared.state !== "review_required") throw new Error("ChainPay sent an unexpected recovery answer. Nothing was signed.");
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
      const registry = await listMerchants();
      const merchantIdHashes = input.merchants.map((ref) => {
        const shop = registry.find((m) => m.merchantRef === ref);
        if (!shop) throw new Error(`"${ref}" isn't a shop ChainPay can check out at, so nothing was signed.`);
        return hexBytes(shop.merchantIdHash);
      });
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
        await submitSignedTransaction(`card-base:${prepared.cardId}:${index}`, signed.serialize(), { dismissOnConfirm: true });
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
    cardNumberSession: (cardId) => guard(() => api.createEmbedSession(cardId)),

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

    repaymentTarget: (statement) => repaymentTargetFor(statement),

    async payStatement(_card, statement, mandateAddress) {
      if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
      const target = repaymentTargetFor(statement);
      if (!target.recipientTokenAccount) throw new Error("ChainPay hasn't set the simulated partner's account yet, so statements can't be paid.");
      if (target.conflict) throw new Error(target.conflict);
      if (!statement.digest) throw new Error("This statement has no reference yet.");
      const total = statementAmountDue(statement);
      if (total <= 0n) throw new Error("Nothing to pay on this statement.");
      // Repayment = execute_payment with invoice_hash = statement digest (contracts §7.2).
      const [paymentId, signatureReference] = await Promise.all([sha256Hex(`${statement.digest}:payment`), sha256Hex(`${statement.digest}:signature`)]);
      const prepared = await chainpayClient.preparePayment({
        mandate: mandateAddress,
        invoiceHash: hexBytes(statement.digest),
        paymentId: hexBytes(paymentId),
        signatureReference: hexBytes(signatureReference),
        mint: target.mint,
        recipient: target.recipientTokenAccount,
        amount: centsToTokenBaseUnits(total, target.decimals),
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

    privateRepay(card, statement) {
      if (!statement.payPrivately || statement.payPrivately.payerVerified !== false) return null;
      // Owner session only, through authorizedFetch (the token never leaves session.ts).
      const routes: ChainPayRoutesOptions = {
        baseUrl: BACKEND_URL,
        ownerSession: "owner-session",
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => authorizedFetch(String(input), init ?? {})) as typeof fetch,
      };
      const attemptOp = `card-private-repay-${statement.statementId.slice(-24).replace(/[^A-Za-z0-9_.:-]/g, "")}`;
      return {
        prepare: () => preparePrivateRepayment(routes, card.cardId, statement.statementId, attemptOp),
        check: (attempt) => submitPrivateRepayment(routes, card.cardId, statement.statementId, attempt.attemptId),
        wait: (attempt) => waitForPrivateRepayment(routes, card.cardId, statement.statementId, attempt.attemptId),
        pay: async (attempt) => {
          const signTransaction = deps.signTransaction;
          const signMessage = deps.signMessage;
          if (!signTransaction || !signMessage) throw new Error("This wallet can't sign the private payment.");
          const result = await payStatementPrivately({
            attempt,
            signer: {
              publicKey: deps.wallet,
              signMessage,
              async signTransaction(b64) {
                // MagicBlock builds legacy transactions on Devnet (no lookup tables).
                const signed = await signTransaction(Transaction.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
                return btoa(String.fromCharCode(...signed.serialize({ requireAllSignatures: false })));
              },
            },
            sendBase: async (signedB64, built) => {
              const signature = await chainpayClient.connection.sendRawTransaction(Uint8Array.from(atob(signedB64), (c) => c.charCodeAt(0)));
              await chainpayClient.connection.confirmTransaction({ signature, blockhash: built.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
              return signature;
            },
          });
          return { transferOutcome: result.transferOutcome };
        },
      };
    },

    submitRepayment: (cardId, statementId, input) => guard(() => api.submitRepayment(cardId, statementId, { ...input, cluster: "devnet" })),

    async restore(card, report) {
      // A restore that already landed (recovery_state 2) is never signed twice: go straight to replay.
      const current = await ensureSession().then((tee) => readCardPolicy(tee, accounts(card.cardId).policy, programId)).catch(() => null);
      const alreadyRestored = current?.state === "visible" && current.account.recoveryState === "restored_pending_reconcile";
      if (!alreadyRestored) {
        const prepared = await guard(() => api.prepareRestore(card.cardId, { clientOperationId: `card-restore-${report.digest.slice(0, 32)}`, reconReportDigest: report.digest }));
        if (prepared.state !== "ready_to_sign") {
          throw new Error("ChainPay's numbers changed since you reviewed them, so nothing was signed. Review the new numbers and try again.");
        }
        // card_policy requires owner + authorizer co-sign on restore, so there is no
        // owner-only path. Axum returns the PER transaction already signed by the
        // authorizer (`restoreTx`, nothing else is accepted); the owner checks it
        // writes exactly the reviewed values, adds a signature and sends it.
        if (typeof prepared.restoreTx !== "string" || !prepared.restoreTx) throw new Error("ChainPay didn't return the co-signed restore yet. Nothing was signed; try again in a moment.");
        await sendCoSignedTee("Approve restore", prepared.restoreTx, report, card.cardId);
      }
      // Replay issuer events ChainPay never applied; the card stays frozen.
      await guard(() => api.reconcileRecovery(card.cardId, `card-reconcile-${report.digest.slice(0, 32)}`));
    },

    async confirmReconciled(card, report) {
      // Re-run the replay (idempotent) so nothing the issuer did since the restore is missed,
      // and refuse to confirm a digest other than the one the owner reviewed.
      const replay = await guard(() => api.reconcileRecovery(card.cardId, `card-reconcile-${report.digest.slice(0, 32)}`));
      if (replay.reconDigest !== report.digest) throw new Error("The restore on the private rollup doesn't match the numbers you reviewed, so nothing was confirmed.");
      // The owner's own instruction, built here, never the server-built transaction.
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
        // The last byte of the base layout is the account's PDA bump, which anyone can derive
        // from its public address. It is excluded only when it equals the canonical bump.
        const bumpOffset = CARD_POLICY_LENGTH - 1 - (8 + 64);
        const [, canonicalBump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("card_policy"), new PublicKey(a.binding).toBytes()], new PublicKey(programId));
        const bumpIsCanonical = after[bumpOffset] === canonicalBump;
        const nonZero = after.filter((byte, i) => byte !== 0 && !(i === bumpOffset && bumpIsCanonical)).length;
        const zeros = after.length - nonZero - (bumpIsCanonical ? 1 : 0);
        publicChain = { address: a.policy, bytes: data.length, nonZeroAfterOwnerLink: nonZero, preview: `card + owner link${bumpIsCanonical ? " + address bump" : ""}, then ${zeros} zero bytes`, state: nonZero === 0 ? "empty" : "has_data" };
      } catch (error) {
        // A missing account proves nothing about privacy; never report it as "no limits".
        publicChain = { address: a.policy, bytes: 0, nonZeroAfterOwnerLink: 0, preview: "", state: (error as { missing?: boolean }).missing ? "missing" : "rpc_error" };
      }

      let attestation: PrivacyCheckResult["attestation"];
      try {
        attestation = await checkTeeAttestation();
      } catch {
        attestation = { hardware: "not_checked", measurements: "unavailable", label: "This browser couldn't run the hardware check" };
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
      let body: { masterSalt?: unknown };
      try {
        body = await api.disclosureSalt(card.cardId, commitment.seq.toString());
      } catch (error) {
        if (error instanceof CardsApiError && NOT_ENABLED.has(error.status) && error.code !== "not_found") throw new Error("Sharing card records needs a ChainPay service that isn't live yet.");
        throw new Error("ChainPay couldn't open this card's sharing key.");
      }
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

/**
 * Axum's recovery states → the banner: before the co-signed restore lands the card is
 * `recovery_frozen` (also while `restore_prepared`); after issuer replay it waits for the
 * owner's `confirm_reconciled`. `restored` (confirmed) and no recovery are both normal.
 */
export function recoveryView(card: CardView): CardRecoveryView {
  const raw = card.recovery as { state?: unknown; report?: Partial<RecoveryReport> } | undefined;
  const state: CardRecoveryView["state"] = raw?.state === "recovery_frozen" || raw?.state === "restore_prepared"
    ? "recovery_frozen"
    : raw?.state === "reconciled_pending_owner_confirm" || raw?.state === "restored_pending_reconcile"
      ? "restored_pending_reconcile"
      : "normal";
  if (state === "normal") return { state };
  const report = raw?.report;
  const valid = report && typeof report.digest === "string" && /^[0-9a-f]{64}$/.test(report.digest) && Array.isArray(report.numbers)
    && RECOVERY_NUMBER_KEYS.every((key) => report.numbers!.some((row) => row?.key === key));
  if (!valid) return { state };
  return {
    state,
    report: {
      digest: report.digest!,
      detectedAt: typeof report.detectedAt === "string" ? report.detectedAt : "",
      reason: RECOVERY_REASON_COPY[String(report.reason)] ?? "ChainPay couldn't read this card's private records the way it expected.",
      snapshotLedgerSeq: String(report.snapshotLedgerSeq ?? "0"),
      issuerEventsReplayed: typeof report.issuerEventsReplayed === "number" ? report.issuerEventsReplayed : 0,
      numbers: report.numbers as RecoveryReport["numbers"],
    },
  };
}

const RECOVERY_REASON_COPY: Record<string, string> = {
  not_visible: "The private records stopped answering for this card.",
  ledger_regressed: "The private records went back to an older state than ChainPay's backup.",
  ledger_diverged: "The private records no longer match ChainPay's backup.",
  recovery_frozen_on_chain: "The card was put in recovery on the private rollup.",
  attestation: "The private rollup failed its hardware check, so approvals were paused.",
};

/**
 * Where a repayment goes. Axum's `payWith` names the simulated partner account it will verify against; when this
 * build pins one too (VITE_CHAINPAY_CARD_PARTNER_TOKEN_ACCOUNT) they must agree, or nothing is paid.
 */
export function repaymentTargetFor(statement?: StatementView) {
  const served = statement?.payWith;
  const mint = served?.mint ?? DEVNET_USDC_MINT;
  const recipient = served?.recipientTokenAccount ?? CARD_PARTNER_TOKEN_ACCOUNT;
  const conflict = served && CARD_PARTNER_TOKEN_ACCOUNT && served.recipientTokenAccount && served.recipientTokenAccount !== CARD_PARTNER_TOKEN_ACCOUNT
    ? "ChainPay asked to repay a different account than this dashboard expects, so nothing was paid."
    : served && served.mint !== DEVNET_USDC_MINT
      ? "ChainPay asked to repay in a token other than Devnet USDC, so nothing was paid."
      : undefined;
  return { recipientTokenAccount: recipient ?? null, mint, decimals: 6, cluster: "devnet" as const, conflict };
}

/** Axum reports overdue as a display state on top of the real one. */
function normalizeStatement(statement: StatementView): StatementView {
  return statement.displayState === "overdue" ? { ...statement, state: "overdue" } : statement;
}

const RESTORE_MISMATCH = "The restore ChainPay prepared doesn't match the numbers you reviewed, so it wasn't signed.";

/**
 * The co-signed restore must be exactly one card_policy `restore` for this card,
 * paid by the owner, already signed by an authorizer other than the owner, with
 * the account list the program expects, and every value it writes equal to a
 * number in the report the owner reviewed. Checks what will actually be signed.
 */
export function assertCoSignedRestore(transaction: Transaction, input: { owner: string; cardId: Uint8Array; programId: string; report: RecoveryReport }): RestoreArgs {
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
  const authorizer = only.keys[1]?.pubkey.toBase58();
  if (!authorizer || authorizer === input.owner) throw new Error(RESTORE_MISMATCH);
  const want = buildRestoreInstruction({ owner: input.owner, cardId: input.cardId, authorizer, restore: args }, input.programId);
  // A deserialized transaction marks the fee payer (the owner) writable, so the owner's
  // writable flag is not compared; every other key must match exactly.
  const sameKeys = only.keys.length === want.keys.length && want.keys.every((key, i) =>
    only.keys[i].pubkey.toBase58() === key.address && only.keys[i].isSigner === key.isSigner && (key.address === input.owner || only.keys[i].isWritable === key.isWritable));
  if (!sameKeys || !Buffer.from(only.data).equals(Buffer.from(want.data))) throw new Error(RESTORE_MISMATCH);
  const authorizerSigned = transaction.signatures.some((entry) => entry.publicKey.toBase58() === authorizer && entry.signature !== null);
  if (!authorizerSigned) throw new Error("ChainPay's half of the restore isn't signed yet, so it wasn't signed.");
  return args;
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
    if (shown.get(key) !== signed[key]) throw new Error("The restore ChainPay prepared doesn't match the numbers you reviewed, so it wasn't signed.");
  }
}

function assertBaseTransactionWith(allowed: Set<string>, owner: string, transaction: Transaction): void {
  if (!transaction.feePayer || transaction.feePayer.toBase58() !== owner) throw new Error("ChainPay sent a card setup step paid by another wallet, so it wasn't signed.");
  for (const instruction of transaction.instructions) {
    if (!allowed.has(instruction.programId.toBase58())) throw new Error("ChainPay sent a card setup step for an unexpected program, so it wasn't signed.");
  }
}
