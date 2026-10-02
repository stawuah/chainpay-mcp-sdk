import { useSyncExternalStore } from "react";
import { applyAction, decay, newPet, nudge, type Needs, type PetAction, type PetSnapshot } from "./sim/needs";
import {
  findSecret,
  gain,
  mistake,
  newBond,
  note,
  noteLowPower,
  rollDay,
  toggleGear,
  visit,
  type Bond,
  type DayEvent,
  type Gain,
  type Gear,
  type VisitResult,
} from "./sim/bond";

// Phase 1 keeps the pet on this device. Phase 2 swaps this store for one that
// syncs with /v1/pet on the backend; components only see `usePet()`.

const STORAGE_KEY = "chainpay.pet.v1";
const BOND_KEY = "chainpay.pet.bond.v1";
const TICK_MS = 30_000;

export type ReactionKind =
  | "happy"
  | "eat"
  | "spin"
  | "shake"
  | "grumpy"
  | "surprised"
  | "nope"
  | "dizzy"
  | "dance"
  | "flip"
  | "excited";

export type Reaction = { kind: ReactionKind; at: number };
/** reply = answer to something you did; volunteer = he spoke up; tour = about the section you are reading. */
export type SpeechSource = "reply" | "volunteer" | "tour";
export type Speech = { text: string; at: number; ms: number; source: SpeechSource; key?: string };

type PetState = {
  snapshot: PetSnapshot;
  bond: Bond;
  reaction: Reaction | null;
  speech: Speech | null;
  now: number;
};

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private windows and blocked storage just get a fresh robot.
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Memory only.
  }
}

function readSnapshot(now: number): PetSnapshot {
  const parsed = readJson<PetSnapshot>(STORAGE_KEY);
  if (parsed && typeof parsed.at === "number" && parsed.needs) return decay(parsed, now);
  return newPet(now);
}

function readBond(now: number): Bond {
  const parsed = readJson<Bond>(BOND_KEY);
  // Fill fields added in later versions so old saves keep working.
  if (parsed && typeof parsed.xp === "number") return rollDay({ ...newBond(now), ...parsed }, now);
  return newBond(now);
}

const REACTION_FOR: Record<PetAction, ReactionKind> = {
  feed: "eat",
  play: "spin",
  clean: "shake",
  pet: "happy",
  poke: "surprised",
};

const EVENT_FOR: Record<PetAction, DayEvent> = {
  feed: "fed",
  play: "played",
  clean: "polished",
  pet: "pats",
  poke: "pokes",
};

function createStore() {
  const startedAt = Date.now();
  let state: PetState = {
    snapshot: readSnapshot(startedAt),
    bond: readBond(startedAt),
    reaction: null,
    speech: null,
    now: startedAt,
  };
  const listeners = new Set<() => void>();
  let timer: number | undefined;

  const emit = () => listeners.forEach((listener) => listener());
  const set = (next: Partial<PetState>) => {
    state = { ...state, ...next };
    if (state.snapshot.lowPower) state = { ...state, bond: noteLowPower(state.bond, state.now) };
    writeJson(STORAGE_KEY, state.snapshot);
    writeJson(BOND_KEY, state.bond);
    emit();
  };

  const tick = () => {
    const now = Date.now();
    set({ snapshot: decay(state.snapshot, now), bond: rollDay(state.bond, now), now });
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

    act(action: PetAction, effect?: Partial<Needs>): { ok: boolean; retryMs?: number } {
      const now = Date.now();
      const result = applyAction(state.snapshot, action, now, effect);
      if (!result.ok) {
        set({ snapshot: result.snapshot, now, reaction: { kind: "nope", at: now } });
        return { ok: false, retryMs: result.retryMs };
      }
      const grumpy = action === "poke" && result.snapshot.grumpyUntil > now && state.snapshot.grumpyUntil <= now;
      let bond = note(state.bond, EVENT_FOR[action], now);
      if (action === "pet") bond = gain(bond, "pat", now);
      if (action === "feed" || action === "play" || action === "clean") bond = gain(bond, "care", now);
      set({
        snapshot: result.snapshot,
        bond,
        now,
        reaction: { kind: grumpy ? "grumpy" : REACTION_FOR[action], at: now },
      });
      return { ok: true };
    },

    /** Play rewards outside the care cooldowns: bugs, coins, calls, games. */
    reward(kind: Gain, event: DayEvent | null, delta: Partial<Needs> = {}, reaction?: ReactionKind) {
      const now = Date.now();
      let bond = gain(state.bond, kind, now);
      if (event) bond = note(bond, event, now);
      set({
        snapshot: nudge(state.snapshot, delta, now),
        bond,
        now,
        reaction: reaction ? { kind: reaction, at: now } : state.reaction,
      });
    },

    /** Something went wrong for him: a missed call, a bug that got away. */
    miss(event: DayEvent, delta: Partial<Needs> = {}) {
      const now = Date.now();
      set({ snapshot: nudge(state.snapshot, delta, now), bond: mistake(note(state.bond, event, now)), now });
    },

    note(event: DayEvent) {
      const now = Date.now();
      set({ bond: note(state.bond, event, now), now });
    },

    react(kind: ReactionKind) {
      const now = Date.now();
      set({ reaction: { kind, at: now }, now });
    },

    say(text: string, ms = 4_000, source: SpeechSource = "reply", key?: string) {
      const now = Date.now();
      set({ speech: { text, at: now, ms, source, key }, now });
    },

    hush() {
      if (state.speech) set({ speech: null });
    },

    visit(): VisitResult["greeting"] {
      const now = Date.now();
      const result = visit(state.bond, now);
      set({ bond: result.bond, now });
      return result.greeting;
    },

    toggleGear(item: Gear) {
      set({ bond: toggleGear(state.bond, item) });
    },

    secret(name: string): boolean {
      const now = Date.now();
      const result = findSecret(state.bond, name, now);
      if (result.fresh) set({ bond: result.bond, now });
      return result.fresh;
    },
  };
}

export const petStore = createStore();

export function usePet() {
  return useSyncExternalStore(petStore.subscribe, petStore.get);
}
