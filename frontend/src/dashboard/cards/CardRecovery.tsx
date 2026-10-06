import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { formatUsdCents, type CardView } from "@chainpayhq/sdk";
import type { CardRecoveryView, CardsSource, RecoveryRules } from "./source";
import { errorText } from "./shared";
import { formatWhen, shortKey } from "./ui";

/** Owner-assisted recovery (contracts §8, ruling K12). Never a reset; the card stays frozen until the owner unfreezes. */
export function RecoveryBanner({ source, card, recovery, onChanged }: { source: CardsSource; card: CardView; recovery: CardRecoveryView; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const report = recovery.report;
  const restored = recovery.state === "restored_pending_reconcile";

  async function rebuild() {
    setBusy(true);
    setError("");
    try {
      await source.requestRecoveryReport(card);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function act() {
    if (!report) return;
    setBusy(true);
    setError("");
    try {
      if (restored) await source.confirmReconciled(card, report);
      else await source.restore(card, report);
      setOpen(false);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cp-recovery" data-testid="recovery-banner" data-recovery={recovery.state}>
      <Banner
        status={restored ? "warning" : "error"}
        title={restored ? "Restored. Confirm the numbers match." : "We lost track of this card's private records, so we froze it."}
        description={restored
          ? "The card's numbers are back. Confirm they match the card network's records. It stays frozen until you unfreeze it."
          : "Nothing new can be spent. Review the exact numbers we rebuilt, then approve the restore. Nothing is reset."}
        endContent={<Button type="button" variant="primary" label={restored ? "Review and confirm" : "Review and restore"} isDisabled={!report} onClick={() => setOpen(true)} />}
      />
      {!report && (
        <div className="cp-recovery-pending">
          <p className="owner-muted">ChainPay rebuilds the numbers from your encrypted backup and the card network. Nothing is signed until you review them.</p>
          <Button type="button" variant="secondary" label={busy ? "Rebuilding…" : "Rebuild the numbers"} isDisabled={busy} onClick={() => void rebuild()} />
          {error && <p className="cp-inline-error" role="alert">{error}</p>}
        </div>
      )}
      <Dialog isOpen={open} onOpenChange={(next) => { if (!next) setOpen(false); }} purpose="form" width={540}>
        <Layout
          height="auto"
          header={<DialogHeader title={restored ? "Confirm it all matches" : "Restore this card"} onOpenChange={(next) => { if (!next) setOpen(false); }} />}
          content={
            <LayoutContent>
              {report && (
                <div className="cp-recovery-report" data-testid="recovery-report">
                  <p>{report.reason} Detected {formatWhen(report.detectedAt)}.</p>
                  <div className="mandate-summary">
                    {report.numbers.map((row) => <div key={row.key ?? row.label}><span>{row.label}</span><strong>{row.cents !== undefined ? formatUsdCents(row.cents) : row.count}</strong></div>)}
                  </div>
                  {report.rules ? <RulesReview rules={report.rules} /> : (
                    <p className="owner-muted" data-testid="recovery-rules-note">The restore keeps this card's rules exactly as your private records hold them: limits, shops, categories, fee and ChainPay's approver. Your browser checks that before you sign and refuses anything else.</p>
                  )}
                  <p className="owner-muted">Rebuilt from your encrypted backup at log position {report.snapshotLedgerSeq}, plus {report.issuerEventsReplayed} card network event{report.issuerEventsReplayed === 1 ? "" : "s"} since. Report fingerprint <code>{report.digest.slice(0, 12)}</code>.</p>
                  <ol className="cp-recovery-steps">
                    <li data-done={restored ? "yes" : "no"}>Approve the restore in your wallet</li>
                    <li data-done="no">Confirm it all matches</li>
                    <li data-done="no">Unfreeze when you're ready</li>
                  </ol>
                  {error && <div className="builder-error" role="alert"><b>Not restored</b><span>{error}</span></div>}
                </div>
              )}
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <div className="cp-dialog-footer">
              <Button type="button" variant="secondary" label="Not now" onClick={() => setOpen(false)} />
              <Button type="button" variant="primary" label={busy ? "Waiting for wallet…" : restored ? "Confirm it all matches" : "Approve restore"} isDisabled={busy} onClick={() => void act()} />
            </div></LayoutFooter>
          }
        />
      </Dialog>
    </div>
  );
}

/** The rules the restore writes, shown so the owner reviews them too; the browser refuses a restore that differs. */
function RulesReview({ rules }: { rules: RecoveryRules }) {
  const ends = rules.expiresAt === "0" ? "No end date" : new Date(Number(rules.expiresAt) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <div className="mandate-summary" data-testid="recovery-rules">
      <div><span>Max per purchase</span><strong>{formatUsdCents(rules.maxPurchaseCents)}</strong></div>
      <div><span>Purchases per period</span><strong>{rules.maxPurchasesPerPeriod === 0 ? "No count limit" : rules.maxPurchasesPerPeriod}</strong></div>
      <div><span>Period</span><strong>Every {Math.round(rules.periodSeconds / 86_400)} days</strong></div>
      <div><span>Shops</span><strong>{rules.merchantIdHashes.length === 0 ? "Any shop in the categories" : `${rules.merchantIdHashes.length} shop${rules.merchantIdHashes.length === 1 ? "" : "s"}`}</strong></div>
      <div><span>Categories</span><strong>{rules.mccs.length ? rules.mccs.join(", ") : "Only the shops"}</strong></div>
      <div><span>Repeat charges</span><strong>{rules.recurringAllowed ? "Allowed" : "Not allowed"}</strong></div>
      <div><span>ChainPay fee</span><strong>{(rules.feeBps / 100).toFixed(2)}%</strong></div>
      <div><span>Card ends</span><strong>{ends}</strong></div>
      <div><span>ChainPay approver</span><strong className="mono">{shortKey(rules.authorizer)}</strong></div>
    </div>
  );
}
