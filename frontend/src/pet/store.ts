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
    if (next.snapshot) writeJson(STORAGE_KEY, state.snapshot);
    if (next.bond) writeJson(BOND_KEY, state.bond);
    emit();
  };

  const tick = () => exclusive(() => {
    const now = Date.now();
    const snapshot = decay(state.snapshot, now);
    let bond = state.bond;
    // Attribute an episode before midnight before closing that diary page.
    const [year, month, day] = bond.today.day.split("-").map(Number);
    const endOfLoggedDay = new Date(year!, month! - 1, day! + 1).getTime() - 1;
    if (state.snapshot.at <= endOfLoggedDay && decay(state.snapshot, Math.min(now, endOfLoggedDay)).lowPower) {
      bond = noteLowPower(bond, Math.min(now, endOfLoggedDay));
    }
    bond = rollDay(bond, now);
    if (snapshot.lowPower) bond = noteLowPower(bond, now);
    // Only bookkeeping transitions persist, and they re-read under the same
    // lock as care. Ordinary projection and animation never overwrite saves.
    if (bond !== state.bond) set({ snapshot, bond, now });
    else { state = { ...state, snapshot, bond, now }; emit(); }
  }, true);

  const reload = (preserveTime = false) => {
    const now = Date.now();
    const savedSnapshot = readJson<PetSnapshot>(STORAGE_KEY);
    const savedBond = readJson<Bond>(BOND_KEY);
    // Blocked/cleared storage must not erase this tab's in-memory companion.
    state = { ...state,
      snapshot: savedSnapshot?.needs && typeof savedSnapshot.at === "number" ? (preserveTime ? savedSnapshot : decay(savedSnapshot, now)) : (preserveTime ? state.snapshot : decay(state.snapshot, now)),
      bond: typeof savedBond?.xp === "number" ? (preserveTime ? { ...newBond(now), ...savedBond } : rollDay({ ...newBond(now), ...savedBond }, now)) : (preserveTime ? state.bond : rollDay(state.bond, now)),
      now,
    };
  };
  window.addEventListener("storage", event => { if (event.key === STORAGE_KEY || event.key === BOND_KEY) { reload(); emit(); } });
  const exclusive = <T,>(work: () => T, preserveTime = false): Promise<T> => {
    const run = () => { reload(preserveTime); return work(); };
    return navigator.locks ? navigator.locks.request("chainpay.pet.legacy", run) : Promise.resolve(run());
  };

  const operations = {
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

    /** Play rewards outside the care cooldowns: specks, coins, calls, games. */
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

    /** Something went wrong for him: a missed call, a speck that got away. */
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
      set({ snapshot: decay(state.snapshot, now), bond: result.bond, now });
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
  // Serialize read/modify/write across browser tabs. Purely local animation and
  // polling never rewrite another tab's persisted progress.
  return {
    ...operations,
    act: (...args: Parameters<typeof operations.act>) => exclusive(() => operations.act(...args)),
    reward: (...args: Parameters<typeof operations.reward>) => exclusive(() => operations.reward(...args)),
    miss: (...args: Parameters<typeof operations.miss>) => exclusive(() => operations.miss(...args)),
    note: (...args: Parameters<typeof operations.note>) => exclusive(() => operations.note(...args)),
    visit: () => exclusive(() => operations.visit()),
    toggleGear: (...args: Parameters<typeof operations.toggleGear>) => exclusive(() => operations.toggleGear(...args)),
    secret: (...args: Parameters<typeof operations.secret>) => exclusive(() => operations.secret(...args)),
  };
}

export const petStore = createStore();

export function usePet() {
  return useSyncExternalStore(petStore.subscribe, petStore.get);
}
