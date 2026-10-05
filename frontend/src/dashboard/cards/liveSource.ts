import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildConfirmReconciledInstruction,
  buildDisclosureBundle,
  buildRepayStatementInstruction,
  buildInitPermissionInstruction,
  buildResolveExceptionInstruction,
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
  deriveAssociatedTokenAddress,
  deriveCardAccounts,
  deriveRepayAgentAddress,
  DEVNET_TEE_URL,
  DELEGATION_PROGRAM_ID,
  getTeeSession,
  keypairSigner,
  readCardPeriod,
  readCardPolicy,
  readTeeAccount,
  toWeb3Instruction,
  toWeb3Transaction,
  TOKEN_2022_PROGRAM_ID,
  walletAdapterSigner,
  type CardActivityRow,
  type CardMerchantListing,
  type CardView,
  type StatementView,
  type ChainPayInstruction,
  type PolicyArgs,
  type PreparedCard,
  type TeeRead,
  type TeeSession,
} from "@chainpay/sdk";
import { authorizedFetch } from "../../session";
import { BACKEND_URL, CARD_PARTNER_TOKEN_ACCOUNT, CARD_POLICY_PROGRAM_ID, DEVNET_SEND_RPC_URL, DEVNET_USDC_MINT, MCP_URL } from "../../config/public";
import { registerMcpConnection } from "../../owner/runtime";
import { payStatementPrivately, preparePrivateRepayment, submitPrivateRepayment, waitForPrivateRepayment, type ChainPayRoutesOptions } from "@chainpay/sdk/cards/private-repayment";
import { chainpayClient } from "../../config/client";
import { submitSignedTransaction } from "../../owner/runtime";
import { checkTeeAttestation } from "./teeAttestation";
import { cardStatus } from "./lifecycle";
import { statementAmountDue } from "./statementMath";
import { assertCardSetupTransaction, assertCoSignedRestore, reviewedRestore, type ReviewedRestore } from "./signingGuards";
import { clearRepaymentAttempt, lookupRepayment, recordRepaymentAttempt } from "./repaymentAttempts";
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
  type RecoveryReport,
  type RecoveryRules,
  type RepaymentLookup,
  RECOVERY_NUMBER_KEYS,
} from "./source";


/** Activation re-drive while the owner waits: about a minute, then the reconcile cron finishes it. */
const ACTIVATION_POLL_TRIES = 12;
const ACTIVATION_POLL_MS = 5_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function activationProgress(view: CardView): string {
  const status = cardStatus(view);
  if (status.key === "proof_pending") return "Limits copied. Waiting for the public proof on Solana before the card opens.";
  if (status.key === "opening") return status.detail ?? "Public proof is on Solana. Opening the card.";
  return status.detail ?? "Turning the card on.";
}

