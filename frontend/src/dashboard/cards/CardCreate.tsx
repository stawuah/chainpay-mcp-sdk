import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowLeft, ArrowRight, Check, CircleCheck, CircleX, Loader, TriangleAlert } from "lucide-react";
import {
  CARD_MCC_NAMES,
  DEFAULT_CARD_FEE_BPS,
  formatUsdCents,
  mccLabel,
  normalizeCardDraft,
  policyReviewSummary,
  verifyCardDraftFragment,
  type CardDraftIntake,
} from "@chainpayhq/sdk";
import { PageHeader } from "../PageHeader";
import type { CardView } from "@chainpayhq/sdk";
import type { CardShop, CreateCardInput, CreateStepId, CreateStepState } from "./source";
import { errorText, type CardsShared } from "./shared";
import { centsToDollarInput, dollarsToCents } from "./amounts";
import { AgentCard } from "./AgentCard";
import { PRIVACY_COPY, PRIVACY_SHORT } from "./privacyCopy";

export const CREATE_STEPS: { id: CreateStepId; label: string; detail: string }[] = [
  { id: "prepare", label: "Get a card number ready", detail: "ChainPay asks the card network for a paused card." },
  { id: "base", label: "Create the card on Solana", detail: "3 approvals in your wallet. These only set up the card's accounts." },
  { id: "session", label: "Open your private session", detail: "1 message. It opens your private session, which reads and writes your card's private rules. It doesn't move money." },
  { id: "rules", label: "Save the limits privately", detail: "1 approval. Your limits go into the private rollup, not the public chain." },
  { id: "activate", label: "Turn the card on", detail: "ChainPay copies the limits to the card network and opens the card." },
];

type Form = {
  label: string;
  budget: string;
  maxPurchase: string;
  maxPurchases: string;
  periodDays: string;
  endsInDays: string;
  merchants: string[];
  mccs: number[];
  recurring: boolean;
  feeBps: number;
};

const EMPTY_FORM: Form = { label: "", budget: "", maxPurchase: "", maxPurchases: "0", periodDays: "30", endsInDays: "0", merchants: [], mccs: [], recurring: false, feeBps: DEFAULT_CARD_FEE_BPS };
const MCC_OPTIONS = [5734, 7372, 5817, 4816, 5045, 5942];
const PERIOD_OPTIONS = [{ value: "7", label: "Every 7 days" }, { value: "30", label: "Every 30 days" }, { value: "90", label: "Every 90 days" }];
const ENDS_OPTIONS = [{ value: "0", label: "No end date" }, { value: "30", label: "In 30 days" }, { value: "90", label: "In 90 days" }, { value: "365", label: "In a year" }];

/** Keep a value from an agent's draft selectable even when it isn't one of the usual choices. */
function withValue(options: { value: string; label: string }[], value: string, label: (value: string) => string) {
  return options.some((option) => option.value === value) ? options : [...options, { value, label: label(value) }].sort((a, b) => Number(a.value) - Number(b.value));
}
const STEP_LABELS = ["Limits", "Shops", "Review"];

type Intake = { kind: "none" } | { kind: "checking" } | { kind: "result"; result: CardDraftIntake };

