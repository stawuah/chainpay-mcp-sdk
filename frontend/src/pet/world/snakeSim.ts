// Snake with Bam Bam as the head. Pure and import-free so the unit tests can
// load it on its own; SnakeGame.tsx draws it and adds the jelly.
//
// Movement is continuous: the head steers toward the last asked-for direction
// at a turn rate that rises with speed, so the turn radius stays the same.
// The body follows the head's recorded path, each blob a fixed distance behind
// (path-history follow-the-leader, as in slither.io clones; formulas after
// littensy/slither, MIT). The speed curve eases toward a cap so later runs get
// harder without becoming a reflex test.

export type Level = "chill" | "normal" | "spicy";
export type Dir = "up" | "down" | "left" | "right";
export type Vec = { x: number; y: number };

export type LevelConfig = {
  base: number; // px/s
  cap: number; // px/s
  tau: number; // specks for ~63% of the ramp
  wrap: boolean;
  forgiveMs: number;
  drift: boolean;
  points: number;
};

export const LEVELS: Record<Level, LevelConfig> = {
  chill: { base: 120, cap: 180, tau: 40, wrap: true, forgiveMs: 0, drift: false, points: 2 },
  normal: { base: 140, cap: 240, tau: 25, wrap: false, forgiveMs: 80, drift: false, points: 3 },
  spicy: { base: 160, cap: 300, tau: 15, wrap: false, forgiveMs: 0, drift: true, points: 4 },
};

// Council ruling B24–B26 (bam-bam-loader-ruling-2026-10-04): one logical field
// on every device, so speeds and tests don't depend on screen size.
export const FIELD_W = 480;
export const FIELD_H = 360;
export const STEP = 1 / 120;
export const HEAD_R = 14;
export const BLOB_R = 10;
export const BLOB_R_TAIL = 7;
export const TAPER = 6;
export const FOOD_R = 10;
export const SPACING = 7;
export const HEAD_GAP = HEAD_R;
export const TURN_RADIUS = 16;
export const START_BLOBS = 10;
export const BLOBS_PER_SPECK = 3;
const TURN_TIMEOUT_S = 0.09;
export const GRACE_S = 1.5;
export const STREAK_S = 3;
export const MAX_BLOBS = 200;
const QUEUE_MAX = 3;
const TURN_DONE = Math.PI / 180;
const SAMPLE_MIN = 1.5;
const FOOD_HEAD_MIN = 120;
const FOOD_WALL_MIN = 80;
const FOOD_TRIES = 30;
/** The blobs right behind the head always touch it, so they never count. */
export const NECK = Math.ceil((2 * HEAD_R) / SPACING) + 2;

export const ANGLE: Record<Dir, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

export type Food = Vec & { vx: number; vy: number };

export type SnakeState = {
  w: number;
  h: number;
  level: Level;
  t: number;
  head: Vec;
  heading: number;
  desired: number;
  queue: number[];
  turnStartedAt: number;
  /** Recorded head path, oldest first, with running distance in `ps`. */
  px: number[];
  py: number[];
  ps: number[];
  dist: number;
  blobs: number;
  food: Food;
  eaten: number;
  score: number;
  lastEatAt: number;
  /** Times a speck was eaten, newest last; the renderer ripples from these. */
  eats: number[];
  hitSince: number | null;
  status: "playing" | "over" | "won";
  cause: "wall" | "tail" | null;
};

export const wrapAngle = (a: number) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};
export const angleDiff = (to: number, from: number) => wrapAngle(to - from);

export const speedFor = (level: Level, eaten: number) => {
  const c = LEVELS[level];
  return c.base + (c.cap - c.base) * (1 - Math.exp(-eaten / c.tau));
};
export const turnRateFor = (speed: number) => speed / TURN_RADIUS;

/** Start in the middle, heading away from the nearer wall, with a short tail. */
export function createSnake(w: number, h: number, level: Level, rand: () => number = Math.random): SnakeState {
  const head = { x: w / 2, y: h / 2 };
  const heading = w >= h ? (rand() < 0.5 ? 0 : Math.PI) : rand() < 0.5 ? -Math.PI / 2 : Math.PI / 2;
  const state: SnakeState = {
    w,
    h,
    level,
    t: 0,
    head,
    heading,
    desired: heading,
    queue: [],
    turnStartedAt: 0,
    px: [],
    py: [],
    ps: [],
    dist: 0,
    blobs: START_BLOBS,
    food: { x: 0, y: 0, vx: 0, vy: 0 },
    eaten: 0,
    score: 0,
    lastEatAt: -Infinity,
    eats: [],
    hitSince: null,
    status: "playing",
    cause: null,
  };
  // Lay the starting path straight out behind the head.
  const back = HEAD_GAP + (state.blobs + 4) * SPACING;
  for (let d = back; d >= 0; d -= SAMPLE_MIN) {
    state.px.push(head.x - Math.cos(heading) * d);
    state.py.push(head.y - Math.sin(heading) * d);
    state.ps.push(-d);
  }
  state.food = placeFood(state, rand);
  return state;
}

