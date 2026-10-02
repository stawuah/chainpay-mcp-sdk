// Everything he says, in one place. Voice per the council ruling (P6/P7):
// lowercase, no exclamation marks, no emoji, no jargon. Product lines stay
// accurate to the landing page: Devnet, illustrative examples, no real money.

import type { Mood, PetAction } from "../sim/needs";

export const MOOD_LINES: Record<Mood, string> = {
  happy: "life's good. thanks for stopping by.",
  okay: "just floating around. you?",
  meh: "could use some attention, not gonna lie.",
  low: "low power… someone plug me in?",
  asleep: "zzz. dreaming in UTC.",
  grumpy: "i was SLEEPING.",
};

export const DONE_LINES: Record<PetAction, string> = {
  feed: "nom. battery up.",
  play: "wheee.",
  clean: "squeaky clean.",
  pet: "hehe.",
  poke: "hey.",
};

export const COOLING_LINES: Partial<Record<PetAction, (m: number) => string>> = {
  feed: (m) => `still full. back in ${m}m.`,
  play: (m) => `need a breather. ${m}m.`,
  clean: (m) => `already shiny. ${m}m.`,
};

export const GREETINGS = {
  first: "oh hi. i'm new here. no name yet.",
  back: "oh hey. you came back.",
  streak: (days: number) => `welcome back. day ${days} in a row.`,
} as const;

export const BOOT_LINE = "booting… ok. hi.";

export const COIN_LINES = ["mine.", "caught it.", "shiny.", "imaginary coin. real joy."] as const;
export const COIN_HINT = "click anywhere to toss. esc to cancel.";

export const BUG_LINES = {
  spawn: "ew. a bug.",
  squash: ["got it.", "bug squashed.", "thanks. that one was crunchy."],
  escaped: "a bug got away. i feel slightly worse.",
} as const;

export const CALL_LINES = {
  answered: ["you came. ^^", "just checking you're still there.", "ok that's all. thanks."],
  missedLater: "i called earlier. nobody came. it's fine.",
} as const;

export const SECRET_LINES = {
  dizzy: "whoa. room's spinning.",
  dance: "ok ok i'll dance.",
  konami: "↑↑↓↓←→←→ba. respect.",
  gm: "gm.",
  found: "secret found.",
} as const;

/** Said once per session when a landing section scrolls into view. */
export const TOUR_LINES: Record<string, string> = {
  "spend-limits": "this is the allowance part. agents get a budget, not your keys.",
  "payment-review": "4.50 USDC, and you see it before your wallet does.",
  receipts: "receipts. my favourite part.",
  "stay-in-control": "pause or revoke anytime. please don't revoke me.",
  developers: "devs: it fits the agent tools you already use.",
  faq: "good questions. read these before you approve anything.",
};

export const CTA_LINE = "ooh. that's where the fun is.";

export const GAME_COPY = {
  title: "Allowance",
  rules: "Catch coins to spend exactly 10 USDC. Anything over the limit gets blocked.",
  practice: "Practice round. No real USDC.",
  start: "Start",
  again: "Play again",
  back: "Back",
  blocked: "Over the limit · blocked",
  won: "Exactly 10. The limit held.",
  lostUnder: (spent: string) => `Spent ${spent} of 10. The rest stays in your wallet.`,
  wonLine: "we did it. not a cent over.",
  lostLine: "close. the limit still held though.",
} as const;
