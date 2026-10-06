// Find the Devnet settlement of a private card-statement payment
// (MagicBlock Private Payments), for `pay-card-statement-private.mjs`.
//
// The SDK's `transferOutcome` only says whether MagicBlock's send call
// answered. That call can fail even though the transfer landed (seen live
// on Devnet: "unknown" for a transfer that settled 15 slots later), so the
// script looks for the settlement itself, with the same checks the relay
// uses (backend/src/connectors/card_issuer/private_repay.rs):
//
// - a finalized, successful transaction touching the partner token account;
// - in it, an Ephemeral SPL Token frame that logged
//   `ExecuteReadyQueuedTransfer` and `client_ref_id: <attempt reference>`,
//   with the log lines read only while that program's own frame is on top;
// - the token transfer that frame invoked itself moves exactly the amount due
//   of the attempt's mint, from the vault token account to the partner token
//   account, signed by the vault PDA. Vault addresses are derived here from
//   the mint, never taken from the attempt.
//
// The relay's `private-submit` stays the authority that discharges the
// statement; this only stops the script from reporting "unknown" for a
// payment that visibly settled.
import { PublicKey } from "@solana/web3.js";

export const EPHEMERAL_SPL_PROGRAM = "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const EXECUTE_LOG = "Program log: Instruction: ExecuteReadyQueuedTransfer";
const REF_LOG = "Program log: client_ref_id: ";

/** The program's Global Vault PDA for `mint` and the vault's token account. */
export function vaultAccounts(mint) {
  const mintKey = new PublicKey(mint);
  const [vault] = PublicKey.findProgramAddressSync([mintKey.toBuffer()], new PublicKey(EPHEMERAL_SPL_PROGRAM));
  const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
    [vault.toBuffer(), new PublicKey(SPL_TOKEN_PROGRAM).toBuffer(), mintKey.toBuffer()],
    new PublicKey(ATA_PROGRAM),
  );
  return { vault: vault.toBase58(), vaultTokenAccount: vaultTokenAccount.toBase58() };
}

/**
 * Invocation frames from the logs: for every Ephemeral SPL Token frame,
 * whether it executed a queued transfer and its reference; for every inner
 * instruction (invoke at height >= 2, log order), the index of its direct
 * parent frame when that parent is the Ephemeral SPL Token program.
 * `null` when the logs are truncated, unbalanced or carry a malformed or
 * repeated reference: never evidence.
 */
export function parseFrames(logs) {
  const stack = [];
  const frames = [];
  const parents = [];
  for (const line of logs ?? []) {
    if (typeof line !== "string") continue;
    if (line.startsWith("Log truncated")) return null;
    const call = /^Program (\S+) (invoke|success|failed:)/.exec(line);
    if (call) {
      const [, program, what] = call;
      if (what === "invoke") {
        if (stack.length) parents.push(stack[stack.length - 1].frame);
        let frame = null;
        if (program === EPHEMERAL_SPL_PROGRAM) {
          frames.push({ execute: false, reference: null });
          frame = frames.length - 1;
        }
        stack.push({ program, frame });
      } else {
        if (stack[stack.length - 1]?.program !== program) return null;
        stack.pop();
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top || top.frame === null) continue;
    const frame = frames[top.frame];
    if (line === EXECUTE_LOG) {
      frame.execute = true;
    } else if (line.startsWith(REF_LOG)) {
      const value = line.slice(REF_LOG.length);
      if (frame.reference !== null || !/^[0-9]+$/.test(value)) return null;
      frame.reference = value;
    }
  }
  if (stack.length) return null;
  return { frames, parents };
}

function innerInstructions(tx) {
  return [...(tx?.meta?.innerInstructions ?? [])]
    .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
    .flatMap((group) => group.instructions ?? []);
}

/**
 * Every queued payout in `tx` (a jsonParsed `getTransaction` result), as the
 * relay's `settlements_in` reads them: each execute frame must carry exactly
 * one reference and invoke exactly one token transfer itself. `null` when
 * the transaction failed or cannot be attributed unambiguously.
 */
export function settlementsIn(tx) {
  if (!tx?.meta || tx.meta.err !== null) return null;
  const parsed = parseFrames(tx.meta.logMessages);
  if (!parsed) return null;
  const inner = innerInstructions(tx);
  if (inner.length !== parsed.parents.length) return null;
  const perFrame = parsed.frames.map(() => []);
  for (const [i, ix] of inner.entries()) {
    const parent = parsed.parents[i];
    if (parent === null || parent === undefined) continue;
    if (ix.programId !== SPL_TOKEN_PROGRAM || !["transfer", "transferChecked"].includes(ix.parsed?.type)) continue;
    const info = ix.parsed.info ?? {};
    const amount = info.tokenAmount?.amount ?? info.amount;
    if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return null;
    // A plain `transfer` names no mint and so is never a vault payout here.
    const mint = info.mint ?? "";
    let isVault = false;
    try {
      const derived = mint ? vaultAccounts(mint) : null;
      isVault = Boolean(derived && derived.vault === info.authority && derived.vaultTokenAccount === info.source);
    } catch {
      isVault = false;
    }
    perFrame[parent].push({ amount, mint: isVault ? mint : `not-vault:${mint}`, source: info.source, authority: info.authority, destination: info.destination });
  }
  const out = [];
  for (const [f, frame] of parsed.frames.entries()) {
    if (!frame.execute) continue;
    if (frame.reference === null || perFrame[f].length !== 1) return null;
    out.push({ ...perFrame[f][0], clientRefId: frame.reference });
  }
  return out;
}

/**
 * Whether `tx` settles `attempt`: a vault payout tagged with its reference
 * of exactly its amount and mint to its partner token account.
 */
export function settlesAttempt(tx, attempt) {
  return (settlementsIn(tx) ?? []).some((s) =>
    s.clientRefId === attempt.clientRefId
    && s.mint === attempt.mint
    && s.destination === attempt.recipientTokenAccount
    && s.amount === String(attempt.amountBaseUnits));
}

/**
 * Poll the partner token account's finalized history until a transaction
 * settles `attempt`, or the time runs out. Resolves with the settlement's
 * signature and slot, or `null`.
 */
export async function waitForSettlement(connection, attempt, { sinceMs, timeoutMs = 120_000, intervalMs = 4_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const account = new PublicKey(attempt.recipientTokenAccount);
  const deadline = Date.now() + timeoutMs;
  const checked = new Set();
  for (;;) {
    const signatures = await connection.getSignaturesForAddress(account, { limit: 50 }, "finalized");
    for (const entry of signatures) {
      if (entry.err || checked.has(entry.signature)) continue;
      // Older than this run (minus clock slack): not this payment.
      if (sinceMs !== undefined && entry.blockTime && entry.blockTime * 1000 < sinceMs - 120_000) continue;
      checked.add(entry.signature);
      const tx = await connection.getParsedTransaction(entry.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      if (settlesAttempt(tx, attempt)) return { signature: entry.signature, slot: entry.slot, commitment: "finalized" };
    }
    if (Date.now() + intervalMs > deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * The outcome the script reports: on-chain settlement wins over the send
 * call's answer, in both directions of doubt ("unknown" that settled is
 * "settled"; "sent" stays "sent" until a settlement is seen).
 */
export function reportedOutcome(sendOutcome, settlement) {
  if (settlement) return "settled";
  return sendOutcome === "sent" ? "sent" : "unknown";
}