/**
 * Queue a turn. It's dropped if it repeats or reverses the last queued
 * direction, so two quick keys can't fold the snake back into its own neck.
 */
export function steer(state: SnakeState, dir: Dir): boolean {
  if (state.status !== "playing") return false;
  const target = ANGLE[dir];
  const last = state.queue.length ? state.queue[state.queue.length - 1] : state.desired;
  const diff = Math.abs(angleDiff(target, last));
  if (diff < 0.01 || diff > (170 * Math.PI) / 180) return false;
  if (state.queue.length >= QUEUE_MAX) return false;
  state.queue.push(target);
  return true;
}

/** Position `back` px behind the head along the recorded path. */
export function pointBehind(state: SnakeState, back: number): Vec {
  const target = state.dist - back;
  const { ps, px, py } = state;
  let lo = 0;
  let hi = ps.length - 1;
  if (target <= ps[0]) return { x: px[0], y: py[0] };
  if (target >= ps[hi]) return { x: px[hi], y: py[hi] };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ps[mid] <= target) lo = mid;
    else hi = mid;
  }
  const ax = px[lo];
  const ay = py[lo];
  const bx = px[hi];
  const by = py[hi];
  // A wrap jump between two samples: don't draw a blob across the field.
  if (Math.abs(ax - bx) > 40 || Math.abs(ay - by) > 40) return target - ps[lo] < ps[hi] - target ? { x: ax, y: ay } : { x: bx, y: by };
  const f = (target - ps[lo]) / (ps[hi] - ps[lo] || 1);
  return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f };
}

export const blobDistance = (i: number) => HEAD_GAP + i * SPACING;

/** Radius 10, tapering to 7 over the last six blobs. */
export function blobRadius(i: number, blobs: number): number {
  const fromEnd = blobs - 1 - i;
  if (fromEnd >= TAPER) return BLOB_R;
  return BLOB_R_TAIL + ((BLOB_R - BLOB_R_TAIL) * fromEnd) / TAPER;
}

export function blobPositions(state: SnakeState): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < state.blobs; i += 1) out.push(pointBehind(state, blobDistance(i)));
  return out;
}

