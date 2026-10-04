/*
  Explicit collection states (EXPERIENCE.md, 2026-10-04). A list the workspace
  could not read is never shown as zero, "none" or "all clear".

  - signed-out: the data needs an owner session that isn't open.
  - loading:    the first read is in flight.
  - empty:      a successful read returned nothing.
  - partial:    some sources answered and some did not; what loaded is shown.
  - failed:     nothing could be read.
  - loaded:     a successful read returned records.
*/
export type CollectionStateKind = "signed-out" | "loading" | "empty" | "partial" | "failed" | "loaded";

export type CollectionInput = {
  /** False when the collection needs a session that isn't open. Omit for public reads. */
  signedIn?: boolean;
  status: "idle" | "loading" | "ready" | "error";
  count: number;
  /** Sources that failed while others succeeded. */
  failedSources?: number;
};

export function deriveCollectionState({ signedIn = true, status, count, failedSources = 0 }: CollectionInput): CollectionStateKind {
  if (!signedIn) return "signed-out";
  if (status === "idle" || status === "loading") return count > 0 ? "loaded" : "loading";
  if (status === "error") return count > 0 ? "partial" : "failed";
  if (failedSources > 0) return count > 0 ? "partial" : "failed";
  return count > 0 ? "loaded" : "empty";
}

/** Whether a count read from this collection may be shown as a number. */
export function countIsKnown(state: CollectionStateKind): boolean {
  return state === "loaded" || state === "empty";
}

/** A count for display: the number when it is known, otherwise null (render "—" plus the reason). */
export function knownCount(state: CollectionStateKind, count: number): number | null {
  return countIsKnown(state) ? count : null;
}
