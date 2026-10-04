import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const ttt = await load("../src/pet/world/tttEngine.ts");
const B = (s) => [...s].map((c) => (c === "." ? null : c));
const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test("all eight lines win and a ninth-move win is a win, not a draw", () => {
  for (const line of ttt.LINES) {
    const board = ttt.emptyBoard();
    for (const i of line) board[i] = "X";
    assert.deepEqual(ttt.winner(board).line, line);
  }
  const full = B("XOXXOOXXO"); // X wins down the left column on the last cell
  assert.equal(ttt.outcome(full).kind, "win");
  assert.equal(ttt.outcome(B("XOXXOOOXX")).kind, "draw");
  assert.equal(ttt.outcome(B("X........")), null);
});

test("turn follows the piece count and illegal moves are ignored", () => {
  assert.equal(ttt.toMove(ttt.emptyBoard()), "X");
  assert.equal(ttt.toMove(B("X........")), "O");
  assert.equal(ttt.canPlay(B("X........"), 0, "O"), false, "filled cell");
  assert.equal(ttt.canPlay(B("X........"), 1, "X"), false, "not X's turn");
  assert.equal(ttt.canPlay(B("XXXOO...."), 8, "O"), false, "game over");
  assert.deepEqual(ttt.play(B("X........"), 0, "O"), B("X........"));
});

// Walk every line of human play against Bam Bam; he must never lose.
function neverLoses(level, bam, rand) {
  const human = bam === "X" ? "O" : "X";
  let games = 0;
  const walk = (board) => {
    const done = ttt.outcome(board);
    if (done) {
      games += 1;
      assert.notEqual(done.kind === "win" && done.mark, human, `lost on ${level}: ${board.map((c) => c ?? ".").join("")}`);
      return;
    }
    if (ttt.toMove(board) === bam) {
      walk(ttt.play(board, ttt.chooseMove(board, bam, level, rand).index, bam));
    } else {
      for (let i = 0; i < 9; i += 1) if (board[i] === null) walk(ttt.play(board, i, human));
    }
  };
  walk(ttt.emptyBoard());
  return games;
}

test("spicy never loses against every possible human game, as X and as O", () => {
  for (const seed of [1, 2, 3]) {
    assert.ok(neverLoses("spicy", "O", seeded(seed)) > 100);
    assert.ok(neverLoses("spicy", "X", seeded(seed)) > 10);
  }
});

test("every level takes a one-move win", () => {
  const board = B("OO.XX....");
  for (const level of ["chill", "normal", "spicy"]) {
    for (let s = 0; s < 50; s += 1) {
      assert.equal(ttt.chooseMove(board, "O", level, seeded(s)).index, 2);
    }
  }
});

test("chill never misses the same block twice in a row", () => {
  const board = B("XX..O....");
  const alwaysErr = () => 0; // rand 0 → always under the mistake rate
  const first = ttt.chooseMove(board, "O", "chill", alwaysErr, { missedBlock: false });
  assert.notEqual(first.index, 2);
  assert.equal(first.memory.missedBlock, true);
  const second = ttt.chooseMove(board, "O", "chill", alwaysErr, first.memory);
  assert.equal(second.index, 2);
  assert.equal(second.memory.missedBlock, false);
});

test("mistakes come from the next-best tier, not a random cell", () => {
  const board = B("X...O...X"); // O must take a side; corners lose to a fork
  const scored = ttt.scoreMoves(board, "O");
  const best = Math.max(...scored.map((m) => m.score));
  const tier = Math.max(...scored.filter((m) => m.score < best).map((m) => m.score));
  const move = ttt.chooseMove(board, "O", "normal", () => 0);
  assert.equal(scored.find((m) => m.index === move.index).score, tier);
});

test("keys map to cells: digits by reading order, numpad by layout", () => {
  assert.equal(ttt.cellForKey("1", "Digit1"), 0);
  assert.equal(ttt.cellForKey("9", "Digit9"), 8);
  assert.equal(ttt.cellForKey("7", "Numpad7"), 0);
  assert.equal(ttt.cellForKey("3", "Numpad3"), 8);
  assert.equal(ttt.cellForKey("a", "KeyA"), null);
});

test("reasons explain blocks and wins for his lines", () => {
  assert.equal(ttt.reasonFor(B("XX..O...."), 2, "O"), "block");
  assert.equal(ttt.reasonFor(B("OO.XX....").map((c) => c), 2, "O"), "win");
});
