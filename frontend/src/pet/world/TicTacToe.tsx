import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { WorldEvent } from "./events";
import { randomLevel, readTally, writeTally, type Tally } from "./scores";
import {
  cellForKey,
  chooseMove,
  emptyBoard,
  outcome,
  play,
  reasonFor,
  scoreMoves,
  toMove,
  type Cell,
  type Level,
  type Mark,
  type Memory,
} from "./tttEngine";

// Tic-tac-toe against Bam Bam. You play X or O (X always opens); he stands to
// the right holding his next piece, thinks for a beat, then sends it to the
// board. Keyboard: arrows move, Enter places, 1–9 place directly
// (https://www.w3.org/WAI/ARIA/apg/patterns/grid/). Numbers: council ruling
// B30–B35. Your pieces are ink and his are blue, whichever letter each plays.

const rc = (i: number) => `row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}`;
const cellLabel = (i: number, cell: Cell) => `Row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}, ${cell ?? "empty"}`;

let openedThisSession = false;

export type Hand = { mark: Mark; active: boolean } | null;

export function TicTacToe({
  reducedMotion,
  onEvent,
  onHand,
}: {
  reducedMotion: boolean;
  onEvent: (event: WorldEvent) => void;
  /** Bam Bam's next piece and whether it's his turn, drawn in his hand by the world. */
  onHand: (hand: Hand) => void;
}) {
  const [you, setYou] = useState<Mark>("X");
  const [swap, setSwap] = useState(false);
  const [board, setBoard] = useState<Cell[]>(emptyBoard);
  const [owner, setOwner] = useState<("you" | "bam" | null)[]>(() => Array(9).fill(null));
  const [thinking, setThinking] = useState(false);
  const [focus, setFocus] = useState(4);
  const [announce, setAnnounce] = useState("");
  const [tally, setTally] = useState<Tally>(readTally);
  // Each round rolls its own hidden difficulty.
  const [level, setLevel] = useState<Level>(() => randomLevel());
  const [roundId, setRoundId] = useState(0);
  const round = useRef(0);
  const blockedThisRound = useRef(false);
  const lastMove = useRef("");
  const memory = useRef<Memory>({ missedBlock: false });
  const cells = useRef<(HTMLButtonElement | null)[]>([]);
  const again = useRef<HTMLButtonElement>(null);
  const latest = useRef({ onEvent, onHand, level, reducedMotion });
  latest.current = { ...latest.current, onEvent, onHand, reducedMotion };

  const bam: Mark = you === "X" ? "O" : "X";
  const done = outcome(board);
  const yourTurn = !done && !thinking && toMove(board) === you;

  useEffect(() => {
    latest.current.onHand(done ? null : { mark: bam, active: !yourTurn });
  }, [bam, done, yourTurn]);
  useEffect(() => () => latest.current.onHand(null), []);
  useEffect(() => writeTally(tally), [tally]);

  const begin = useCallback((mark: Mark) => {
    round.current += 1;
    setRoundId(round.current);
    blockedThisRound.current = false;
    memory.current = { missedBlock: false };
    const lvl = randomLevel();
    setLevel(lvl);
    latest.current.level = lvl;
    setYou(mark);
    setBoard(emptyBoard());
    setOwner(Array(9).fill(null));
    setThinking(false);
    setFocus(4);
    setAnnounce(mark === "X" ? "You're X. Your move." : "You're O. Bam Bam starts.");
    latest.current.onEvent({ type: "start" });
  }, []);

  // Settle a finished round once.
  const settled = useRef(-1);
  useEffect(() => {
    if (!done || settled.current === round.current) return;
    settled.current = round.current;
    const lvl = latest.current.level;
    const bump = (key: "you" | "draws" | "bam") => setTally((t) => ({ ...t, [key]: t[key] + 1 }));
    if (done.kind === "draw") {
      bump("draws");
      setAnnounce(lastMove.current + (lvl === "spicy" ? "Draw. You held Bam Bam off." : "Draw."));
      latest.current.onEvent({ type: "draw", spicy: lvl === "spicy" });
    } else if (done.mark === you) {
      bump("you");
      setAnnounce(lastMove.current + ("You win."));
      latest.current.onEvent({ type: "win" });
    } else {
      bump("bam");
      setAnnounce(lastMove.current + ("Bam Bam wins."));
      latest.current.onEvent({ type: "lose" });
    }
    window.setTimeout(() => again.current?.focus({ preventScroll: true }), 0);
  }, [done, you]);

  // His turn: a think beat with two glances, then his piece travels from his hand.
  useEffect(() => {
    if (done || toMove(board) !== bam) return;
    const id = round.current;
    const empty = board.flatMap((c, i) => (c === null ? [i] : []));
    if (empty.length === 9 && !openedThisSession) {
      openedThisSession = true;
      latest.current.onEvent({ type: "opens" });
    }
    const scored = scoreMoves(board, bam);
    const top = Math.max(...scored.map((m) => m.score));
    const ties = scored.filter((m) => m.score === top).length;
    const ms = 400 + Math.random() * 400 + (ties >= 3 ? 200 : 0);
    const glance = [empty[Math.floor(Math.random() * empty.length)], empty[Math.floor(Math.random() * empty.length)]];
    setThinking(true);
    latest.current.onEvent({ type: "think", cells: glance, ms });
    const choice = chooseMove(board, bam, latest.current.level, Math.random, memory.current);
    const timer = window.setTimeout(() => {
      if (id !== round.current) return;
      memory.current = choice.memory;
      const reason = reasonFor(board, choice.index, bam);
      flyFromHand(cells.current[choice.index], latest.current.reducedMotion).then(() => {
        if (id !== round.current) return;
        const next = play(board, choice.index, bam);
        setBoard(next);
        setOwner((o) => o.map((v, i) => (i === choice.index ? "bam" : v)));
        setThinking(false);
        setAnnounce(`Bam Bam: ${rc(choice.index)}.`);
        lastMove.current = `Bam Bam: ${rc(choice.index)}. `;
        const block = reason === "block" && !blockedThisRound.current;
        if (block) blockedThisRound.current = true;
        latest.current.onEvent({ type: "place", reason: block ? "block" : reason === "block" ? "corner" : reason });
      });
    }, ms);
    return () => window.clearTimeout(timer);
  }, [board, bam, done]);

  const place = (i: number) => {
    if (!yourTurn || board[i] !== null) return;
    setBoard((b) => play(b, i, you));
    setOwner((o) => o.map((v, k) => (k === i ? "you" : v)));
    setAnnounce(`You: ${rc(i)}.`);
    lastMove.current = `You: ${rc(i)}. `;
    latest.current.onEvent({ type: "you", cell: i });
  };

  const move = (i: number) => {
    setFocus(i);
    cells.current[i]?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const r = Math.floor(focus / 3);
    const c = focus % 3;
    const direct = cellForKey(event.key, event.code);
    if (direct !== null) {
      event.preventDefault();
      move(direct);
      place(direct);
      return;
    }
    const next: Record<string, number> = {
      ArrowUp: Math.max(0, r - 1) * 3 + c,
      ArrowDown: Math.min(2, r + 1) * 3 + c,
      ArrowLeft: r * 3 + Math.max(0, c - 1),
      ArrowRight: r * 3 + Math.min(2, c + 1),
      Home: event.ctrlKey ? 0 : r * 3,
      End: event.ctrlKey ? 8 : r * 3 + 2,
    };
    if (event.key in next) {
      event.preventDefault();
      move(next[event.key]);
    }
  };

  const t = tally;
  const line = done?.kind === "win" ? done.line : null;
  const lineOwner = line ? (done?.kind === "win" && done.mark === you ? "you" : "bam") : null;
  const result = done ? (done.kind === "draw" ? (level === "spicy" ? "Draw. You held Bam Bam off." : "Draw.") : done.mark === you ? "You win." : "Bam Bam wins.") : null;

  return (
    <div className="cp-ttt" data-round={roundId}>
      <div className="cp-ttt-stage">
        <div className={`cp-ttt-tray${yourTurn ? " is-active" : ""}`}>
          <span className="cp-ttt-tray-label">You</span>
          <span className="cp-ttt-token">
            <Piece mark={you} who="you" />
          </span>
        </div>
        <div className={`cp-ttt-board${done ? (done.kind === "draw" ? " is-draw" : " is-won") : ""}`} role="grid" aria-label="Tic-tac-toe board" aria-busy={thinking} onKeyDown={onKey}>
          {[0, 1, 2].map((r) => (
            <div role="row" key={r} className="cp-ttt-row">
              {[0, 1, 2].map((c) => {
                const i = r * 3 + c;
                const cell = board[i];
                const who = owner[i];
                return (
                  <button
                    key={i}
                    ref={(el) => {
                      cells.current[i] = el;
                    }}
                    type="button"
                    role="gridcell"
                    className={`cp-ttt-cell${line?.includes(i) ? " is-lit" : ""}${cell === null && yourTurn ? " is-open" : ""}`}
                    tabIndex={focus === i ? 0 : -1}
                    aria-label={cellLabel(i, cell)}
                    aria-disabled={Boolean(done) || !yourTurn || cell !== null}
                    onFocus={() => setFocus(i)}
                    onClick={() => place(i)}
                  >
                    {cell && who ? <Piece mark={cell} who={who} pop={!reducedMotion && who === "you"} /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {line && lineOwner ? <WinLine line={line} who={lineOwner} animate={!reducedMotion} /> : null}
        </div>
      </div>

      <div className="cp-ttt-result" aria-hidden="true">
        {result ?? (thinking ? "" : yourTurn ? "Your move" : "")}
      </div>
      {done ? (
        <button ref={again} type="button" className="cp-world-cta" onClick={() => begin(swap ? bam : you)}>
          Play again
        </button>
      ) : null}

      <div className="cp-ttt-controls">
        <div className="cp-seg" role="radiogroup" aria-label="Your mark">
          {(["X", "O"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={you === m}
              tabIndex={you === m ? 0 : -1}
              className="cp-seg-item"
              onClick={() => begin(m)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  const next = m === "X" ? "O" : "X";
                  begin(next);
                  (e.currentTarget.parentElement?.querySelector(`[data-mark="${next}"]`) as HTMLElement | null)?.focus();
                }
              }}
              data-mark={m}
            >
              Play as {m}
            </button>
          ))}
        </div>
        <label className="cp-switch">
          <input type="checkbox" role="switch" checked={swap} onChange={(e) => setSwap(e.target.checked)} />
          <span className="cp-switch-track" aria-hidden="true" />
          Swap who starts each round
        </label>
      </div>

      <p className="cp-ttt-tally">
        <span>
          You <b>{t.you}</b>
        </span>{" "}
        ·{" "}
        <span>
          Draws <b>{t.draws}</b>
        </span>{" "}
        ·{" "}
        <span>
          Bam Bam <b>{t.bam}</b>
        </span>
        <button type="button" className="cp-ttt-reset" onClick={() => setTally({ you: 0, draws: 0, bam: 0 })}>
          Reset
        </button>
      </p>
      <p className="cp-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

export function Piece({ mark, who, pop = false }: { mark: Mark; who: "you" | "bam"; pop?: boolean }) {
  return (
    <svg className={`cp-ttt-piece is-${who}${pop ? " is-pop" : ""}`} viewBox="0 0 96 96" aria-hidden="true">
      {mark === "X" ? (
        <g stroke="currentColor" strokeWidth="7" strokeLinecap="round">
          <path d="M28.8 28.8L67.2 67.2" />
          <path d="M67.2 28.8L28.8 67.2" />
        </g>
      ) : (
        <circle cx="48" cy="48" r="22" fill="none" stroke="currentColor" strokeWidth="7" />
      )}
    </svg>
  );
}

/** Centre to centre across the winning three, 12px past each end, in the winner's colour. */
function WinLine({ line, who, animate }: { line: readonly number[]; who: "you" | "bam"; animate: boolean }) {
  const at = (i: number) => ({ x: (i % 3) * 104 + 48, y: Math.floor(i / 3) * 104 + 48 });
  const a = at(line[0]);
  const b = at(line[2]);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  return (
    <svg className={`cp-ttt-line is-${who}${animate ? " is-drawn" : ""}`} viewBox="0 0 304 304" aria-hidden="true">
      <line x1={a.x - ux * 12} y1={a.y - uy * 12} x2={b.x + ux * 12} y2={b.y + uy * 12} pathLength={1} />
    </svg>
  );
}

/** Send a copy of his held piece from his hand to the cell: translate only, 320ms. */
function flyFromHand(target: HTMLElement | null | undefined, reduced: boolean): Promise<void> {
  const from = document.querySelector<HTMLElement>("[data-bam-held]");
  if (reduced || !target || !from || typeof from.animate !== "function") return Promise.resolve();
  const a = from.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const ghost = from.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-bam-held");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${a.left}px`,
    top: `${a.top}px`,
    width: `${a.width}px`,
    height: `${a.height}px`,
    margin: "0",
    zIndex: "80",
    pointerEvents: "none",
    opacity: "1",
  });
  document.body.appendChild(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = ghost.animate([{ transform: "translate(0,0)" }, { transform: `translate(${dx}px, ${dy}px)` }], {
    duration: 320,
    easing: "cubic-bezier(0.23,1,0.32,1)",
  });
  return anim.finished.then(
    () => ghost.remove(),
    () => ghost.remove(),
  );
}