/** Validate with the SDK's own draft rules so the dashboard and the agent tool agree on every message. */
function validate(form: Form, step: number, shops: CardShop[] | null): { input?: CreateCardInput; error?: string } {
  const budgetCents = dollarsToCents(form.budget);
  const maxPurchaseCents = dollarsToCents(form.maxPurchase);
  if (!form.label.trim()) return { error: "Give the card a name." };
  if (budgetCents === null) return { error: "Enter the budget in dollars, like 500 or 500.00." };
  if (maxPurchaseCents === null) return { error: "Enter the max per purchase in dollars, like 30." };
  const count = Number(form.maxPurchases);
  if (!Number.isInteger(count) || count < 0 || count > 65_535) return { error: "Purchases per period must be a whole number (0 means no limit)." };
  if (step >= 1 && form.merchants.length && !shops) return { error: "The shop list is still loading. Try again in a moment." };
  const unknown = shops ? form.merchants.find((ref) => !shops.some((shop) => shop.ref === ref)) : undefined;
  if (unknown) return { error: `"${unknown}" isn't a registered shop, so it can't go on the card.` };
  const endsIn = Number(form.endsInDays);
  try {
    const draft = normalizeCardDraft({
      label: form.label,
      budgetCents,
      maxPurchaseCents,
      merchants: step >= 1 ? form.merchants : [shops?.[0]?.ref ?? "demo-approved"],
      mccs: step >= 1 ? form.mccs : [],
      periodDays: Number(form.periodDays),
      expiresAt: endsIn > 0 ? new Date(Date.now() + endsIn * 86_400_000).toISOString() : null,
      feeBps: form.feeBps,
    });
    return {
      input: {
        label: draft.label, budgetCents: draft.budgetCents, maxPurchaseCents: draft.maxPurchaseCents, maxPurchasesPerPeriod: count,
        periodDays: draft.periodDays, merchants: draft.merchants, mccs: draft.mccs, expiresAt: draft.expiresAt, recurringAllowed: form.recurring, feeBps: draft.feeBps,
      },
    };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/**
 * Finishing a card whose limits weren't saved before setup stopped: the same
 * form and review, for the existing card, continuing `attemptId`.
 */
export type CardCreateResume = { card: CardView; attemptId: string; onCancel: () => void; onFinished: () => void };

export function CardCreate({ source, onUnlocked, onNavigate, notice, resume }: CardsShared & { resume?: CardCreateResume }) {
  const [form, setForm] = useState<Form>(() => (resume ? { ...EMPTY_FORM, label: resume.card.label } : EMPTY_FORM));
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [intake, setIntake] = useState<Intake>(() => (!resume && typeof window !== "undefined" && window.location.hash.includes("draft=") ? { kind: "checking" } : { kind: "none" }));
  const [progress, setProgress] = useState<Partial<Record<CreateStepId, { state: CreateStepState; detail?: string }>>>({});
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  // Stable across "Try again" so a retry resumes the same card instead of creating another.
  const attemptId = useRef(resume?.attemptId ?? globalThis.crypto.randomUUID());
  // Shops come from ChainPay's registry (live) so the hashes the owner signs match what checkout opens.
  const [shops, setShops] = useState<CardShop[] | null>(null);
  const [shopsError, setShopsError] = useState("");
  const loadShops = useCallback(() => {
    setShopsError("");
    source.merchants().then(setShops, (cause) => setShopsError(errorText(cause)));
  }, [source]);
  useEffect(() => { loadShops(); }, [loadShops]);
  const shopName = (ref: string) => shops?.find((shop) => shop.ref === ref)?.displayName ?? ref;

  // Agent draft intake (ruling K7): the fragment never leaves the browser; the
  // form fills only when the recomputed digest matches the one in the link.
  useEffect(() => {
    if (intake.kind !== "checking") return;
    let active = true;
    void verifyCardDraftFragment(window.location.hash).then((result) => {
      if (!active) return;
      setIntake({ kind: "result", result });
      if (result.status === "matched") {
        const draft = result.draft;
        setForm({
          ...EMPTY_FORM,
          label: draft.label,
          budget: centsToDollarInput(draft.budgetCents),
          maxPurchase: centsToDollarInput(draft.maxPurchaseCents),
          periodDays: String(draft.periodDays),
          endsInDays: draft.expiresAt ? String(Math.max(1, Math.ceil((Date.parse(draft.expiresAt) - Date.now()) / 86_400_000))) : "0",
          merchants: draft.merchants,
          mccs: draft.mccs,
          feeBps: draft.feeBps,
        });
      }
    });
    return () => { active = false; };
  }, [intake.kind]);

  useEffect(() => { heading.current?.focus(); }, [step]);

  const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  function next() {
    const result = validate(form, step, shops);
    if (result.error) { setError(result.error); return; }
    setError("");
    setStep((current) => Math.min(2, current + 1));
  }

  async function approve() {
    const result = validate(form, 2, shops);
    if (!result.input) { setError(result.error ?? "Check the limits."); return; }
    setRunning(true);
    setFailed("");
    setProgress({});
    try {
      const report = (id: CreateStepId, state: CreateStepState, detail?: string) => setProgress((current) => ({ ...current, [id]: { state, detail } }));
      if (resume) {
        await source.finishSetup(resume.card, result.input, report, attemptId.current);
        onUnlocked();
        resume.onFinished();
        return;
      }
      const cardId = await source.createCard(result.input, report, attemptId.current);
      onUnlocked();
      if (window.location.hash) history.replaceState(history.state, "", window.location.pathname);
      onNavigate({ cardId });
    } catch (cause) {
      setProgress((current) => {
        const active = steps.find((item) => current[item.id]?.state === "active");
        return active ? { ...current, [active.id]: { state: "failed" } } : current;
      });
      setFailed(errorText(cause));
    } finally {
      setRunning(false);
    }
  }

  const steps = resume ? CREATE_STEPS.filter((item) => item.id !== "prepare") : CREATE_STEPS;
  const review = step === 2 ? validate(form, 2, shops) : null;
  const summary = review?.input ? policyReviewSummary(BigInt(review.input.budgetCents), BigInt(review.input.maxPurchaseCents), review.input.feeBps) : null;
  const intakeResult = intake.kind === "result" ? intake.result : null;

  return (
    <>
      <PageHeader
        copy={resume
          ? { kicker: "AGENT CARDS", title: "Finish setup", subtitle: `Set the limits for “${resume.card.label}” again. They weren't saved before setup stopped.` }
          : { kicker: "AGENT CARDS", title: "New card", subtitle: "Set the limits. Your agent only ever sees what it may buy." }}
        action={resume
          ? <Button type="button" variant="secondary" label="Back to card" icon={<ArrowLeft size={16} />} isDisabled={running} onClick={resume.onCancel} />
          : <Button type="button" variant="secondary" label="Back to cards" icon={<ArrowLeft size={16} />} onClick={() => onNavigate({})} />}
      />
      {notice}
      <section className="owner-permission-wizard cp-card-create">
        <ol className="owner-stepper" aria-label="New card steps">
          {STEP_LABELS.map((label, index) => (
            <li key={label} className={index === step ? "current" : index < step ? "done" : ""} aria-current={step === index ? "step" : undefined}>
              <span>{index < step ? <Check size={16} /> : index + 1}</span>{label}
            </li>
          ))}
        </ol>
        <div className="owner-wizard-grid">
          <div>
            {intake.kind === "checking" && <p className="cp-intake" data-intake="checking">Checking the link from your agent…</p>}
            {intakeResult?.status === "matched" && (
              <div className="cp-intake" data-intake="matched" role="status">
                <CircleCheck size={18} aria-hidden="true" />
                <div><b>Your agent suggested this card.</b><small>Check code <code>{intakeResult.digest.slice(0, 8)}</code>. Make sure it matches the code in your agent's message: anyone can make a link like this, so the code is how you know it's the one your agent made. Read every limit before you approve; you can change any of them.</small></div>
              </div>
            )}
            {intakeResult && intakeResult.status !== "matched" && (
              <div className="cp-intake" data-intake={intakeResult.status} role="alert">
                <TriangleAlert size={18} aria-hidden="true" />
                <div>
                  <b>{intakeResult.status === "invalid" ? "This link can't be read, so nothing was filled in." : "This link doesn't match its own check code, so nothing was filled in."}</b>
                  <small>{intakeResult.status === "invalid" ? intakeResult.reason : intakeResult.status === "missing_digest" ? "The link has no check code. Ask your agent for a fresh link." : `The link says ${intakeResult.expected.slice(0, 8)}, but its contents give ${intakeResult.digest.slice(0, 8)}. It may have been edited. Ask your agent for a fresh link.`}</small>
                </div>
              </div>
            )}

            {step < 2 && (
              <section className="dashboard-card mandate-builder">
                <div className="owner-form-heading">
                  <span className="owner-caption">Step {step + 1} of 3</span>
                  <h2 ref={heading} tabIndex={-1}>{step === 0 ? "Set the limits" : "Pick where it can pay"}</h2>
                  <p>{step === 0 ? `Your agent can only spend inside these. ${PRIVACY_COPY}` : "Purchases anywhere else are declined."}</p>
                </div>
                {step === 0 ? (
                  <div className="cp-form-grid">
                    {!resume && <div className="field-wide"><TextInput label="Card name" value={form.label} onChange={(value) => update("label", value)} placeholder="Data API credits" description="Up to 40 characters. It's how the card shows in your dashboard." /></div>}
                    <TextInput label="Budget per period (USD)" value={form.budget} onChange={(value) => update("budget", value)} placeholder="500" description="The most it can spend each period." />
                    <TextInput label="Max per purchase (USD)" value={form.maxPurchase} onChange={(value) => update("maxPurchase", value)} placeholder="30" description="The most it can spend at once." />
                    <Selector className="cp-create-select" label="Period" value={form.periodDays} onChange={(value) => update("periodDays", value)} options={withValue(PERIOD_OPTIONS, form.periodDays, (days) => `Every ${days} day${days === "1" ? "" : "s"}`)} />
                    <TextInput label="Purchases per period" value={form.maxPurchases} onChange={(value) => update("maxPurchases", value)} description="0 means no count limit." />
                    <Selector className="cp-create-select" label="Card ends" value={form.endsInDays} onChange={(value) => update("endsInDays", value)} options={withValue(ENDS_OPTIONS, form.endsInDays, (days) => `In ${days} day${days === "1" ? "" : "s"}`)} />
                  </div>
                ) : (
                  <div className="cp-shop-pick">
                    <fieldset>
                      <legend>Shops</legend>
                      {shops === null && !shopsError && <p className="owner-muted" aria-busy="true">Loading shops…</p>}
                      {shopsError && (
                        <div className="builder-error" role="alert"><b>Shops didn't load</b><span>{shopsError}</span><Button type="button" variant="secondary" label="Try again" onClick={loadShops} /></div>
                      )}
                      {shops?.map((merchant) => (
                        <CheckboxInput key={merchant.ref} label={merchant.displayName} description={`${mccLabel(merchant.mcc)} · sandbox shop`} value={form.merchants.includes(merchant.ref)} onChange={() => update("merchants", toggle(form.merchants, merchant.ref))} />
                      ))}
                    </fieldset>
                    <fieldset>
                      <legend>Or any shop in these categories</legend>
                      {[...MCC_OPTIONS, ...form.mccs.filter((mcc) => !MCC_OPTIONS.includes(mcc))].map((mcc) => (
                        <CheckboxInput key={mcc} label={CARD_MCC_NAMES[mcc] ?? `Category ${String(mcc).padStart(4, "0")}`} description={`Category ${mcc}`} value={form.mccs.includes(mcc)} onChange={() => update("mccs", toggle(form.mccs, mcc))} />
                      ))}
                    </fieldset>
                    <CheckboxInput label="Allow repeat charges" description="Lets shops charge again on their own, like a subscription. Off by default." value={form.recurring} onChange={(value) => update("recurring", value)} />
                  </div>
                )}
                {error && <div className="builder-error" role="alert"><b>Needs attention</b><span>{error}</span></div>}
                <div className="owner-form-actions">
                  {step > 0 && <Button type="button" variant="secondary" label="Back" icon={<ArrowLeft size={16} />} onClick={() => { setError(""); setStep(step - 1); }} />}
                  <Button type="button" variant="primary" label={step === 0 ? "Pick shops" : "Review"} icon={<ArrowRight size={18} />} onClick={next} />
                </div>
              </section>
            )}

            {step === 2 && (
              <section className="dashboard-card mandate-builder cp-card-review" data-testid="card-review">
                <div className="owner-form-heading">
                  <span className="owner-caption">Step 3 of 3</span>
                  <h2 ref={heading} tabIndex={-1}>Review before you approve</h2>
                  <p>These are the exact numbers. Nothing is signed yet.</p>
                </div>
                {summary && review?.input ? (
                  <>
                    <div className="cp-money-box" data-testid="money-box">
                      <div data-row="allowance"><span>Purchase allowance</span><strong>{summary.display.budget}</strong></div>
                      <div data-row="fee"><span>ChainPay fee</span><strong>{summary.display.fee} · up to {formatUsdCents(summary.feeCentsAtFullBudget)}</strong></div>
                      <div data-row="max-obligation" className="cp-money-box-total"><span>Most you could owe this period</span><strong>{summary.display.maxObligation}</strong></div>
                      <p className="cp-sim-note">Card purchases run on simulated credit in the sandbox. No credit is extended.</p>
                    </div>
                    <div className="mandate-summary cp-review-rows">
                      <div><span>Card name</span><strong>{review.input.label}</strong></div>
                      <div><span>Max per purchase</span><strong>{summary.display.maxPurchase}</strong></div>
                      <div><span>Period</span><strong>Every {review.input.periodDays} days</strong></div>
                      <div><span>Purchases per period</span><strong>{review.input.maxPurchasesPerPeriod === 0 ? "No count limit" : review.input.maxPurchasesPerPeriod}</strong></div>
                      <div><span>Shops</span><strong>{review.input.merchants.length ? review.input.merchants.map(shopName).join(", ") : "Any shop in the categories below"}</strong></div>
                      <div><span>Categories</span><strong>{review.input.mccs.length ? review.input.mccs.map(mccLabel).join(", ") : "Only the shops above"}</strong></div>
                      <div><span>Repeat charges</span><strong>{review.input.recurringAllowed ? "Allowed" : "Not allowed"}</strong></div>
                      <div><span>Card ends</span><strong>{review.input.expiresAt ? new Date(review.input.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "No end date"}</strong></div>
                      <div><span>Who can read the limits</span><strong>You, ChainPay's approver (it can't change them), readers you add and the card issuer. {PRIVACY_SHORT}</strong></div>
                    </div>
                  </>
                ) : (
                  <div className="builder-error" role="alert"><b>Needs attention</b><span>{review?.error}</span></div>
                )}
                {(running || failed || Object.keys(progress).length > 0) && (
                  <ol className="cp-create-steps" aria-label="What happens when you approve" data-testid="create-steps">
                    {steps.map((item) => {
                      const entry = progress[item.id];
                      const state = entry?.state ?? "waiting";
                      return (
                        <li key={item.id} data-state={state}>
                          <span className="cp-step-mark" aria-hidden="true">{state === "done" ? <CircleCheck size={18} /> : state === "failed" ? <CircleX size={18} /> : state === "active" ? <Loader size={18} /> : <span className="cp-step-dot" />}</span>
                          <div><b>{item.label}</b><small>{entry?.detail ?? item.detail}</small></div>
                          <span className="cp-visually-hidden">{state}</span>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {failed && <div className="builder-error" role="alert"><b>Stopped at this step</b><span>{failed}</span></div>}
                {!running && !failed && Object.keys(progress).length === 0 && (
                  <p className="owner-muted cp-approve-note">{resume
                    ? "Approving takes 1 wallet approval. It saves these limits privately, then ChainPay turns the card on."
                    : "Approving takes 4 wallet approvals and 1 message, one per step below. Each one says what it does."}</p>
                )}
                <div className="owner-form-actions">
                  <Button type="button" variant="secondary" label="Back" icon={<ArrowLeft size={16} />} isDisabled={running} onClick={() => setStep(1)} />
                  <Button type="button" variant="primary" label={running ? "Waiting for wallet…" : failed ? "Try again" : "Approve in wallet"} isDisabled={running || !summary} onClick={() => void approve()} />
                </div>
              </section>
            )}
          </div>
          <aside className="owner-wizard-aside cp-preview-aside" aria-label="Card preview">
            <AgentCard label={form.label.trim()} pendingNote={step === 2 ? (running ? "Approving" : "Waiting for you") : "Private"} />
            <p className="cp-preview-caption">{step === 2 ? "This is the card your agent gets once you approve." : "Your card, as you set it up."} The last four arrive from the card network when it's issued.</p>
            <ul><li>Limits hidden from the public chain</li><li>Freeze it in one tap</li><li>Every purchase lands as a receipt</li></ul>
          </aside>
        </div>
      </section>
    </>
  );
}
