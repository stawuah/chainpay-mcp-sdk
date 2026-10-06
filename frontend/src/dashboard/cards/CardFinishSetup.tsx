import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CircleCheck, CircleX, Loader } from "lucide-react";
import type { CardView } from "@chainpayhq/sdk";
import { CREATE_STEPS } from "./CardCreate";
import { finishSetupCopy } from "./lifecycle";
import { LimitsNeededError, type CardsSource, type CreateStepId, type CreateStepState, type SetupProgress } from "./source";
import { errorText } from "./shared";

/** Every step after the card number: the ones a stopped setup can still be missing. */
export const FINISH_STEPS = CREATE_STEPS.filter((step) => step.id !== "prepare");

type Steps = Partial<Record<CreateStepId, { state: CreateStepState; detail?: string }>>;

/** Steps already done before the owner presses anything, so the list starts where setup stopped. */
function startingSteps(progress: SetupProgress | null, unlocked: boolean): Steps {
  if (!progress) return {};
  const steps: Steps = {};
  if (progress.baseLeft === 0) steps.base = { state: "done" };
  if (progress.baseLeft === 0 && unlocked) steps.session = { state: "done" };
  if (progress.rulesSaved === true) steps.rules = { state: "done" };
  return steps;
}

export type CardFinishSetupProps = {
  source: CardsSource;
  card: CardView;
  unlocked: boolean;
  onUnlocked: () => void;
  /** The limits weren't saved: the owner sets them again, continuing this attempt. */
  onLimitsNeeded: (attemptId: string) => void;
  onFinished: () => void;
};

/**
 * A card whose setup stopped before it was turned on. Says where it stopped and
 * what finishing takes, then resumes from the first step that isn't done.
 */
export function CardFinishSetup({ source, card, unlocked, onUnlocked, onLimitsNeeded, onFinished }: CardFinishSetupProps) {
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [steps, setSteps] = useState<Steps>({});
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState("");
  // Stable across "Try again", so a retry continues the same attempt.
  const attemptId = useRef(globalThis.crypto.randomUUID());

  useEffect(() => {
    let active = true;
    source.setupProgress(card).then(
      (next) => { if (active) setProgress(next); },
      // Unknown progress still lets the owner finish; the copy just can't count the steps.
      () => { if (active) setProgress(null); },
    );
    return () => { active = false; };
  }, [source, card, unlocked]);

  async function finish() {
    setRunning(true);
    setFailed("");
    setSteps(startingSteps(progress, unlocked));
    try {
      await source.finishSetup(card, null, (id, state, detail) => setSteps((current) => ({ ...current, [id]: { state, detail } })), attemptId.current);
      onUnlocked();
      onFinished();
    } catch (cause) {
      if (cause instanceof LimitsNeededError) {
        onUnlocked();
        onLimitsNeeded(attemptId.current);
        return;
      }
      setSteps((current) => {
        const active = FINISH_STEPS.find((item) => current[item.id]?.state === "active");
        return active ? { ...current, [active.id]: { state: "failed" } } : current;
      });
      setFailed(errorText(cause));
    } finally {
      setRunning(false);
    }
  }

  const copy = finishSetupCopy(progress ?? { baseLeft: 0, rulesSaved: null }, unlocked);
  const shown = running || failed ? steps : startingSteps(progress, unlocked);
  return (
    <div className="cp-finish-setup" data-testid="finish-setup">
      <p className="cp-activation-detail"><b>{copy.headline}</b> The card can't be used until setup is finished.</p>
      <ol className="cp-create-steps cp-finish-steps" aria-label="Setting up this card" data-testid="finish-steps">
        {FINISH_STEPS.map((item) => {
          const entry = shown[item.id];
          const state = entry?.state ?? "waiting";
          return (
            <li key={item.id} data-step={item.id} data-state={state}>
              <span className="cp-step-mark" aria-hidden="true">{state === "done" ? <CircleCheck size={18} /> : state === "failed" ? <CircleX size={18} /> : state === "active" ? <Loader size={18} /> : <span className="cp-step-dot" />}</span>
              <div><b>{item.label}</b><small>{entry?.detail ?? item.detail}</small></div>
              <span className="cp-visually-hidden">{state}</span>
            </li>
          );
        })}
      </ol>
      {failed && <div className="builder-error" role="alert"><b>Stopped at this step</b><span>{failed}</span></div>}
      <div className="cp-finish-actions">
        <Button type="button" variant="primary" label={running ? "Finishing setup…" : failed ? "Try again" : "Finish setup"} isDisabled={running} onClick={() => void finish()} />
        <small className="owner-muted" data-testid="finish-cost">{copy.cost}</small>
      </div>
    </div>
  );
}
