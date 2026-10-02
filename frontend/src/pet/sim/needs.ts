// Pure need math for the site pet. No DOM, no storage, no clock reads: every
// function takes `now` so the backend port (pet/sim.rs) can share fixtures.

export const NEEDS = ["battery", "joy", "clean"] as const;
export type Need = (typeof NEEDS)[number];
export type Needs = Record<Need, number>;

export type PetAction = "feed" | "play" | "clean" | "pet" | "poke";

export type PetSnapshot = {
  needs: Needs;
  /** When `needs` was last folded forward. */
  at: number;
  bornAt: number;
  lowPower: boolean;
  /** Last accepted time per action, for cooldowns. */
  lastAction: Partial<Record<PetAction, number>>;
  /** A night poke keeps him awake (and grumpy) until this time. */
  grumpyUntil: number;
};

export const DECAY_PER_HOUR: Needs = { battery: 4, joy: 6, clean: 3 };
export const SLEEP_DECAY_FACTOR = 0.3;
export const NIGHT_START_UTC = 22;
export const NIGHT_END_UTC = 6;
export const LOW_POWER_ENTER = 15;
export const LOW_POWER_EXIT = 35;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const COOLDOWN_MS: Record<PetAction, number> = {
  feed: 10 * MINUTE,
  play: 10 * MINUTE,
  clean: 10 * MINUTE,
  pet: 1_000,
  poke: 1_000,
};

const EFFECTS: Record<PetAction, Partial<Needs>> = {
  feed: { battery: 20 },
  play: { joy: 18, battery: -3 },
  clean: { clean: 25 },
  pet: { joy: 2 },
  poke: { joy: -1 },
};

export const STAGES = [
  { stage: "boot", fromDays: 0 },
  { stage: "sprout", fromDays: 3 },
  { stage: "kid", fromDays: 14 },
  { stage: "teen", fromDays: 45 },
  { stage: "adult", fromDays: 120 },
] as const;
export type Stage = (typeof STAGES)[number]["stage"];

export type Mood = "asleep" | "grumpy" | "low" | "happy" | "okay" | "meh";

const clamp = (value: number) => Math.min(100, Math.max(0, value));

export function isNight(ms: number): boolean {
  const hour = new Date(ms).getUTCHours();
  return hour >= NIGHT_START_UTC || hour < NIGHT_END_UTC;
}

/**
 * Hours between two instants, with night hours counted at SLEEP_DECAY_FACTOR.
 * Walks UTC hour boundaries so a gap that spans dusk is weighted correctly.
 * Gaps longer than 30 days are capped: he is flat by then anyway.
 */
export function weightedHours(from: number, to: number): number {
  if (to <= from) return 0;
  const start = Math.max(from, to - 30 * DAY);
  let total = 0;
  let cursor = start;
  while (cursor < to) {
    const nextHour = Math.min(to, Math.floor(cursor / HOUR) * HOUR + HOUR);
    const span = (nextHour - cursor) / HOUR;
    total += isNight(cursor) ? span * SLEEP_DECAY_FACTOR : span;
    cursor = nextHour;
  }
  return total;
}

function nextLowPower(previous: boolean, needs: Needs): boolean {
  const values = NEEDS.map((need) => needs[need]);
  if (Math.min(...values) < LOW_POWER_ENTER) return true;
  if (values.every((value) => value > LOW_POWER_EXIT)) return false;
  return previous;
}

export function newPet(now: number): PetSnapshot {
  return {
    needs: { battery: 80, joy: 70, clean: 90 },
    at: now,
    bornAt: now,
    lowPower: false,
    lastAction: {},
    grumpyUntil: 0,
  };
}

/** Fold decay forward to `now`. Never moves time backwards. */
export function decay(snapshot: PetSnapshot, now: number): PetSnapshot {
  if (now <= snapshot.at) return snapshot;
  const hours = weightedHours(snapshot.at, now);
  const needs = { ...snapshot.needs };
  for (const need of NEEDS) needs[need] = clamp(needs[need] - DECAY_PER_HOUR[need] * hours);
  return { ...snapshot, needs, at: now, lowPower: nextLowPower(snapshot.lowPower, needs) };
}

export type ActionResult =
  | { ok: true; snapshot: PetSnapshot }
  | { ok: false; snapshot: PetSnapshot; retryMs: number };

export function applyAction(snapshot: PetSnapshot, action: PetAction, now: number): ActionResult {
  const current = decay(snapshot, now);
  const last = current.lastAction[action];
  if (last !== undefined && now - last < COOLDOWN_MS[action]) {
    return { ok: false, snapshot: current, retryMs: COOLDOWN_MS[action] - (now - last) };
  }
  const needs = { ...current.needs };
  for (const need of NEEDS) needs[need] = clamp(needs[need] + (EFFECTS[action][need] ?? 0));
  const asleep = isNight(now) && current.grumpyUntil <= now;
  return {
    ok: true,
    snapshot: {
      ...current,
      needs,
      lowPower: nextLowPower(current.lowPower, needs),
      lastAction: { ...current.lastAction, [action]: now },
      // Poking a sleeping robot wakes him for a minute, and he lets you know.
      grumpyUntil: action === "poke" && asleep ? now + MINUTE : current.grumpyUntil,
    },
  };
}

export function stageFor(bornAt: number, now: number): Stage {
  const days = (now - bornAt) / DAY;
  let stage: Stage = "boot";
  for (const entry of STAGES) if (days >= entry.fromDays) stage = entry.stage;
  return stage;
}

export function moodOf(snapshot: PetSnapshot, now: number): Mood {
  if (snapshot.grumpyUntil > now) return "grumpy";
  if (isNight(now)) return "asleep";
  if (snapshot.lowPower) return "low";
  const average = NEEDS.reduce((sum, need) => sum + snapshot.needs[need], 0) / NEEDS.length;
  if (average >= 70) return "happy";
  if (average >= 40) return "okay";
  return "meh";
}
