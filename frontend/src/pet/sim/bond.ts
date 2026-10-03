// Pure bond math: friendship XP, levels, gear, visit streaks and the diary.
// Like needs.ts, nothing here reads a clock or storage; `now` is passed in.

export const LEVELS = [
  { level: "stranger", label: "Stranger", fromXp: 0 },
  { level: "regular", label: "Regular", fromXp: 20 },
  { level: "friend", label: "Friend", fromXp: 60 },
  { level: "best", label: "Best friend", fromXp: 150 },
] as const;
export type Level = (typeof LEVELS)[number]["level"];

export const GEAR = [
  { gear: "antenna", label: "Antenna", unlock: "regular" },
  { gear: "scarf", label: "Scarf", unlock: "friend" },
  { gear: "cap", label: "Cap", unlock: "best" },
] as const;
export type Gear = (typeof GEAR)[number]["gear"];

export type Gain =
  | "visit"
  | "pat"
  | "care"
  | "speck"
  | "call"
  | "coin"
  | "game-won"
  | "game-played"
  | "secret";

const XP: Record<Gain, number> = {
  visit: 2,
  pat: 1,
  care: 3,
  speck: 1,
  call: 5,
  coin: 1,
  "game-won": 5,
  "game-played": 1,
  secret: 3,
};

/** Pats and coins are cheap to spam, so they stop paying after a few a day. */
const DAILY_CAP: Partial<Record<Gain, number>> = { pat: 5, coin: 5, speck: 10 };
export const DAILY_XP_CAP = 40;

/** What happened today, for the diary. */
export type DayLog = {
  day: string;
  fed: number;
  played: number;
  polished: number;
  pats: number;
  pokes: number;
  specks: number;
  specksMissed: number;
  calls: number;
  callsMissed: number;
  coins: number;
  games: number;
  wins: number;
  dizzy: number;
  secrets: number;
  lowPower: boolean;
};

export type DiaryEntry = { day: string; text: string };

export type Bond = {
  xp: number;
  xpToday: number;
  gainsToday: Partial<Record<Gain, number>>;
  firstSeen: number;
  lastVisitDay: string;
  streak: number;
  visitDays: number;
  mistakes: number;
  gearOn: Gear[];
  today: DayLog;
  diary: DiaryEntry[];
  secretsFound: string[];
};

export type DayEvent = Exclude<keyof DayLog, "day" | "lowPower">;

const DIARY_KEEP = 14;