const dist2 = (a: Vec, b: Vec) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Random spot clear of the body, the head and (in kill modes) the walls; else the farthest of the tries. */
export function placeFood(state: SnakeState, rand: () => number = Math.random): Food {
  const wallPad = LEVELS[state.level].wrap ? FOOD_R + 12 : FOOD_WALL_MIN;
  const padX = Math.min(wallPad, state.w / 2 - FOOD_R);
  const padY = Math.min(wallPad, state.h / 2 - FOOD_R);
  const body = blobPositions(state);
  const clearBody = (BLOB_R + FOOD_R + 8) ** 2;
  let best: Vec | null = null;
  let bestScore = -1;
  for (let i = 0; i < FOOD_TRIES; i += 1) {
    const p = { x: padX + rand() * (state.w - 2 * padX), y: padY + rand() * (state.h - 2 * padY) };
    const nearestBody = body.reduce((m, b) => Math.min(m, dist2(p, b)), Infinity);
    const headD = dist2(p, state.head);
    const ok = nearestBody > clearBody && headD > FOOD_HEAD_MIN ** 2;
    if (ok) {
      best = p;
      break;
    }
    const score = Math.min(nearestBody, headD);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  const drift = LEVELS[state.level].drift;
  const angle = rand() * Math.PI * 2;
  const v = drift ? 20 + rand() * 20 : 0;
  return { x: best!.x, y: best!.y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v };
}

/** Advance one fixed step. */
export function stepSnake(state: SnakeState, dt: number = STEP, rand: () => number = Math.random): void {
  if (state.status !== "playing") return;
  const cfg = LEVELS[state.level];
  state.t += dt;

  // Take the next queued turn once the current one is within 1°, or 90ms in.
  if (state.queue.length && (Math.abs(angleDiff(state.desired, state.heading)) < TURN_DONE || state.t - state.turnStartedAt >= TURN_TIMEOUT_S)) {
    state.desired = state.queue.shift()!;
    state.turnStartedAt = state.t;
  }
  const speed = speedFor(state.level, state.eaten);
  const maxTurn = turnRateFor(speed) * dt;
  const diff = angleDiff(state.desired, state.heading);
  state.heading = Math.abs(diff) <= maxTurn ? state.desired : wrapAngle(state.heading + Math.sign(diff) * maxTurn);

  const move = speed * dt;
  state.head = { x: state.head.x + Math.cos(state.heading) * move, y: state.head.y + Math.sin(state.heading) * move };
  state.dist += move;
  if (cfg.wrap) {
    state.head.x = ((state.head.x % state.w) + state.w) % state.w;
    state.head.y = ((state.head.y % state.h) + state.h) % state.h;
  }
  const lastS = state.ps[state.ps.length - 1];
  if (state.dist - lastS >= SAMPLE_MIN) {
    state.px.push(state.head.x);
    state.py.push(state.head.y);
    state.ps.push(state.dist);
  }
  // Keep only as much path as the body needs, plus room to grow.
  const keepFrom = state.dist - blobDistance(state.blobs) - 8 * SPACING;
  let drop = 0;
  while (drop < state.ps.length - 2 && state.ps[drop + 1] < keepFrom) drop += 1;
  if (drop > 64) {
    state.px.splice(0, drop);
    state.py.splice(0, drop);
    state.ps.splice(0, drop);
  }

  // Drifting specks bounce off the walls.
  const f = state.food;
  if (f.vx || f.vy) {
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.x < FOOD_R || f.x > state.w - FOOD_R) {
      f.vx = -f.vx;
      f.x = Math.min(Math.max(f.x, FOOD_R), state.w - FOOD_R);
    }
    if (f.y < FOOD_R || f.y > state.h - FOOD_R) {
      f.vy = -f.vy;
      f.y = Math.min(Math.max(f.y, FOOD_R), state.h - FOOD_R);
    }
  }

  if (dist2(state.head, f) < (HEAD_R + FOOD_R) ** 2) {
    const streak = state.t - state.lastEatAt <= STREAK_S ? 1 : 0;
    state.eaten += 1;
    state.score += cfg.points + streak;
    state.lastEatAt = state.t;
    state.eats.push(state.t);
    if (state.eats.length > 8) state.eats.shift();
    state.blobs = Math.min(MAX_BLOBS, state.blobs + BLOBS_PER_SPECK);
    if (state.blobs >= MAX_BLOBS) {
      state.status = "won";
      return;
    }
    state.food = placeFood(state, rand);
  }

  // Hits: walls in kill modes, the tail past the neck after the spawn grace.
  let cause: SnakeState["cause"] = null;
  if (!cfg.wrap) {
    const { x, y } = state.head;
    if (x < HEAD_R * 0.5 || y < HEAD_R * 0.5 || x > state.w - HEAD_R * 0.5 || y > state.h - HEAD_R * 0.5) cause = "wall";
  }
  if (!cause && state.t > GRACE_S) {
    for (let i = NECK; i < state.blobs; i += 1) {
      const reach = (HEAD_R * 0.75 + blobRadius(i, state.blobs) * 0.75) ** 2;
      if (dist2(state.head, pointBehind(state, blobDistance(i))) < reach) {
        cause = "tail";
        break;
      }
    }
  }
  if (!cause) {
    state.hitSince = null;
    return;
  }
  // Normal forgives a graze: steer clear within the window and it never happened.
  if (state.hitSince === null) state.hitSince = state.t;
  if ((state.t - state.hitSince) * 1000 >= cfg.forgiveMs) {
    state.status = "over";
    state.cause = cause;
  }
}

export const keyDir = (key: string): Dir | null =>
  ({ ArrowUp: "up", w: "up", W: "up", ArrowDown: "down", s: "down", S: "down", ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right" } as Record<string, Dir>)[key] ?? null;

/** Swipe: the dominant axis once it passes the threshold. */
export function swipeDir(dx: number, dy: number, threshold = 24): Dir | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
}

/** Relative turn for the on-screen ⟲/⟳ buttons. */
export function relativeDir(state: SnakeState, turn: "left" | "right"): Dir {
  const base = state.queue.length ? state.queue[state.queue.length - 1] : state.desired;
  const next = wrapAngle(base + (turn === "left" ? -Math.PI / 2 : Math.PI / 2));
  const dirs: Dir[] = ["right", "down", "left", "up"];
  return dirs.reduce((best, d) => (Math.abs(angleDiff(ANGLE[d], next)) < Math.abs(angleDiff(ANGLE[best], next)) ? d : best), "right" as Dir);
}
