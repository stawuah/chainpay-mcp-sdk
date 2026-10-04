// Tic-tac-toe rules and Bam Bam's move choice. Pure and import-free so the
// unit tests can load it on its own.
//
// Engine: negamax with alpha-beta over two 9-bit bitboards, with depth in the
// score so he takes quick wins and keeps blocking when a loss is forced
// (https://www.neverstopbuilding.com/blog/minimax). Every root move is scored
// with a full window, so the scores are exact and difficulty can sample from
// them. Mistakes come from the next-best tier, never a random cell, so a loss
// to him on Chill still looks like a person playing
// (https://blog.kartones.net/post/good-ai-but-always-fun-ai/).

export type Mark = "X" | "O";
export type Cell = Mark | null;
export type Board = readonly Cell[];
export type Level = "chill" | "normal" | "spicy";

export const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const LINE_MASKS = LINES.map(([a, b, c]) => (1 << a) | (1 << b) | (1 << c));
const FULL = 0x1ff;

export const emptyBoard = (): Cell[] => Array<Cell>(9).fill(null);

export function winner(board: Board): { mark: Mark; line: readonly [number, number, number] } | null {
  for (const line of LINES) {
    const [a, b, c] = line;
    const mark = board[a];
    if (mark && mark === board[b] && mark === board[c]) return { mark, line };
  }
  return null;
}

/** Win is checked first, because the ninth move can also be the winning one. */
export function outcome(board: Board): { kind: "win"; mark: Mark; line: readonly [number, number, number] } | { kind: "draw" } | null {
  const won = winner(board);
  if (won) return { kind: "win", ...won };
  return board.every(Boolean) ? { kind: "draw" } : null;
}

/** X always opens, so the turn follows from the piece count. */
export function toMove(board: Board): Mark {
  let x = 0;
  let o = 0;
  for (const cell of board) {
    if (cell === "X") x += 1;
    else if (cell === "O") o += 1;
  }
  return x === o ? "X" : "O";
}

export function canPlay(board: Board, index: number, mark: Mark): boolean {
  return index >= 0 && index < 9 && board[index] === null && !outcome(board) && toMove(board) === mark;
}

export function play(board: Board, index: number, mark: Mark): Cell[] {
  if (!canPlay(board, index, mark)) return [...board];
  const next = [...board];
  next[index] = mark;
  return next;
}

const maskOf = (board: Board, mark: Mark) => board.reduce<number>((m, c, i) => (c === mark ? m | (1 << i) : m), 0);
const isWin = (m: number) => LINE_MASKS.some((w) => (m & w) === w);
const emptyCells = (taken: number) => {
  const out: number[] = [];
  for (let i = 0; i < 9; i += 1) if (!(taken & (1 << i))) out.push(i);
  return out;
};

/** Score for the side to move (`me`); the previous mover was `opp`. */
function negamax(me: number, opp: number, depth: number, alpha: number, beta: number): number {
  if (isWin(opp)) return -(10 - depth);
  if ((me | opp) === FULL) return 0;
  let best = -Infinity;
  for (const i of emptyCells(me | opp)) {
    const s = -negamax(opp, me | (1 << i), depth + 1, -beta, -alpha);
    if (s > best) best = s;
    if (s > alpha) alpha = s;
    if (alpha >= beta) break;
  }
  return best;
}

export type ScoredMove = { index: number; score: number };

/** Exact score of every legal move for `mark`. Positive means a forced win. */
export function scoreMoves(board: Board, mark: Mark): ScoredMove[] {
  const other: Mark = mark === "X" ? "O" : "X";
  const me = maskOf(board, mark);
  const opp = maskOf(board, other);
  return emptyCells(me | opp).map((index) => ({
    index,
    score: -negamax(opp, me | (1 << index), 1, -Infinity, Infinity),
  }));
}

/** The cell that wins for `mark` right now, if there is one. */
export function winningCell(board: Board, mark: Mark): number | null {
  for (const [a, b, c] of LINES) {
    const cells = [board[a], board[b], board[c]];
    const mine = cells.filter((x) => x === mark).length;
    const empty = [a, b, c].filter((i) => board[i] === null);
    if (mine === 2 && empty.length === 1) return empty[0];
  }
  return null;
}

export type MoveReason = "win" | "block" | "fork" | "center" | "corner" | "side";

/** Plain-English reason for a move, used only for Bam Bam's lines (Newell & Simon order). */
export function reasonFor(board: Board, index: number, mark: Mark): MoveReason {
  const other: Mark = mark === "X" ? "O" : "X";
  if (winningCell(board, mark) === index) return "win";
  if (winningCell(board, other) === index) return "block";
  const after = play(board, index, mark);
  const threats = LINES.filter(([a, b, c]) => {
    const cells = [after[a], after[b], after[c]];
    return cells.filter((x) => x === mark).length === 2 && cells.includes(null);
  }).length;
  if (threats >= 2) return "fork";
  if (index === 4) return "center";
  return index % 2 === 0 ? "corner" : "side";
}

export type Memory = { missedBlock: boolean };

export const MISTAKE_RATE: Record<Level, number> = { chill: 0.55, normal: 0.2, spicy: 0 };

const pickFrom = <T,>(list: readonly T[], rand: () => number): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

/**
 * Bam Bam's move. Every level takes an immediate win. Spicy plays perfectly and
 * can't lose. A mistake on Chill or Normal takes the next-best tier, and Chill
 * never misses a block twice in a row.
 */
export function chooseMove(
  board: Board,
  mark: Mark,
  level: Level,
  rand: () => number = Math.random,
  memory: Memory = { missedBlock: false },
): { index: number; memory: Memory } {
  const scored = scoreMoves(board, mark);
  if (!scored.length) throw new Error("no legal move");
  const win = winningCell(board, mark);
  if (win !== null) return { index: win, memory: { missedBlock: false } };

  const best = Math.max(...scored.map((m) => m.score));
  const bestMoves = scored.filter((m) => m.score === best);
  const pickBest = () => {
    // Spicy's opening: mostly centre or a corner, sometimes an edge, all sound.
    if (level === "spicy" && board.every((c) => c === null)) {
      const strong = bestMoves.filter((m) => m.index % 2 === 0);
      return (rand() < 0.8 ? pickFrom(strong, rand) : pickFrom(bestMoves, rand)).index;
    }
    return pickFrom(bestMoves, rand).index;
  };

  const other: Mark = mark === "X" ? "O" : "X";
  const block = winningCell(board, other);
  const mustBlock = level === "chill" && block !== null && memory.missedBlock;
  if (level === "spicy" || mustBlock || rand() >= MISTAKE_RATE[level]) {
    const index = mustBlock ? block! : pickBest();
    return { index, memory: { missedBlock: false } };
  }

  const worse = scored.filter((m) => m.score < best);
  if (!worse.length) return { index: pickBest(), memory: { missedBlock: false } };
  const tier = Math.max(...worse.map((m) => m.score));
  const index = pickFrom(worse.filter((m) => m.score === tier), rand).index;
  return { index, memory: { missedBlock: block !== null && index !== block } };
}

/** Reading order 1–9 maps to cells 0–8; numpad keys map by their physical layout. */
export function cellForKey(key: string, code: string): number | null {
  const pad = /^Numpad([1-9])$/.exec(code);
  if (pad) {
    const n = Number(pad[1]);
    const row = 2 - Math.floor((n - 1) / 3);
    return row * 3 + ((n - 1) % 3);
  }
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  return null;
}