/** Local calendar day, YYYY-MM-DD, in the visitor's own time zone. */
export function dayKey(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBetween(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toDay.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function emptyDay(day: string): DayLog {
  return {
    day,
    fed: 0,
    played: 0,
    polished: 0,
    pats: 0,
    pokes: 0,
    specks: 0,
    specksMissed: 0,
    calls: 0,
    callsMissed: 0,
    coins: 0,
    games: 0,
    wins: 0,
    dizzy: 0,
    secrets: 0,
    lowPower: false,
  };
}

export function newBond(now: number): Bond {
  const day = dayKey(now);
  return {
    xp: 0,
    xpToday: 0,
    gainsToday: {},
    firstSeen: now,
    lastVisitDay: "",
    streak: 0,
    visitDays: 0,
    mistakes: 0,
    gearOn: [],
    today: emptyDay(day),
    diary: [],
    secretsFound: [],
  };
}

export function levelOf(xp: number) {
  let current: (typeof LEVELS)[number] = LEVELS[0];
  for (const entry of LEVELS) if (xp >= entry.fromXp) current = entry;
  const index = LEVELS.indexOf(current);
  const next = LEVELS[index + 1] ?? null;
  return { ...current, next, toNext: next ? next.fromXp - xp : 0 };
}

export function unlockedGear(xp: number): Gear[] {
  const reached = new Set<string>(LEVELS.filter((entry) => xp >= entry.fromXp).map((entry) => entry.level));
  return GEAR.filter((entry) => reached.has(entry.unlock)).map((entry) => entry.gear);
}

// ---- Diary --------------------------------------------------------------

function pick<T>(day: string, salt: number, options: readonly T[]): T {
  let hash = salt;
  for (const char of day) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return options[hash % options.length]!;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** One short lowercase entry in his voice, built only from what happened. */
export function diaryText(log: DayLog): string {
  const lines: string[] = [];
  const care = log.fed + log.played + log.polished;
  if (care === 0 && log.pats === 0 && log.specks === 0 && log.calls === 0) {
    return pick(log.day, 1, ["quiet day. i floated a lot.", "nobody came by. i counted pixels.", "slow one. i practised blinking."]);
  }
  if (log.fed > 0) lines.push(pick(log.day, 2, [`got charged ${plural(log.fed, "time", "times")}.`, `battery top-ups: ${log.fed}.`]));
  if (log.polished > 0) lines.push(pick(log.day, 3, ["someone polished me. felt fancy.", "got shined up. visor gleaming."]));
  if (log.wins > 0) lines.push(`won ${plural(log.wins, "round", "rounds")} of allowance. the limit held.`);
  else if (log.games > 0) lines.push("played allowance. close one.");
  if (log.specks > 0) lines.push(`${plural(log.specks, "dust speck", "dust specks")} swept up. not by me.`);
  if (log.specksMissed > 0) lines.push(`${plural(log.specksMissed, "speck", "specks")} drifted off.`);
  if (log.calls > 0) lines.push(log.calls === 1 ? "i called. someone came." : `called ${log.calls} times. people came.`);
  if (log.callsMissed > 0) lines.push(log.callsMissed === 1 ? "called once. you were busy." : "called a couple of times. you were busy.");
  if (log.coins > 0) lines.push(`caught ${plural(log.coins, "coin", "coins")}. all imaginary, all mine.`);
  if (log.dizzy > 0) lines.push("got shaken. room still spinning.");
  if (log.pokes > 2) lines.push("too many pokes.");
  if (log.secrets > 0) lines.push("someone found a secret.");
  if (log.lowPower) lines.push("ran low on power at one point.");
  if (log.pats >= 3) lines.push(pick(log.day, 4, ["lots of pats.", "head pats: plenty."]));
  return lines.slice(0, 3).join(" ");
}

function active(log: DayLog) {
  return Object.entries(log).some(([key, value]) => key !== "day" && key !== "lowPower" && typeof value === "number" && value > 0);
}

// ---- Updates ------------------------------------------------------------

/** Move the bond onto today's date, closing yesterday's diary page if needed. */
export function rollDay(bond: Bond, now: number): Bond {
  const day = dayKey(now);
  if (bond.today.day === day) return bond;
  const diary = active(bond.today)
    ? [...bond.diary, { day: bond.today.day, text: diaryText(bond.today) }].slice(-DIARY_KEEP)
    : bond.diary;
  return { ...bond, today: emptyDay(day), diary, xpToday: 0, gainsToday: {} };
}

export type VisitResult = { bond: Bond; greeting: "first" | "back" | "streak" | "same-day" };

/** Called once per page load. */
export function visit(bond: Bond, now: number): VisitResult {
  const rolled = rollDay(bond, now);
  const day = dayKey(now);
  if (!rolled.lastVisitDay) {
    return { bond: gain({ ...rolled, lastVisitDay: day, streak: 1, visitDays: 1 }, "visit", now), greeting: "first" };
  }
  if (rolled.lastVisitDay === day) return { bond: rolled, greeting: "same-day" };
  const gap = daysBetween(rolled.lastVisitDay, day);
  const streak = gap === 1 ? rolled.streak + 1 : 1;
  const next = { ...rolled, lastVisitDay: day, streak, visitDays: rolled.visitDays + 1 };
  return { bond: gain(next, "visit", now), greeting: streak > 1 ? "streak" : "back" };
}

export function gain(bond: Bond, kind: Gain, now: number): Bond {
  const rolled = rollDay(bond, now);
  const used = rolled.gainsToday[kind] ?? 0;
  const capped = DAILY_CAP[kind] !== undefined && used >= DAILY_CAP[kind]!;
  const room = Math.max(0, DAILY_XP_CAP - rolled.xpToday);
  const amount = capped ? 0 : Math.min(XP[kind], room);
  const xp = rolled.xp + amount;
  // New gear goes on automatically when it unlocks; the visitor can take it off.
  const before = unlockedGear(rolled.xp);
  const fresh = unlockedGear(xp).filter((item) => !before.includes(item));
  return {
    ...rolled,
    xp,
    xpToday: rolled.xpToday + amount,
    gainsToday: { ...rolled.gainsToday, [kind]: used + 1 },
    gearOn: [...rolled.gearOn, ...fresh],
  };
}

export function note(bond: Bond, event: DayEvent, now: number, by = 1): Bond {
  const rolled = rollDay(bond, now);
  return { ...rolled, today: { ...rolled.today, [event]: rolled.today[event] + by } };
}

export function noteLowPower(bond: Bond, now: number): Bond {
  const rolled = rollDay(bond, now);
  return rolled.today.lowPower ? rolled : { ...rolled, today: { ...rolled.today, lowPower: true } };
}

export function mistake(bond: Bond): Bond {
  return { ...bond, mistakes: bond.mistakes + 1 };
}

export function toggleGear(bond: Bond, item: Gear): Bond {
  if (!unlockedGear(bond.xp).includes(item)) return bond;
  const on = bond.gearOn.includes(item);
  return { ...bond, gearOn: on ? bond.gearOn.filter((value) => value !== item) : [...bond.gearOn, item] };
}

export function findSecret(bond: Bond, secret: string, now: number): { bond: Bond; fresh: boolean } {
  if (bond.secretsFound.includes(secret)) return { bond, fresh: false };
  const next = note({ ...bond, secretsFound: [...bond.secretsFound, secret] }, "secrets", now);
  return { bond: gain(next, "secret", now), fresh: true };
}

/** Today's page, written so far, for the diary view. */
export function todaySoFar(bond: Bond): DiaryEntry | null {
  return active(bond.today) ? { day: bond.today.day, text: diaryText(bond.today) } : null;
}
