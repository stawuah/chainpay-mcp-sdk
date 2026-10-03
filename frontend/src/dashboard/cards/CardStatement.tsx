import { useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Check, FileText, Receipt, TriangleAlert } from "lucide-react";
import { centsToTokenBaseUnits, formatUsdCents, parseSignedCents, type CardView, type StatementView } from "@chainpay/sdk";
import { CardEvidenceCard } from "../../receipts/CardEvidenceCard";
import { statementEvidence } from "./evidence";
import { MISMATCH_COPY, STATEMENT_STATE_LABEL, STATEMENT_STEPS } from "./lifecycle";
import type { CardsSource } from "./source";
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

/** Purchases − refunds + Σ line fees, exact integers (contracts §7.1). */
export function statementLineTotals(statement: StatementView) {
  let purchases = 0n;
  let refunds = 0n;
  let fees = 0n;
  for (const line of statement.lines) {
    const amount = BigInt(line.amountCents);
    if (line.kind === "purchase" || line.kind === "adjustment_debit") purchases += amount;
    else refunds += amount;
    fees += parseSignedCents(line.feeCents);
  }
  const total = purchases - refunds + fees;
  return { purchases, refunds, fees, total, matches: total === parseSignedCents(statement.totalCents) && fees === parseSignedCents(statement.feeCents) };
}

function payable(statement: StatementView): boolean {
  return ["closed", "repayment_mismatch", "overdue"].includes(statement.state) && parseSignedCents(statement.totalCents) > 0n;
}

