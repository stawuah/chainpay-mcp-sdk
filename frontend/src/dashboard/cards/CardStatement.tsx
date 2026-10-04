import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Check, FileText, Receipt, TriangleAlert } from "lucide-react";
import { centsToTokenBaseUnits, formatUsdCents, parseSignedCents, type CardView, type OpenStatementView, type StatementLine, type StatementView } from "@chainpay/sdk";
import { CardEvidenceCard } from "../../receipts/CardEvidenceCard";
import { statementEvidence } from "./evidence";
import { MISMATCH_COPY, STATEMENT_STATE_LABEL, STATEMENT_STEPS } from "./lifecycle";
import { newOperationId, type CardStatements, type CardsSource, type RepaymentLookup } from "./source";
import { statementAmountDue } from "./statementMath";
import { PrivateRepayOptIn } from "./PrivateRepayOptIn";
import { errorText } from "./shared";
import { formatDay, shortKey } from "./ui";

type MandateOption = { address: string; approvedAgent: string; allowedMint: string; status: string };

const LINE_LABEL: Record<StatementView["lines"][number]["kind"], string> = {
  purchase: "Purchase",
  refund: "Refund",
  adjustment_debit: "Adjustment",
  adjustment_credit: "Adjustment credit",
};

export const SIMULATED_CREDIT_LABEL = "Simulated credit — no credit extended";

/** Credits (refunds, correction credits) arrive as negative cents; their size is what the statement subtracts. */
const abs = (value: bigint) => (value < 0n ? -value : value);
const isCredit = (line: StatementLine) => line.kind === "refund" || line.kind === "adjustment_credit";
const lineDate = (line: StatementLine) => line.postedAt ?? line.at ?? "";

/** Purchases − refunds + Σ line fees, exact integers (contracts §7.1). Amounts are signed cent strings. */
export function statementLineTotals(statement: Pick<StatementView, "lines" | "totalCents" | "feeCents">) {
  let purchases = 0n;
  let refunds = 0n;
  let fees = 0n;
  for (const line of statement.lines) {
    const amount = abs(parseSignedCents(line.amountCents));
    if (isCredit(line)) refunds += amount;
    else purchases += amount;
    fees += parseSignedCents(line.feeCents);
  }
  const total = purchases - refunds + fees;
  return { purchases, refunds, fees, total, matches: total === parseSignedCents(statement.totalCents) && fees === parseSignedCents(statement.feeCents) };
}

function payable(statement: StatementView): boolean {
  return ["closed", "repayment_mismatch", "overdue"].includes(statement.state) && statementAmountDue(statement) > 0n;
}

const signedMoney = (cents: string) => {
  const value = parseSignedCents(cents);
  return value < 0n ? `−${formatUsdCents(-value)}` : formatUsdCents(value);
};

