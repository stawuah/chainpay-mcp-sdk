import { useSyncExternalStore } from "react";

// Set when this tab just finished a wallet sign-in, so the dashboard can open
// with Bam Bam's loader. A reload with a saved session never sets it.

let justSignedIn = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function markJustSignedIn() {
  justSignedIn = true;
  emit();
}

export function clearJustSignedIn() {
  if (!justSignedIn) return;
  justSignedIn = false;
  emit();
}

export function useJustSignedIn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => justSignedIn,
    () => false,
  );
}
