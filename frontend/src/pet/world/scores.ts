// Snake's best score per browser (`chainpay.pet.games.v1`) and the session
// tally for tic-tac-toe.

export type Game = "snake" | "ttt";
type Level = "chill" | "normal" | "spicy";
type Saved = { snakeBest?: number };

const KEY = "chainpay.pet.games.v1";
const TALLY_KEY = "chainpay.pet.ttt.tally";

function read(): Saved {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

function write(next: Saved) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Memory only.
  }
}

export const readBest = (): number => read().snakeBest ?? 0;

export function writeBest(score: number) {
  write({ ...read(), snakeBest: score });
}

// Dre's call (2026-10-04): the game and its difficulty are Bam Bam's pick,
// never shown, a fresh roll each time.
const LEVELS: Level[] = ["chill", "normal", "spicy"];
export const randomLevel = (rand: () => number = Math.random): Level => LEVELS[Math.min(2, Math.floor(rand() * 3))];
export const randomGame = (rand: () => number = Math.random): Game => (rand() < 0.5 ? "snake" : "ttt");

export type Tally = { you: number; draws: number; bam: number };
const EMPTY: Tally = { you: 0, draws: 0, bam: 0 };

export function readTally(): Tally {
  try {
    return { ...EMPTY, ...(JSON.parse(window.sessionStorage.getItem(TALLY_KEY) ?? "{}") as Partial<Tally>) };
  } catch {
    return EMPTY;
  }
}

export function writeTally(next: Tally) {
  try {
    window.sessionStorage.setItem(TALLY_KEY, JSON.stringify(next));
  } catch {
    // Memory only.
  }
}
