import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "lucide-react";
import type { Expression, Motion } from "../RobotModel";
import { SharedRobot, useReducedMotion } from "../shared/SharedRobot";
import type { WorldEvent } from "./events";
import { randomGame, type Game } from "./scores";
import { SnakeGame } from "./SnakeGame";
import { Piece, TicTacToe, type Hand } from "./TicTacToe";
import "./world.css";

// Bam Bam's world: a white room with the game in the middle and him standing
// to the right. From his panel it's a full-screen dialog; on the sign-in
// loader it fills the loader under its bar. Layout, reactions and lines:
// council ruling B19–B23 and the reaction table (bam-bam-loader-ruling-2026-10-04).

const LINE_MS = 2_500;
const LINE_GAP_MS = 4_000;
const OPENERS: Record<Game, string> = { snake: "snake. eat the dust.", ttt: "tic-tac-toe. your move." };

type Pose = { expression: Expression; motion: Motion; look: { x: number; y: number }; id: number };

export type WorldResult = { game: Game; won: boolean };

export function BamBamWorld({
  mode,
  game: chosen,
  onClose,
  onFinish,
}: {
  mode: "panel" | "loader";
  /** Normally left out: Bam Bam picks the game (Dre, 2026-10-04). Tests pass one. */
  game?: Game;
  onClose: () => void;
  /** Panel only: Snake counts a new best as a win, tic-tac-toe a player win (B23). */
  onFinish?: (result: WorldResult) => void;
}) {
  const reduced = useReducedMotion();
  const [game] = useState<Game>(() => chosen ?? randomGame());
  const [hand, setHand] = useState<Hand>(null);
  const [line, setLine] = useState("");
  const [pose, setPose] = useState<Pose>({ expression: "idle", motion: "none", look: { x: 0, y: 0 }, id: 0 });
  const root = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const lineTimer = useRef<number | undefined>(undefined);
  const lastLineAt = useRef(0);
  const ended = useRef(false);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const later = (ms: number, run: () => void) => timers.current.push(window.setTimeout(run, ms));

  const react = useCallback((expression: Expression, motion: Motion = "none", ms = 0, look?: { x: number; y: number }) => {
    setPose((p) => ({ expression, motion, look: look ?? p.look, id: p.id + 1 }));
    if (ms > 0) later(ms, () => setPose((p) => ({ ...p, expression: "idle", motion: "none", id: p.id + 1 })));
  }, []);

  const lookAt = useCallback((look: { x: number; y: number }) => setPose((p) => ({ ...p, look })), []);

  /** One line at a time, 2.5s each, at least 4s apart; the end-of-round line always shows. */
  const say = useCallback((text: string, end = false) => {
    const now = Date.now();
    if (!end && now - lastLineAt.current < LINE_GAP_MS) return;
    lastLineAt.current = now;
    setLine(text);
    window.clearTimeout(lineTimer.current);
    lineTimer.current = window.setTimeout(() => setLine(""), LINE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(lineTimer.current), []);

  const cellLook = (cell: number) => ({ x: (cell % 3) * 0.45 - 1, y: Math.floor(cell / 3) * 0.5 - 0.4 });

  const onEvent = useCallback(
    (event: WorldEvent) => {
      switch (event.type) {
        case "start":
          ended.current = false;
          react("idle", "none", 0, { x: -0.6, y: 0 });
          break;
        case "pause":
          react("idle", "none", 0, { x: -0.3, y: 0 });
          break;
        case "look":
          lookAt({ x: Math.max(-1, Math.min(1, event.x)) * 0.6 - 0.4, y: Math.max(-1, Math.min(1, event.y)) * 0.6 });
          break;
        case "eat":
          if (event.eaten % 10 === 0) {
            react("happy", "none", 500);
            say(`${event.eaten} specks. still hungry.`);
          } else if (event.eaten % 5 === 0) react("happy", "eat", 900);
          else react("happy", "none", 500);
          break;
        case "best":
          react("excited", "none", 800);
          say("new best. keep going.");
          break;
        case "crash":
          if (event.best) {
            react("surprised", event.cause === "wall" ? "shake" : "nope");
            later(1_200, () => react("excited", "dance", 2_000));
            say("new best. not bad at all.", true);
          } else {
            react("surprised", event.cause === "wall" ? "shake" : "nope", 1_200);
            say(event.cause === "wall" ? "ow. wall." : "that was my tail.", true);
          }
          if (!ended.current) {
            ended.current = true;
            onFinish?.({ game: "snake", won: event.best });
          }
          break;
        case "opens":
          say("i'll start.");
          break;
        case "you":
          lookAt(cellLook(event.cell));
          later(400, () => lookAt({ x: -0.6, y: 0 }));
          break;
        case "think":
          react("idle", "none", 0, cellLook(event.cells[0]));
          later(event.ms / 2, () => lookAt(cellLook(event.cells[1])));
          break;
        case "place":
          if (event.reason === "block") say("blocked you.");
          break;
        case "win":
          if (game === "ttt") {
            react("grumpy", "none");
            later(700, () => react("excited", "dance", 2_000));
            say("you got me. fair.", true);
            onFinish?.({ game: "ttt", won: true });
          } else {
            react("excited", "dance", 2_000);
            say("that's every speck. wow.", true);
            onFinish?.({ game: "snake", won: true });
          }
          break;
        case "lose":
          react("happy", "none", 1_500);
          say("got you. again?", true);
          onFinish?.({ game: "ttt", won: false });
          break;
        case "draw":
          react("happy", "none", 1_500);
          say(event.spicy ? "draw. you held me off." : "draw.", true);
          onFinish?.({ game: "ttt", won: false });
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [game, onFinish],
  );

  // He names the game he picked; it answers the player opening his world.
  useEffect(() => {
    say(OPENERS[game], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus starts on the game itself (the Snake field or the centre cell), so
  // Enter plays and Esc closes. Whoever opened the world puts focus back.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>('.cp-snake-field, .cp-ttt-cell[tabindex="0"]')?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (mode !== "panel" || event.key !== "Tab" || !root.current) return;
    const focusable = [...root.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"], input, [href]')].filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={root}
      className={`cp-bb cp-world is-${mode}`}
      role={mode === "panel" ? "dialog" : "region"}
      aria-modal={mode === "panel" ? true : undefined}
      aria-labelledby="bb-world-title"
      onKeyDown={onKeyDown}
    >
      <h2 id="bb-world-title" className="cp-sr">
        Bam Bam's world
      </h2>
      <div className="cp-world-head">
        <button type="button" className="cp-world-icon cp-world-close" aria-label={mode === "loader" ? "Close game" : "Close"} onClick={onClose}>
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className={`cp-world-body is-${game}`}>
        <div className="cp-world-board">
          {game === "snake" ? (
            <SnakeGame reducedMotion={reduced} onEvent={onEvent} />
          ) : (
            <TicTacToe reducedMotion={reduced} onEvent={onEvent} onHand={setHand} />
          )}
        </div>
        <aside className="cp-world-bam">
          <div className="cp-world-robot">
            <SharedRobot state={null} action={null} expression={pose.expression} motion={pose.motion} look={pose.look} reactionId={pose.id} stillWhenReduced />
          </div>
          <p className="cp-world-line" aria-live="off">
            {line}
          </p>
          {game === "ttt" && hand ? (
              <div className={`cp-world-hand${hand.active ? " is-active" : ""}`}>
                <span className="cp-ttt-token" data-bam-held="">
                  <Piece mark={hand.mark} who="bam" />
                </span>
                <span className="cp-ttt-tray-label">Bam Bam</span>
              </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