function StatementLines({ lines }: { lines: StatementLine[] }) {
  return (
    <table className="cp-statement-lines">
      <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Amount</th><th scope="col">Fee</th></tr></thead>
      <tbody>
        {lines.map((line, index) => (
          <tr key={line.lineId ?? `${lineDate(line)}-${index}`} data-kind={line.kind}>
            <td data-label="Date">{formatDay(lineDate(line))}</td>
            <td data-label="What">{LINE_LABEL[line.kind]}{line.merchant ? ` · ${line.merchant.displayName}` : ""}{line.exception && <span className="cp-line-flag"> · flagged for review</span>}</td>
            <td data-label="Amount" className={isCredit(line) ? "is-credit" : ""}>{isCredit(line) ? `−${formatUsdCents(abs(parseSignedCents(line.amountCents)))}` : formatUsdCents(abs(parseSignedCents(line.amountCents)))}</td>
            <td data-label="Fee">{signedMoney(line.feeCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What posted since the last close. Never a due amount; the owner can close it now (interim close). */
function RunningStatement({ source, card, open, onChanged }: { source: CardsSource; card: CardView; open: OpenStatementView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const op = useRef<string | null>(null);
  async function close() {
    setBusy(true);
    setError("");
    try {
      op.current ??= newOperationId("statement-close");
      await source.closeStatement(card.cardId, op.current);
      op.current = null;
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dashboard-card cp-statement-card cp-statement-running" data-testid="running-statement">
      <div className="cp-statement-head">
        <div>
          <span className="owner-caption">Running statement · not closed yet</span>
          <h2>{signedMoney(open.runningTotalCents)} <small>so far, fees included</small></h2>
        </div>
        {open.lineCount > 0 && <Button type="button" variant="secondary" label={busy ? "Closing…" : "Close statement now"} isDisabled={busy} onClick={() => void close()} />}
      </div>
      {open.lineCount > 0 ? <StatementLines lines={open.lines} /> : <p className="owner-muted">Nothing has posted since the last statement.</p>}
      <p className="owner-muted">It closes by itself at the end of the period. Closing it now fixes the amount and due date so you can repay early; the budget period doesn't change.</p>
      {error && <div className="builder-error" role="alert"><b>Not closed</b><span>{error}</span></div>}
    </div>
  );
}

export function CardStatement({ source, card, statements, mandates, wallet, onChanged }: { source: CardsSource; card: CardView; statements: CardStatements | null; mandates: MandateOption[]; wallet: string; onChanged: () => void }) {
  const [selected, setSelected] = useState(0);
  const [paying, setPaying] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  if (statements === null) return <p className="owner-muted" aria-busy="true">Loading statements…</p>;
  const closed = statements.closed;
  const running = statements.open && statements.open.lineCount > 0 ? <RunningStatement source={source} card={card} open={statements.open} onChanged={onChanged} /> : null;
  if (closed.length === 0) {
    return (
      <>
        <p className="cp-sim-strip" data-testid="sim-strip">{SIMULATED_CREDIT_LABEL}</p>
        {running}
        {!running && <div className="owner-small-empty"><FileText /><h3>No statement yet</h3><p>A statement closes at the end of each period with every charge, refund and fee, to the cent.</p></div>}
      </>
    );
  }
  const statement = closed[Math.min(selected, closed.length - 1)];
  const due = statementAmountDue(statement);
  const totals = statementLineTotals(statement);
  const stepIndex = STATEMENT_STEPS.findIndex((step) => step.key === statement.state);
  const evidence = statementEvidence(statement);

  return (
    <section className="cp-statement" data-state={statement.state} data-testid="card-statement">
      <p className="cp-sim-strip" data-testid="sim-strip">{SIMULATED_CREDIT_LABEL}</p>
      {running}
      <div className="dashboard-card cp-statement-card">
        <div className="cp-statement-head">
          <div>
            <span className="owner-caption">{statementName(statement)}{statement.closedAt ? ` · closed ${formatDay(statement.closedAt)}` : ""}</span>
            <h2>{formatUsdCents(statement.totalCents)} <small>{statement.state === "discharged" ? "paid off" : statement.dueAt ? `due ${formatDay(statement.dueAt)}` : ""}</small></h2>
            {statement.state === "discharged" && <span className="cp-paid-stamp" aria-hidden="true">Paid off</span>}
          </div>
          {closed.length > 1 && (
            <Selector label="Statement" isLabelHidden value={String(selected)} onChange={(value) => setSelected(Number(value))} options={closed.map((item, index) => ({ value: String(index), label: statementName(item) }))} />
          )}
        </div>

        <ol className="cp-statement-steps" aria-label="Statement progress">
          {STATEMENT_STEPS.map((step, index) => {
            const done = stepIndex >= index && statement.state !== "repayment_mismatch";
            return <li key={step.key} data-done={done ? "yes" : "no"} aria-current={stepIndex === index ? "step" : undefined}><span>{done ? <Check size={14} /> : index + 1}</span>{step.label}</li>;
          })}
        </ol>
        {(statement.state === "repayment_mismatch" || statement.state === "overdue") && (
          <div className="cp-statement-alert" role="alert" data-testid="statement-alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <div>
              <b>{STATEMENT_STATE_LABEL[statement.state]}</b>
              {statement.state === "repayment_mismatch" ? (
                <ul>{(statement.repayment?.mismatch ?? []).map((field) => <li key={field} data-field={field}>{MISMATCH_COPY[field] ?? `${field} didn't match.`}</li>)}</ul>
              ) : <p>The due date passed. There are no late fees in the sandbox; the statement stays payable.</p>}
              {statement.state === "repayment_mismatch" && <p>The statement is still open. Nothing was closed with the wrong payment.</p>}
            </div>
          </div>
        )}

        <StatementLines lines={statement.lines} />
        <dl className="cp-statement-totals">
          <div><dt>Purchases</dt><dd>{formatUsdCents(totals.purchases)}</dd></div>
          <div><dt>Refunds</dt><dd>−{formatUsdCents(totals.refunds)}</dd></div>
          <div><dt>ChainPay fees</dt><dd>{signedMoney(statement.feeCents)}</dd></div>
          <div className="is-total"><dt>Total</dt><dd>{signedMoney(statement.totalCents)}</dd></div>
          {statement.carriedCreditCents && parseSignedCents(statement.carriedCreditCents) > 0n && <div><dt>Credit carried in</dt><dd>−{formatUsdCents(statement.carriedCreditCents)}</dd></div>}
          {statement.amountDueCents !== undefined && statement.amountDueCents !== statement.totalCents && <div className="is-total"><dt>Amount due</dt><dd>{formatUsdCents(due)}</dd></div>}
        </dl>
        {!totals.matches && <p className="cp-inline-error" role="alert">These lines don't add up to the total ChainPay sent, so this statement can't be paid here until it's corrected.</p>}

        <div className="cp-statement-actions">
          {payable(statement) && totals.matches && <Button type="button" variant="primary" label={`Pay ${formatUsdCents(due)}`} onClick={() => setPaying(true)} />}
          {evidence && <Button type="button" variant="secondary" label="Repayment receipt" icon={<Receipt size={16} />} onClick={() => setReceiptOpen(true)} />}
          {statement.partner?.ref && <small className="owner-muted">Simulated partner reference {statement.partner.ref}</small>}
        </div>
        <details className="technical-details">
          <summary>Statement details</summary>
          <div className="review-list">
            <div><span>Statement reference</span><strong className="mono">{statement.digest ?? "Not computed yet"}</strong></div>
            <div><span>Statement id</span><strong className="mono">{statement.statementId}</strong></div>
            <div><span>Card</span><strong>{card.label} · •••• {card.lastFour}</strong></div>
          </div>
        </details>
      </div>

      {paying && <RepaymentDialog source={source} card={card} statement={statement} mandates={mandates} wallet={wallet} onClose={() => setPaying(false)} onDone={() => { setPaying(false); onChanged(); }} />}
      <Dialog isOpen={receiptOpen} onOpenChange={(next) => { if (!next) setReceiptOpen(false); }} purpose="info" width={560}>
        <Layout height="auto" header={<DialogHeader title="Repayment receipt" onOpenChange={(next) => { if (!next) setReceiptOpen(false); }} />} content={<LayoutContent>{evidence && <CardEvidenceCard evidence={evidence} />}</LayoutContent>} />
      </Dialog>
    </section>
  );
}

function statementName(statement: StatementView): string {
  if (statement.statementSeq) return `Statement ${statement.statementSeq}${statement.closeKind === "interim" ? " (closed early)" : ""}`;
  return `Period ${statement.periodIndex}`;
}

function RepaymentDialog({ source, card, statement, mandates, wallet, onClose, onDone }: { source: CardsSource; card: CardView; statement: StatementView; mandates: MandateOption[]; wallet: string; onClose: () => void; onDone: () => void }) {
  const target = source.repaymentTarget(statement);
  // Two methods: the transparent card_policy repay_statement → ChainPay execute_payment (default)
  // and, when ChainPay offers it, MagicBlock private payments.
  const privateActions = useMemo(() => source.privateRepay(card, statement), [source, card, statement]);
  const [method, setMethod] = useState<"transparent" | "private">("transparent");
  // Only permissions approved for this card's repay agent can pay it (record_repayment checks the receipt's agent).
  const repayAgent = useMemo(() => source.repayAgent(card), [source, card]);
  const [created, setCreated] = useState<string[]>([]);
  const eligible = useMemo(() => [
    ...mandates.filter((mandate) => mandate.status === "active" && mandate.approvedAgent === repayAgent && mandate.allowedMint === target.mint).map((mandate) => mandate.address),
    ...created,
  ].filter((address, index, all) => all.indexOf(address) === index), [mandates, repayAgent, target.mint, created]);
  const [mandate, setMandate] = useState(eligible[0] ?? "");
  const [receiptPda, setReceiptPda] = useState("");
  const [mandatePda, setMandatePda] = useState("");
  const [busy, setBusy] = useState<"" | "pay" | "check" | "permission">("");
  // Once money moved, keep the receipt: a failed confirmation must never read as "not paid".
  const [paid, setPaid] = useState<{ receiptPda: string; mandatePda: string; signature?: string } | null>(null);
  // Earlier attempts at this statement under ANY permission. Pay stays off until this says "none".
  const [lookup, setLookup] = useState<RepaymentLookup | { state: "checking" } | { state: "check_failed"; message: string }>({ state: "checking" });
  const [unknownReason, setUnknownReason] = useState("");
  const [error, setError] = useState("");
  const total = statementAmountDue(statement);
  const baseUnits = centsToTokenBaseUnits(total, target.decimals);
  const ownAddresses = useMemo(() => [...new Set([...mandates.map((item) => item.address), ...created])], [mandates, created]);

  const prefill = (found: { receiptPda: string; mandatePda: string }) => {
    setReceiptPda(found.receiptPda);
    setMandatePda(found.mandatePda);
  };

  // Latest props for the reconcile loop, so a parent re-render never restarts it.
  const latest = useRef({ source, statement, ownAddresses, cardId: card.cardId, onDone });
  latest.current = { source, statement, ownAddresses, cardId: card.cardId, onDone };

  /** Reconcile by statement: a receipt on Solana closes it; an expired, receipt-less attempt reopens Pay. */
  const reconcile = useCallback(async () => {
    const { source, statement, ownAddresses, cardId, onDone } = latest.current;
    try {
      const found = await source.repaymentStatus(statement, ownAddresses);
      setLookup(found);
      if (found.state === "none") return;
      prefill(found);
      if (found.state === "paid") {
        setPaid({ receiptPda: found.receiptPda, mandatePda: found.mandatePda });
        await source.submitRepayment(cardId, statement.statementId, { receiptPda: found.receiptPda, mandatePda: found.mandatePda });
        onDone();
      }
    } catch (cause) {
      // A failed check never reopens Pay: an unknown or paid state stays, anything else waits for a retry.
      setLookup((current) => current.state === "paid" || current.state === "unknown" ? current : { state: "check_failed", message: errorText(cause) });
    }
  }, []);

  useEffect(() => { void reconcile(); }, [reconcile, statement.digest]);
  // While an outcome is unknown, keep checking on its own.
  useEffect(() => {
    if (lookup.state !== "unknown") return;
    const timer = window.setInterval(() => void reconcile(), 10_000);
    return () => window.clearInterval(timer);
  }, [lookup.state, reconcile]);

  async function pay() {
    setBusy("pay");
    setError("");
    try {
      const result = await source.payStatement(card, statement, mandate);
      prefill(result);
      if (result.outcome === "unknown") {
        // Signed and handed off with no answer: never "not paid", and no second payment.
        setUnknownReason(result.reason);
        setLookup({ state: "unknown", receiptPda: result.receiptPda, mandatePda: result.mandatePda });
        return;
      }
      setPaid(result);
      setLookup({ state: "paid", receiptPda: result.receiptPda, mandatePda: result.mandatePda });
      await source.submitRepayment(card.cardId, statement.statementId, { receiptPda: result.receiptPda, mandatePda: result.mandatePda });
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  async function createPermission() {
    setBusy("permission");
    setError("");
    try {
      const address = await source.createRepaymentPermission(card, statement);
      setCreated((current) => [...current, address]);
      setMandate(address);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  async function check() {
    setBusy("check");
    setError("");
    try {
      // Unresolved or unchecked: look on Solana first, by statement, across every permission.
      if (lookup.state === "unknown" || lookup.state === "check_failed" || !receiptPda.trim() || !mandatePda.trim()) {
        await reconcile();
        return;
      }
      await source.submitRepayment(card.cardId, statement.statementId, { receiptPda: receiptPda.trim(), mandatePda: mandatePda.trim() });
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <Dialog isOpen onOpenChange={(next) => { if (!next) onClose(); }} purpose="form" width={560}>
      <Layout
        height="auto"
        header={<DialogHeader title="Pay statement" onOpenChange={(next) => { if (!next) onClose(); }} />}
        content={
          <LayoutContent>
            <div className="cp-repay" data-testid="repayment-dialog">
              <p className="cp-sim-strip">{SIMULATED_CREDIT_LABEL}</p>
              {privateActions && (
                <div className="cp-repay-methods" role="radiogroup" aria-label="How to pay">
                  <Button type="button" variant={method === "transparent" ? "primary" : "secondary"} label="From a spending permission" aria-checked={method === "transparent"} role="radio" onClick={() => setMethod("transparent")} />
                  <Button type="button" variant={method === "private" ? "primary" : "secondary"} label="Privately with MagicBlock" aria-checked={method === "private"} role="radio" onClick={() => setMethod("private")} />
                </div>
              )}
              {method === "private" && privateActions ? (
                <PrivateRepayOptIn amountCents={total.toString()} {...privateActions} onDone={() => onDone()} onBack={() => setMethod("transparent")} />
              ) : <>
              {lookup.state === "checking" && <p className="owner-muted" aria-busy="true" data-testid="repay-checking">Checking whether this statement was already paid…</p>}
              {lookup.state === "check_failed" && (
                <div className="builder-error" role="alert" data-testid="repay-check-failed"><b>Couldn't check earlier payments</b><span>{lookup.message} Pay stays off until ChainPay can confirm this statement wasn't already paid. Use “Check my receipt” below to try again.</span></div>
              )}
              {lookup.state === "unknown" && !paid && (
                <div className="cp-repay-unknown" role="status" data-testid="repay-unknown">
                  <b>Outcome unknown — checking</b>
                  <span>{unknownReason || "You signed a payment for this statement, but no answer came back."} Don't pay again. ChainPay keeps checking Solana for receipt <span className="mono">{shortKey(lookup.receiptPda)}</span> from permission <span className="mono">{shortKey(lookup.mandatePda)}</span>. Pay stays off until it's settled one way or the other.</span>
                </div>
              )}
              <div className="mandate-summary">
                <div><span>Amount</span><strong>{formatUsdCents(total)} <small className="cp-sub">= {baseUnits.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} USDC base units</small></strong></div>
                <div><span>Token</span><strong>USDC on Solana Devnet</strong></div>
                <div><span>Pays</span><strong>{target.recipientTokenAccount ? <span className="mono">Simulated partner · {shortKey(target.recipientTokenAccount)}</span> : "Simulated partner (account not set yet)"}</strong></div>
                <div><span>Statement reference</span><strong className="mono">{statement.digest ? shortKey(statement.digest) : "Not computed yet"}</strong></div>
              </div>
              <p className="owner-muted">ChainPay never pays on its own. The statement closes only when the receipt matches the token, network, amount and reference exactly, and the simulated partner confirms it.</p>
              <h3>Pay from a repayment permission</h3>
              <p className="owner-muted">The card's repay agent <span className="mono">{shortKey(repayAgent)}</span> pays through ChainPay under a permission you sign, for this amount only. It can't spend anything else.</p>
              {eligible.length ? (
                <Selector label="Repayment permission" value={mandate} onChange={setMandate} options={eligible.map((address) => ({ value: address, label: `USDC repayment permission · ${shortKey(address)}` }))} description="Only permissions you signed for this card's repay agent, for Devnet USDC." />
              ) : (
                <div className="cp-repay-permission" data-testid="repay-permission-needed">
                  <p className="owner-muted">First sign a one-time permission for {formatUsdCents(total)} in Devnet USDC, approved for this card's repay agent.</p>
                  <Button type="button" variant="secondary" label={busy === "permission" ? "Waiting for wallet…" : "Create repayment permission"} isDisabled={Boolean(busy) || Boolean(target.conflict) || total <= 0n} onClick={() => void createPermission()} />
                </div>
              )}
              <h3>Already paid?</h3>
              <TextInput label="Receipt address" value={receiptPda} onChange={setReceiptPda} placeholder="The repayment's receipt address" />
              <TextInput label="Spending permission address" value={mandatePda} onChange={setMandatePda} placeholder="The permission that paid" />
              {paid && (
                <div className="cp-repay-paid" role="status" data-testid="repay-paid">
                  <b>Paid. ChainPay hasn't confirmed it against the statement yet.</b>
                  <span>Receipt <span className="mono">{paid.receiptPda}</span>. Don't pay again: use “Check my receipt” to retry the confirmation.</span>
                </div>
              )}
              {target.conflict && <div className="builder-error" role="alert"><b>Can't pay here</b><span>{target.conflict}</span></div>}
              {error && <div className="builder-error" role="alert"><b>{paid || lookup.state === "unknown" || lookup.state === "paid" ? "Not confirmed yet" : "Not paid"}</b><span>{error}</span></div>}
              </>}
            </div>
          </LayoutContent>
        }
        footer={
          method === "private" ? undefined : <LayoutFooter>
            <div className="cp-dialog-footer">
            <Button type="button" variant="secondary" label={busy === "check" ? "Checking…" : "Check my receipt"} isDisabled={Boolean(busy) || ((!receiptPda.trim() || !mandatePda.trim()) && lookup.state !== "check_failed" && lookup.state !== "unknown")} onClick={() => void check()} />
            <Button type="button" variant="primary" label={busy === "pay" ? "Waiting for wallet…" : `Pay ${formatUsdCents(total)}`} isDisabled={Boolean(busy) || Boolean(paid) || lookup.state !== "none" || !mandate || !target.recipientTokenAccount || Boolean(target.conflict) || !statement.digest} onClick={() => void pay()} />
          </div></LayoutFooter>
        }
      />
    </Dialog>
  );
}