export { assertCoSignedRestore, assertRestoreMatchesReport, assertCardSetupTransaction } from "./signingGuards";

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
  async function sendCoSignedTee(step: string, encoded: string, report: RecoveryReport, reviewed: ReviewedRestore, cardId: string): Promise<string> {
    if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
    const transaction = Transaction.from(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
    assertCoSignedRestore(transaction, { ...cardRef(cardId), programId, report, reviewed });
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

  /** 0 init_card: binding exists · 1 delegate_card: policy owned by the delegation program · 2 escrow top-up: escrow funded. */
  async function baseStepDone(index: number, prepared: PreparedCard): Promise<boolean> {
    try {
      const connection = chainpayClient.connection;
      if (index === 0) return (await connection.getAccountInfo(new PublicKey(prepared.accounts.binding), "confirmed")) !== null;
      if (index === 1) return (await connection.getAccountInfo(new PublicKey(prepared.accounts.policy), "confirmed"))?.owner.toBase58() === DELEGATION_PROGRAM_ID;
      return ((await connection.getAccountInfo(new PublicKey(prepared.accounts.escrow), "confirmed"))?.lamports ?? 0) > 0;
    } catch {
      return false;
    }
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
        // Resume after a reload or an outcome we never heard back: skip a step whose effect is
        // already on Solana instead of asking the wallet to sign it again.
        if (await baseStepDone(index, prepared)) { attempt.baseDone = index + 1; continue; }
        const transaction = Transaction.from(Uint8Array.from(atob(encodedTxs[index]), (char) => char.charCodeAt(0)));
        // Decoded against the exact setup instruction for THIS card; anything else is refused.
        assertCardSetupTransaction(transaction, index, { owner: deps.wallet, prepared, programId });
        // Server-built, owner-only transactions: refresh the blockhash right before
        // signing so a slow wallet prompt can't push it past its lifetime.
        if (transaction.signatures.every((entry) => entry.publicKey.toBase58() === deps.wallet && !entry.signature)) {
          transaction.recentBlockhash = (await chainpayClient.connection.getLatestBlockhash("confirmed")).blockhash;
        }
        const signed = await deps.signTransaction(transaction);
        // One operation per signed transaction: a step the relay refused before sending can be
        // signed again with a fresh blockhash instead of hitting the refused operation forever.
        await submitSignedTransaction(`card-base:${prepared.cardId}:${index}:${signed.recentBlockhash}`, signed.serialize(), { dismissOnConfirm: true });
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
      // Axum answers with the activation it actually reached. "Returned" is not "done":
      // the card is on only when the card network shows it open, the limits are copied
      // and the public proof read back from Solana (cardStatus "active").
      const operationId = `card-activate-${attemptId}`;
      let view = await guard(() => api.activateCard(prepared.cardId, 1, operationId));
      for (let tries = 0; cardStatus(view).key !== "active" && tries < ACTIVATION_POLL_TRIES; tries += 1) {
        progress("activate", "active", activationProgress(view));
        await sleep(ACTIVATION_POLL_MS);
        // Same operation: Axum resumes it (reads the proof back, then opens the card).
        // An older relay without `activation` in its answer is only read, never re-driven.
        view = view.activation ? await guard(() => api.activateCard(prepared.cardId, 1, operationId)) : await guard(() => api.getCard(prepared.cardId));
      }
      attempts.delete(attemptId);
      if (cardStatus(view).key === "active") progress("activate", "done");
      else progress("activate", "active", `${activationProgress(view)} ChainPay keeps going without you; the card page shows each step.`);
      return prepared.cardId;
    },

    freeze: (cardId, reason, operationId) => guard(() => api.freezeCard(cardId, reason, operationId)),
    // Resumes the card's persisted activation for its policy version (Axum never starts a second one).
    finishActivation: (card, operationId) => guard(() => api.activateCard(card.cardId, card.activation?.policyVersion ?? card.mirror.policyVersionMirrored ?? 1, operationId)),
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

    repayAgent: (card) => deriveRepayAgentAddress(accounts(card.cardId).binding, programId),

    async createRepaymentPermission(card, statement) {
      if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
      const target = repaymentTargetFor(statement);
      if (target.conflict) throw new Error(target.conflict);
      const total = statementAmountDue(statement);
      if (total <= 0n) throw new Error("Nothing to pay on this statement.");
      const amount = centsToTokenBaseUnits(total, target.decimals);
      const slot = BigInt(await chainpayClient.connection.getSlot("confirmed"));
      // One payment of exactly this statement, for the card's repay agent only; ~1 day to use it.
      const prepared = await chainpayClient.buildCreateMandate({
        approvedAgent: deriveRepayAgentAddress(accounts(card.cardId).binding, programId),
        sourceTokenAccount: deriveAssociatedTokenAddress(deps.wallet, target.mint, "spl-token"),
        allowedMint: target.mint,
        maxPerPayment: amount,
        totalLimit: amount,
        expiresAtSlot: slot + 216_000n,
        maxPaymentCount: 1n,
        cooldownSlots: 0n,
        tokenProgram: "spl-token",
        delegateAmount: amount,
      }, deps.wallet);
      const latest = await chainpayClient.connection.getLatestBlockhash("confirmed");
      const signed = await deps.signTransaction(toWeb3Transaction(prepared.transaction, latest.blockhash));
      await submitSignedTransaction(`card-repay-permission:${statement.statementId}:${signed.recentBlockhash}`, signed.serialize(), { dismissOnConfirm: true });
      return prepared.mandateAddress;
    },

    async payStatement(card, statement, mandateAddress) {
      if (!deps.signTransaction) throw new Error("This wallet can't sign transactions.");
      const target = repaymentTargetFor(statement);
      if (!target.recipientTokenAccount) throw new Error("ChainPay hasn't set the simulated partner's account yet, so statements can't be paid.");
      if (target.conflict) throw new Error(target.conflict);
      if (!statement.digest) throw new Error("This statement has no reference yet.");
      const total = statementAmountDue(statement);
      if (total <= 0n) throw new Error("Nothing to pay on this statement.");
      const repayAgent = deriveRepayAgentAddress(accounts(card.cardId).binding, programId);
      const mandate = await chainpayClient.getMandate(mandateAddress);
      if (!mandate || mandate.owner !== deps.wallet || mandate.approvedAgent !== repayAgent) throw new Error("This isn't this card's repayment permission, so nothing was paid.");
      if (mandate.allowedMint !== target.mint) throw new Error("This permission is for a different token, so nothing was paid.");
      if (mandate.status !== "active") throw new Error("This repayment permission isn't active, so nothing was paid.");
      // Repayment = card_policy repay_statement: the card's repay agent signs ChainPay
      // execute_payment by CPI, invoice_hash = statement digest (contracts §7.2).
      const { instruction, receipt } = buildRepayStatementInstruction({
        ...cardRef(card.cardId),
        mandate: mandateAddress,
        mint: target.mint,
        sourceTokenAccount: mandate.sourceTokenAccount,
        recipientTokenAccount: target.recipientTokenAccount,
        statementDigest: hexBytes(statement.digest),
        amount: centsToTokenBaseUnits(total, target.decimals),
        chainpayProgramId: chainpayClient.programId,
        ...(mandate.tokenProgram === "token-2022" ? { tokenProgram: TOKEN_2022_PROGRAM_ID } : {}),
      }, programId);
      const connection = new Connection(DEVNET_SEND_RPC_URL, "confirmed");
      const latest = await connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction({ feePayer: new PublicKey(deps.wallet), recentBlockhash: latest.blockhash }).add(toWeb3Instruction(instruction));
      const signed = await deps.signTransaction(transaction);
      // Signed: from here on the outcome can be unknown. Recorded per statement, so no other
      // permission can pay it again until a receipt shows up or this blockhash expires.
      recordRepaymentAttempt(statement.digest, { mandatePda: mandateAddress, receiptPda: receipt, lastValidBlockHeight: latest.lastValidBlockHeight });
      const unknown = (reason?: string) => ({
        outcome: "unknown" as const,
        receiptPda: receipt,
        mandatePda: mandateAddress,
        reason: reason || "No clear answer came back after you signed, so this payment may have settled.",
      });
      let signature: string;
      try {
        signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      } catch (error) {
        // A failed preflight simulation means the transaction was never broadcast: not paid.
        if (error instanceof Error && /simulation failed/i.test(error.message)) {
          clearRepaymentAttempt(statement.digest, receipt);
          throw new Error("Solana refused the repayment before sending it, so nothing was paid. Check the permission's limit and your USDC balance.");
        }
        return unknown(error instanceof Error ? error.message : undefined);
      }
      try {
        const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
        if (result.value.err) {
          clearRepaymentAttempt(statement.digest, receipt);
          throw new Error("The repayment failed on Solana, so nothing was paid.");
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("The repayment failed")) throw error;
        return unknown(error instanceof Error ? error.message : undefined);
      }
      return { outcome: "confirmed", receiptPda: receipt, mandatePda: mandateAddress, signature };
    },

    async repaymentStatus(statement, mandateAddresses): Promise<RepaymentLookup> {
      if (!statement.digest) return { state: "none" };
      const invoiceHash = hexBytes(statement.digest);
      return lookupRepayment({
        digest: statement.digest,
        mandateAddresses,
        getBlockHeight: () => chainpayClient.connection.getBlockHeight("confirmed"),
        findReceipt: async (mandate) => {
          const receipt = await chainpayClient.getPayment({ mandate, invoiceHash } as Parameters<typeof chainpayClient.getPayment>[0]);
          return receipt ? String(receipt.address) : null;
        },
      });
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
        pay: async (attempt, onSigned) => {
          const signTransaction = deps.signTransaction;
          const signMessage = deps.signMessage;
          if (!signTransaction || !signMessage) throw new Error("This wallet can't sign the private payment.");
          // The SDK announces a deposit before signing it; any other signature is the private transfer.
          let signingDeposit = false;
          const result = await payStatementPrivately({
            attempt,
            onStep: (step) => { if (step.step === "deposit") signingDeposit = !("signature" in step && step.signature); },
            signer: {
              publicKey: deps.wallet,
              signMessage,
              async signTransaction(b64) {
                // MagicBlock builds legacy transactions on Devnet (no lookup tables).
                const signed = await signTransaction(Transaction.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
                // Only now, with the wallet's signature in hand, is the transfer "sent" for this browser.
                if (!signingDeposit && signed.signature) onSigned(base58(signed.signature));
                return btoa(String.fromCharCode(...signed.serialize({ requireAllSignatures: false })));
              },
            },
            // The relay's RPC proxy never forwards sendTransaction, and MagicBlock's send endpoint
            // refused base-layer deposits live, so base sends go straight to a Devnet RPC.
            sendBase: async (signedB64, built) => {
              const connection = new Connection(DEVNET_SEND_RPC_URL, "confirmed");
              const signature = await connection.sendRawTransaction(Uint8Array.from(atob(signedB64), (c) => c.charCodeAt(0)));
              const result = await connection.confirmTransaction({ signature, blockhash: built.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
              if (result.value.err) throw new Error("The deposit was rejected on Solana. Nothing was paid.");
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
      const tee = await ensureSession();
      const [current, currentPeriod] = await Promise.all([
        readCardPolicy(tee, accounts(card.cardId).policy, programId).catch(() => null),
        readCardPeriod(tee, accounts(card.cardId).period, programId).catch(() => null),
      ]);
      const alreadyRestored = current?.state === "visible" && current.account.recoveryState === "restored_pending_reconcile";
      if (!alreadyRestored) {
        // What the restore may write besides the 7 numbers: the card's own rules, read with the
        // owner's session, and ChainPay's report must agree with them. Checked before asking Axum.
        const reviewed = reviewedRestore(report, {
          policy: current?.state === "visible" ? current.account : null,
          period: currentPeriod?.state === "visible" ? currentPeriod.account : null,
        });
        const prepared = await guard(() => api.prepareRestore(card.cardId, { clientOperationId: `card-restore-${report.digest.slice(0, 32)}`, reconReportDigest: report.digest }));
        if (prepared.state !== "ready_to_sign") {
          throw new Error("ChainPay's numbers changed since you reviewed them, so nothing was signed. Review the new numbers and try again.");
        }
        // card_policy requires owner + authorizer co-sign on restore, so there is no
        // owner-only path. Axum returns the PER transaction already signed by the
        // authorizer (`restoreTx`, nothing else is accepted); the owner checks it
        // writes exactly the reviewed numbers and rules, adds a signature and sends it.
        if (typeof prepared.restoreTx !== "string" || !prepared.restoreTx) throw new Error("ChainPay didn't return the co-signed restore yet. Nothing was signed; try again in a moment.");
        await sendCoSignedTee("Approve restore", prepared.restoreTx, report, reviewed, card.cardId);
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
  const raw = card.recovery as { state?: unknown; report?: Partial<Omit<RecoveryReport, "rules">> & { rules?: unknown } } | undefined;
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
      ...(parseRecoveryRules(report.rules) ? { rules: parseRecoveryRules(report.rules) } : {}),
    },
  };
}

/** Axum's report `rules`, accepted only when every field has the exact type; anything else is dropped (and then can't vouch for a restore). */
export function parseRecoveryRules(raw: unknown): RecoveryRules | undefined {
  const r = raw as Partial<Record<keyof RecoveryRules, unknown>> | null | undefined;
  if (!r || typeof r !== "object") return undefined;
  const digits = (value: unknown) => typeof value === "string" && /^\d+$/.test(value);
  const int = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const ok = digits(r.maxPurchaseCents) && int(r.maxPurchasesPerPeriod) && int(r.periodSeconds) && typeof r.currency === "string"
    && Array.isArray(r.merchantIdHashes) && r.merchantIdHashes.every((hash) => typeof hash === "string" && /^[0-9a-fA-F]{64}$/.test(hash))
    && Array.isArray(r.mccs) && r.mccs.every(int) && digits(r.expiresAt) && typeof r.recurringAllowed === "boolean" && int(r.feeBps)
    && typeof r.authorizer === "string" && (r.periodIndex === undefined || int(r.periodIndex));
  if (!ok) return undefined;
  return {
    maxPurchaseCents: r.maxPurchaseCents as string,
    maxPurchasesPerPeriod: r.maxPurchasesPerPeriod as number,
    periodSeconds: r.periodSeconds as number,
    currency: r.currency as string,
    merchantIdHashes: (r.merchantIdHashes as string[]).map((hash) => hash.toLowerCase()),
    mccs: [...(r.mccs as number[])],
    expiresAt: r.expiresAt as string,
    recurringAllowed: r.recurringAllowed as boolean,
    feeBps: r.feeBps as number,
    authorizer: r.authorizer as string,
    ...(r.periodIndex !== undefined ? { periodIndex: r.periodIndex as number } : {}),
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

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) { out = BASE58[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = "1" + out; }
  return out;
}
