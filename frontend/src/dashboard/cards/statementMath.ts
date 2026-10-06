import type { StatementView } from "@chainpayhq/sdk";

/** Exactly what a repayment must carry: the statement's amount due (after carried credit), never negative. */
export function statementAmountDue(statement: StatementView): bigint {
  const due = statement.amountDueCents ?? statement.payWith?.amountCents ?? statement.totalCents;
  const value = BigInt(due);
  return value > 0n ? value : 0n;
}
