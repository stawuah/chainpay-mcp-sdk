import type { Transaction } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { authorizedFetch, ensureSessionReady, RequestNotSentError, sessionBinding, sessionWalletAddress, type WalletBinding } from "./session";

export type Operation = WalletBinding & { id: string; key: string; kind: "payments" | "transactions"; backend: string; status: string; signature?: string; wire?: string; result?: Settlement };
export type Settlement = { status?: string; signature?: string; payment_id?: string; transaction_id?: string; receipt_address?: string; amount?: string | null; error?: string };
const storageKey = "chainpay.pending-operations.v1";
export const settlementPendingEvent = "chainpay:settlement-pending";
export const settlementTerminalEvent = "chainpay:settlement-terminal";
const terminal = (status: string) => ["confirmed", "failed"].includes(status);
export function listStoredOperations(): Operation[] {
  return read();
}

function read(): Operation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(value) ? value.filter((row): row is Operation => row && typeof row.id === "string" && /^(payment|transaction)_[a-f0-9]{64}$/.test(row.id) && ["payments", "transactions"].includes(row.kind) && typeof row.wallet === "string" && typeof row.backend === "string" && typeof row.status === "string") : [];
  } catch { return []; }
}
export function publishSettlement(operation: Operation, result?: Settlement): Operation {
  const rows = read();
  const old = rows.find((row) => row.id === operation.id);
  const incoming = result ? { ...operation, result, status: result.status ?? "submitted", signature: result.signature ?? operation.signature } : operation;
  const next = old && terminal(old.status) ? old : incoming;
  if (terminal(next.status)) delete next.wire;
  const others = rows.filter((row) => row.id !== next.id);
  const pending = others.filter((row) => !terminal(row.status));
  const history = others.filter((row) => terminal(row.status)).slice(-29);
  localStorage.setItem(storageKey, JSON.stringify([...pending, ...history, next]));
  window.dispatchEvent(new Event(storageKey));
  if (terminal(next.status)) window.dispatchEvent(new CustomEvent(settlementTerminalEvent, { detail: next }));
  return next;
}
export async function beginSettlement(backend: string, kind: Operation["kind"], key: string, wire?: string): Promise<Operation> {
  await ensureSessionReady();
  const binding = sessionBinding();
  if (read().filter((row) => !terminal(row.status)).length >= 100) throw new RequestNotSentError("Resolve pending operations before submitting more requests");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${binding.wallet}:${key}`)));
  const current = sessionBinding();
  if (current.wallet !== binding.wallet || current.generation !== binding.generation) throw new RequestNotSentError("Wallet changed while reserving the request; nothing was sent");
  const id = `${kind === "payments" ? "payment" : "transaction"}_${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return publishSettlement({ id, key, kind, ...binding, backend: backend.replace(/\/$/, ""), status: "submitted", wire });
}
function checkOwner(operation: Operation) {
  if (operation.wallet !== sessionWalletAddress()) throw new Error("Connect the original owner wallet to check this operation");
}
export async function reconcileSettlement(operation: Operation): Promise<Settlement> {
  checkOwner(operation);
  const response = await authorizedFetch(`${operation.backend}/v1/${operation.kind}/${operation.id}`, { signal: AbortSignal.timeout(20_000) }, sessionBinding(), "passive");
  if (!response.ok) throw new Error(`Status unavailable (${response.status}). Check again or cancel only if the backend confirms this request never started.`);
  const result = await response.json() as Settlement;
  return publishSettlement(operation, result).result ?? result;
}
export function waitForSettlementResult(operation: Operation): Promise<Settlement> {
  return new Promise((resolve, reject) => {
    const receive = (event: Event) => {
      const settled = (event as CustomEvent<Operation>).detail;
      if (settled.id !== operation.id || !terminal(settled.status)) return;
      window.removeEventListener(settlementTerminalEvent, receive);
      if (operation.wallet !== sessionWalletAddress()) { reject(new Error("Wallet changed; the original owner's settlement was retained")); return; }
      if (settled.status === "failed") reject(new Error(settled.result?.error ?? "Operation failed or was canceled before submission"));
      else resolve(settled.result ?? { status: settled.status, signature: settled.signature });
    };
    window.addEventListener(settlementTerminalEvent, receive);
    const saved = read().find((row) => row.id === operation.id);
    if (saved && terminal(saved.status)) receive(new CustomEvent(settlementTerminalEvent, { detail: saved }));
  });
}
export async function awaitSettlement(operation: Operation, first?: Settlement, pollWindowMs = 30_000): Promise<Settlement> {
  const deadline = Date.now() + pollWindowMs;
  let result = first;
  do {
    if (result) {
      const saved = publishSettlement(operation, result);
      if (saved.status === "failed") throw new Error(saved.result?.error ?? "Transaction failed");
      if (saved.status === "confirmed" && saved.signature) return saved.result ?? result;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try { result = await reconcileSettlement(operation); } catch { result = undefined; }
  } while (Date.now() <= deadline);
  // Keep the originating action alive. Manual reconciliation completes its
  // existing continuation, which updates the original form and inbox receipt.
  const completion = waitForSettlementResult(operation);
  window.dispatchEvent(new CustomEvent(settlementPendingEvent, { detail: operation }));
  return completion;
}
export async function cancelUnstarted(operation: Operation) {
  checkOwner(operation);
  if (!operation.key) throw new Error("This older browser reference requires operator reconciliation");
  const response = await authorizedFetch(`${operation.backend}/v1/operations/cancel-unstarted`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: operation.kind, key: operation.key }) }, sessionBinding());
  if (!response.ok) throw new Error("The request is already reserved or cannot be verified. Keep its existing approval and reconcile it.");
  publishSettlement(operation, { status: "failed", error: "Canceled before submission; no transaction was sent" });
}
export async function retrySameApproval(operation: Operation) {
  checkOwner(operation);
  if (!operation.wire) throw new Error("Original signed bytes are unavailable. Follow docs/settlement-recovery.md; do not sign again.");
  const response = await authorizedFetch(`${operation.backend}/v1/${operation.kind}/${operation.id}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signed_transaction: operation.wire, resubmit: true }) }, sessionBinding());
  if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Recovery unavailable; keep the original approval");
  return publishSettlement(operation, await response.json() as Settlement);
}
export function dismissSettlement(id: string) {
  localStorage.setItem(storageKey, JSON.stringify(read().filter((row) => row.id !== id || !terminal(row.status))));
  window.dispatchEvent(new Event(storageKey));
}
export async function guardPendingApprovals(wallet: string, transaction: Transaction, programId: string) {
  if (transaction.instructions.length > 0 && transaction.instructions.every((ix) => ix.programId.toBase58() === programId && ["252,97,140,119,67,43,177,108", "192,108,97,124,56,229,236,3"].includes(Array.from(ix.data).join(",")))) return;
  if (read().some((row) => row.wallet === wallet && !terminal(row.status))) throw new PendingSettlementError("An earlier settlement is unresolved. Check settlement, retry its same signed approval, or cancel only an unstarted request.");
}
export function useSettlementFormStatus<S extends string>(
  wallet: string,
  setStatus: (update: (current: S) => S) => void,
  operationKeyRef?: { current: string | null },
) {
  useEffect(() => {
    const pending = (event: Event) => {
      const operation = (event as CustomEvent<Operation>).detail;
      if (operation.wallet !== wallet) return;
      if (operationKeyRef?.current && operation.key !== operationKeyRef.current) return;
      setStatus((current) => current === "signing" ? "pending" as S : current);
    };
    const settled = (event: Event) => {
      const operation = (event as CustomEvent<Operation>).detail;
      if (operation.wallet !== wallet || !terminal(operation.status)) return;
      if (operationKeyRef?.current && operation.key !== operationKeyRef.current) return;
      setStatus((current) => (current === "signing" || current === "pending") ? (operation.status === "confirmed" ? "success" : "error") as S : current);
    };
    window.addEventListener(settlementPendingEvent, pending);
    window.addEventListener(settlementTerminalEvent, settled);
    return () => { window.removeEventListener(settlementPendingEvent, pending); window.removeEventListener(settlementTerminalEvent, settled); };
  }, [wallet, setStatus, operationKeyRef]);
}
export function PendingSettlements({ wallet }: { wallet: string }) {
  const [rows, setRows] = useState(() => read());
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  useEffect(() => { const refresh = () => setRows(read()); window.addEventListener(storageKey, refresh); return () => window.removeEventListener(storageKey, refresh); }, []);
  const run = (action: () => Promise<unknown>) => { setChecking(true); void action().then(() => setMessage("Settlement status updated.")).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error))).finally(() => setChecking(false)); };
  const operations = rows.filter((row) => row.wallet === wallet);
  if (!operations.length) return null;
  return <section className="state-box" aria-live="polite" style={{ margin: 16 }}><strong>Settlement recovery</strong><p>Keep the original approval. Recovery never requests a new wallet signature.</p>{operations.map((operation) => <div key={operation.id}><span>Axum operation ID</span><code>{operation.id}</code><p>{operation.status === "confirmed" ? "Finalized" : operation.status === "failed" ? operation.result?.error ?? "Rejected before settlement" : "Pending verification"}{operation.signature ? ` · ${operation.signature}` : ""}</p>{terminal(operation.status) ? <button onClick={() => dismissSettlement(operation.id)}>Dismiss</button> : <><button disabled={checking} onClick={() => run(() => reconcileSettlement(operation))}>Check settlement</button>{operation.wire && <button disabled={checking} onClick={() => run(() => retrySameApproval(operation))}>Retry same signed approval</button>}<button disabled={checking} onClick={() => run(() => cancelUnstarted(operation))}>Cancel only if unstarted</button></>}</div>)}{message && <p>{message}</p>}</section>;
}
export function rejectBeforeSubmission(operation: Operation) { publishSettlement(operation, { status: "failed", error: "Request rejected before submission" }); }
export class PendingSettlementError extends Error {}
export function isPendingSettlement(error: unknown): boolean { return error instanceof PendingSettlementError; }
export function forgetUnsentOperation(operation: Operation) { localStorage.setItem(storageKey, JSON.stringify(read().filter((row) => row.id !== operation.id))); window.dispatchEvent(new Event(storageKey)); }