export function CardStatement({ source, card, statements, mandates, wallet, onChanged }: { source: CardsSource; card: CardView; statements: StatementView[] | null; mandates: MandateOption[]; wallet: string; onChanged: () => void }) {
  const [selected, setSelected] = useState(0);
  const [paying, setPaying] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  if (statements === null) return <p className="owner-muted" aria-busy="true">Loading statements…</p>;
  if (statements.length === 0) {
    return (
      <>
        <p className="cp-sim-strip" data-testid="sim-strip">{SIMULATED_CREDIT_LABEL}</p>
        <div className="owner-small-empty"><FileText /><h3>No statement yet</h3><p>A statement closes at the end of each period with every charge, refund and fee, to the cent.</p></div>
      </>
    );
  }
  const statement = statements[Math.min(selected, statements.length - 1)];
  const totals = statementLineTotals(statement);
  const stepIndex = STATEMENT_STEPS.findIndex((step) => step.key === statement.state);
  const evidence = statementEvidence(statement);

  return (
    <section className="cp-statement" data-state={statement.state} data-testid="card-statement">
      <p className="cp-sim-strip" data-testid="sim-strip">{SIMULATED_CREDIT_LABEL}</p>
      <div className="dashboard-card cp-statement-card">
        <div className="cp-statement-head">
          <div>
            <span className="owner-caption">Period {statement.periodIndex}{statement.closedAt ? ` · closed ${formatDay(statement.closedAt)}` : ""}</span>
            <h2>{formatUsdCents(statement.totalCents)} <small>{statement.state === "discharged" ? "paid off" : statement.dueAt ? `due ${formatDay(statement.dueAt)}` : ""}</small></h2>
            {statement.state === "discharged" && <span className="cp-paid-stamp" aria-hidden="true">Paid off</span>}
          </div>
          {statements.length > 1 && (
            <Selector label="Statement" isLabelHidden value={String(selected)} onChange={(value) => setSelected(Number(value))} options={statements.map((item, index) => ({ value: String(index), label: `Period ${item.periodIndex}` }))} />
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

        <table className="cp-statement-lines">
          <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Amount</th><th scope="col">Fee</th></tr></thead>
          <tbody>
            {statement.lines.map((line, index) => {
              const credit = line.kind === "refund" || line.kind === "adjustment_credit";
              return (
                <tr key={`${line.at}-${index}`} data-kind={line.kind}>
                  <td data-label="Date">{formatDay(line.at)}</td>
                  <td data-label="What">{LINE_LABEL[line.kind]}{line.merchant ? ` · ${line.merchant.displayName}` : ""}{line.exception && <span className="cp-line-flag"> · flagged for review</span>}</td>
                  <td data-label="Amount" className={credit ? "is-credit" : ""}>{credit ? `−${formatUsdCents(line.amountCents)}` : formatUsdCents(line.amountCents)}</td>
                  <td data-label="Fee">{parseSignedCents(line.feeCents) < 0n ? `−${formatUsdCents(line.feeCents.slice(1))}` : formatUsdCents(line.feeCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <dl className="cp-statement-totals">
          <div><dt>Purchases</dt><dd>{formatUsdCents(totals.purchases)}</dd></div>
          <div><dt>Refunds</dt><dd>−{formatUsdCents(totals.refunds)}</dd></div>
          <div><dt>ChainPay fees</dt><dd>{formatUsdCents(statement.feeCents)}</dd></div>
          <div className="is-total"><dt>Total</dt><dd>{formatUsdCents(statement.totalCents)}</dd></div>
        </dl>
        {!totals.matches && <p className="cp-inline-error" role="alert">These lines don't add up to the total ChainPay sent, so this statement can't be paid here until it's corrected.</p>}

        <div className="cp-statement-actions">
          {payable(statement) && totals.matches && <Button type="button" variant="primary" label={`Pay ${formatUsdCents(statement.totalCents)}`} onClick={() => setPaying(true)} />}
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

function RepaymentDialog({ source, card, statement, mandates, wallet, onClose, onDone }: { source: CardsSource; card: CardView; statement: StatementView; mandates: MandateOption[]; wallet: string; onClose: () => void; onDone: () => void }) {
  const target = source.repaymentTarget();
  const eligible = useMemo(() => mandates.filter((mandate) => mandate.status === "active" && mandate.approvedAgent === wallet && mandate.allowedMint === target.mint), [mandates, wallet, target.mint]);
  const [mandate, setMandate] = useState(eligible[0]?.address ?? "");
  const [receiptPda, setReceiptPda] = useState("");
  const [mandatePda, setMandatePda] = useState("");
  const [busy, setBusy] = useState<"" | "pay" | "check">("");
  // Once money moved, keep the receipt: a failed confirmation must never read as "not paid".
  const [paid, setPaid] = useState<{ receiptPda: string; mandatePda: string; signature?: string } | null>(null);
  const [error, setError] = useState("");
  const total = BigInt(statement.totalCents);
  const baseUnits = centsToTokenBaseUnits(total, target.decimals);

  async function pay() {
    setBusy("pay");
    setError("");
    try {
      const result = await source.payStatement(card, statement, mandate);
      setPaid(result);
      setReceiptPda(result.receiptPda);
      setMandatePda(result.mandatePda);
      await source.submitRepayment(card.cardId, statement.statementId, { receiptPda: result.receiptPda, mandatePda: result.mandatePda });
      onDone();
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
              <div className="mandate-summary">
                <div><span>Amount</span><strong>{formatUsdCents(total)} <small className="cp-sub">= {baseUnits.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} USDC base units</small></strong></div>
                <div><span>Token</span><strong>USDC on Solana Devnet</strong></div>
                <div><span>Pays</span><strong>{target.recipientTokenAccount ? <span className="mono">Simulated partner · {shortKey(target.recipientTokenAccount)}</span> : "Simulated partner (account not set yet)"}</strong></div>
                <div><span>Statement reference</span><strong className="mono">{statement.digest ? shortKey(statement.digest) : "Not computed yet"}</strong></div>
              </div>
              <p className="owner-muted">ChainPay never pays on its own. The statement closes only when the receipt matches the token, network, amount and reference exactly, and the simulated partner confirms it.</p>
              <h3>Pay from a spending permission</h3>
              {eligible.length ? (
                <Selector label="Spending permission" value={mandate} onChange={setMandate} options={eligible.map((item) => ({ value: item.address, label: `USDC permission · ${shortKey(item.address)}` }))} description="Only permissions you sign yourself, for Devnet USDC." />
              ) : (
                <p className="owner-muted">You need a USDC spending permission that you sign yourself (human signing). Create one in Spending permissions, then come back.</p>
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
              {error && <div className="builder-error" role="alert"><b>{paid ? "Not confirmed yet" : "Not paid"}</b><span>{error}</span></div>}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <div className="cp-dialog-footer">
            <Button type="button" variant="secondary" label={busy === "check" ? "Checking…" : "Check my receipt"} isDisabled={Boolean(busy) || !receiptPda.trim() || !mandatePda.trim()} onClick={() => void check()} />
            <Button type="button" variant="primary" label={busy === "pay" ? "Waiting for wallet…" : `Pay ${formatUsdCents(total)}`} isDisabled={Boolean(busy) || Boolean(paid) || !mandate || !target.recipientTokenAccount || !statement.digest} onClick={() => void pay()} />
          </div></LayoutFooter>
        }
      />
    </Dialog>
  );
}
