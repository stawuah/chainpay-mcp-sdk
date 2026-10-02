import { useSyncExternalStore } from "react";
import { applyAction, decay, newPet, type PetAction, type PetSnapshot } from "./sim/needs";

// Phase 1 keeps the pet on this device. Phase 2 swaps this store for one that
// syncs with /v1/pet on the backend; components only see `usePet()`.

const STORAGE_KEY = "chainpay.pet.v1";
const TICK_MS = 30_000;

export type Reaction = { kind: "happy" | "eat" | "spin" | "shake" | "grumpy" | "surprised" | "nope"; at: number };

type PetState = { snapshot: PetSnapshot; reaction: Reaction | null; now: number };

function read(now: number): PetSnapshot {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PetSnapshot;
      if (parsed && typeof parsed.at === "number" && parsed.needs) return decay(parsed, now);
    }
  } catch {
    // Private windows and blocked storage just get a fresh robot.
  }
  return newPet(now);
}

function write(snapshot: PetSnapshot) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Same as above: memory only.
  }
}

const REACTION_FOR: Record<PetAction, Reaction["kind"]> = {
  feed: "eat",
  play: "spin",
  clean: "shake",
  pet: "happy",
  poke: "surprised",
};

function createStore() {
  const startedAt = Date.now();
  let state: PetState = { snapshot: read(startedAt), reaction: null, now: startedAt };
  const listeners = new Set<() => void>();
  let timer: number | undefined;

  const emit = () => listeners.forEach((listener) => listener());
  const set = (next: PetState) => {
    state = next;
    write(state.snapshot);
    emit();
  };

  const tick = () => {
    const now = Date.now();
    set({ ...state, snapshot: decay(state.snapshot, now), now });
  };

  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) timer = window.setInterval(tick, TICK_MS);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.clearInterval(timer);
      };
    },
    act(action: PetAction): { ok: boolean; retryMs?: number } {
      const now = Date.now();
      const result = applyAction(state.snapshot, action, now);
      if (!result.ok) {
        set({ ...state, snapshot: result.snapshot, now, reaction: { kind: "nope", at: now } });
        return { ok: false, retryMs: result.retryMs };
      }
      const grumpy = action === "poke" && result.snapshot.grumpyUntil > now && state.snapshot.grumpyUntil <= now;
      set({
        snapshot: result.snapshot,
        now,
        reaction: { kind: grumpy ? "grumpy" : REACTION_FOR[action], at: now },
      });
      return { ok: true };
    },
  };
}

export const petStore = createStore();

export function usePet() {
  return useSyncExternalStore(petStore.subscribe, petStore.get);
}
