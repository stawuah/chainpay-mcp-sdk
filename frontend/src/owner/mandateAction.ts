import type { MandateAction } from "./runtime";

/**
 * The paused flag to send with update_mandate. "resume" and "update" share the
 * update instruction, and the program assigns this value unconditionally, so
 * "resume" must clear it while every other update preserves the current state —
 * otherwise editing limits on a paused mandate would silently resume it.
 */
export function pausedAfterMandateAction(action: MandateAction, currentStatus: string): boolean {
  return action === "resume" ? false : currentStatus === "paused";
}
