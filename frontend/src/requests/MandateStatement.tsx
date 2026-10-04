import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Download } from "lucide-react";
import type { Mandate, PaymentReceipt } from "@chainpay/sdk";
import { chainpayClient } from "../config/client";
import { buildPath } from "../routing/paths";
import { receiptViewFromSettledPayment } from "../receipts/load";
import { formatDisplayAmount } from "../ui/amount/formatDisplayAmount";
import { buildReceiptsCsv, downloadTextFile, statementCsvFilename } from "../receipts/export";
import { ownerOrderSummary, ownerReceiptRelay } from "../receipts/owner";
import "../receipts/receipt-card.css";
import "./permission-request.css";

type StatementRow = {
  receipt: PaymentReceipt;
  amount: string;
  pill?: string;
  description?: string;
  poNumber?: string;
};

/** The mandate expiry label as the tail of the totals line. */
export function expiresPhrase(label: string): string {
  if (label === "Expired") return "expired";
  if (label.startsWith("Expiry slot ")) return `expires at slot ${label.slice("Expiry slot ".length)}`;
  if (label.startsWith("Estimated ")) return `expires ≈ ${label.slice("Estimated ".length)}`;
  return `expires ${label}`;
}

/**
 * "Budget 50.00 USDC · Spent 12.00 USDC · Left 38.00 USDC · 3 payments · expires ≈ Nov 1, 2026".
 * Without verified decimals the amounts are left out (never shown as unscaled units);
 * the caller shows the raw units in a technical disclosure.
 */
export function statementTotals(mandate: Pick<Mandate, "totalLimit" | "amountSpent" | "paymentCount">, decimals: number | null, token: string, expires: string): string {
  const left = mandate.totalLimit > mandate.amountSpent ? mandate.totalLimit - mandate.amountSpent : 0n;
  const count = mandate.paymentCount === 1n ? "1 payment" : `${mandate.paymentCount.toString()} payments`;
  const amounts = decimals === null
    ? ["Amounts unavailable until the token’s decimals load"]
    : [
      `Budget ${formatDisplayAmount(mandate.totalLimit, decimals)} ${token}`,
      `Spent ${formatDisplayAmount(mandate.amountSpent, decimals)} ${token}`,
      `Left ${formatDisplayAmount(left, decimals)} ${token}`,
    ];
  return [...amounts, count, expiresPhrase(expires)].join(" · ");
}

/**
 * A sponsor's statement for one spending permission: totals, this
 * permission's receipts with their Order match, and a CSV of just these.
 * Owner data only; there is no public statement page.
 */
export function MandateStatement({
  mandate,
  decimals,
  token,
  expires,
}: {
  mandate: Mandate;
  decimals: number | null;
  token: string;
  expires: string;
}) {
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "error">("idle");
  const [exportMessage, setExportMessage] = useState("");

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setRows([]);
    void (async () => {
      try {
        const receipts = (await chainpayClient.getPaymentsByMandate(mandate.address))
          .sort((left, right) => (left.executedAtSlot === right.executedAtSlot ? 0 : left.executedAtSlot > right.executedAtSlot ? -1 : 1));
        const cache = new Map<string, Promise<unknown>>();
        const next = await Promise.all(receipts.map(async (receipt): Promise<StatementRow> => {
          const amount = decimals === null ? "Amount unavailable" : `${formatDisplayAmount(receipt.amount, decimals)} ${token}`;
          const view = receiptViewFromSettledPayment(receipt, decimals);
          if (!view) return { receipt, amount };
          const summary = await ownerOrderSummary(view, cache).catch(() => ({} as Awaited<ReturnType<typeof ownerOrderSummary>>));
          return {
            receipt,
            amount,
            ...(summary.orderMatch ? { pill: summary.orderMatch } : {}),
            ...(summary.description ? { description: summary.description } : {}),
            ...(summary.poNumber ? { poNumber: summary.poNumber } : {}),
          };
        }));
        if (!active) return;
        setRows(next);
        setStatus("ready");
      } catch {
        if (active) setStatus("error");
      }
    })();
    return () => { active = false; };
  }, [mandate.address, decimals, token]);

  async function downloadCsv() {
    if (exportStatus === "exporting") return;
    setExportStatus("exporting");
    setExportMessage("");
    try {
      const byAddress = new Map(rows.map((row) => [row.receipt.address, row]));
      const csv = await buildReceiptsCsv({
        receipts: rows.map((row) => row.receipt),
        decimalsByMint: new Map([[mandate.allowedMint, decimals]]),
        tokenLabel: () => token,
        origin: window.location.origin,
        blockTime: (slot) => chainpayClient.connection.getBlockTime(Number(slot)),
        relayPolicy: (address) => ownerReceiptRelay.policy(address),
        order: async (receipt) => {
          const row = byAddress.get(receipt.address);
          return row ? { ...(row.poNumber ? { poNumber: row.poNumber } : {}), ...(row.pill ? { orderMatch: row.pill } : {}) } : null;
        },
      });
      const filename = statementCsvFilename(mandate.address);
      downloadTextFile(csv, filename);
      setExportStatus("idle");
      setExportMessage(`Saved ${filename} · ${rows.length} ${rows.length === 1 ? "receipt" : "receipts"}.`);
    } catch {
      setExportStatus("error");
      setExportMessage("The CSV could not be created. Your receipts are unchanged. Try again.");
    }
  }

  return (
    <section className="mandate-statement" aria-labelledby={`mandate-statement-${mandate.address}`}>
      <div className="mandate-statement-head">
        <h3 id={`mandate-statement-${mandate.address}`}>Statement</h3>
        <Button
          type="button"
          variant="secondary"
          label={exportStatus === "exporting" ? "Exporting…" : "Download CSV"}
          icon={<Download size={16} />}
          isDisabled={status !== "ready" || exportStatus === "exporting"}
          onClick={() => void downloadCsv()}
        />
      </div>
      <p className="mandate-statement-totals">{statementTotals(mandate, decimals, token, expires)}</p>
      {decimals === null && (
        <details className="cp-amount-raw">
          <summary>raw units</summary>
          <code>budget {mandate.totalLimit.toString()} · spent {mandate.amountSpent.toString()} · left {(mandate.totalLimit > mandate.amountSpent ? mandate.totalLimit - mandate.amountSpent : 0n).toString()}</code>
        </details>
      )}
      {status === "loading" && <p className="mandate-statement-note" aria-busy="true">Reading this permission’s receipts…</p>}
      {status === "error" && <p className="mandate-statement-note" role="alert">Receipts could not be read from Solana. Totals above are from the permission itself.</p>}
      {status === "ready" && rows.length === 0 && <p className="mandate-statement-note">No payments under this permission yet.</p>}
      {rows.length > 0 && (
        <ul className="mandate-statement-list">
          {rows.map((row) => (
            <li key={row.receipt.address}>
              <span>
                <strong>{row.amount}</strong>
                <small>{row.description ?? "No signed invoice"}{row.poNumber ? ` · ${row.poNumber}` : ""} · slot {row.receipt.executedAtSlot.toString()}</small>
                <a href={buildPath({ kind: "app", tab: "receipts", receiptDetail: row.receipt.address })}>Open receipt</a>
              </span>
              {row.pill && <span className="receipt-pill" data-pill={row.pill}>{row.pill}</span>}
            </li>
          ))}
        </ul>
      )}
      {exportMessage && <p className="mandate-statement-note" role="status">{exportMessage}</p>}
    </section>
  );
}
