import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import type { WorldEvent } from "./events";
import { randomLevel, readBest, writeBest } from "./scores";
import {
  FIELD_H,
  FIELD_W,
  FOOD_R,
  GRACE_S,
  HEAD_R,
  LEVELS,
  STEP,
  blobDistance,
  blobRadius,
  createSnake,
  keyDir,
  pointBehind,
  relativeDir,
  steer,
  stepSnake,
  swipeDir,
  type Level,
  type SnakeState,
} from "./snakeSim";

// Snake on Canvas 2D. The sim runs at a fixed 1/120 s step with an accumulator
// (https://gafferongames.com/post/fix_your_timestep/); this file only draws it.
// The jelly is visual: each blob springs toward its spot on the path
// (a = −ω²(x−t) − 2ζω·v), held within 0.6r of it so what you see is what
// collides, squashes along its motion, and swells in a gulp that rolls down
// the tail when Bam Bam eats. Numbers: council ruling B24–B29, B36.

const BLUE = "#0052FF";
const NAVY = "#14213D";
const MUTED = "#7c828a";
const MUTED_SOFT = "#a8acb3";
const INK = "#0a0b0d";
const OMEGA_HEAD = 2 * Math.PI * 7;
const OMEGA_TAIL = 2 * Math.PI * 4;
const ZETA = 0.45;
const OFFSET_CLAMP = 0.6;
const SQUASH = 0.22;
const SQUASH_V = 200;
const GULP = 0.3;
const GULP_GAP = 0.035;
const GULP_LEN = 0.16;
const GULP_BLOBS = 24;
const HAPPY_EYES_S = 0.4;
const COUNT_MS = 500;
const LOOK_MS = 100;

type Phase = "ready" | "countdown" | "playing" | "paused" | "over";
type Jelly = { x: number[]; y: number[]; vx: number[]; vy: number[]; tx: number[]; ty: number[] };

export function SnakeGame({
  reducedMotion,
  onEvent,
  autoFocus = false,
}: {
  reducedMotion: boolean;
  onEvent: (event: WorldEvent) => void;
  autoFocus?: boolean;
}) {
  const field = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [count, setCount] = useState(3);
  const [score, setScore] = useState(0);
  // Each run rolls its own hidden difficulty; the walls show which kind it is.
  const [level, setLevel] = useState<Level>(() => randomLevel());
  const [best, setBest] = useState(() => readBest());
  const [newBest, setNewBest] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [cssWidth, setCssWidth] = useState(FIELD_W);
  const sim = useRef<SnakeState | null>(null);
  const jelly = useRef<Jelly>({ x: [], y: [], vx: [], vy: [], tx: [], ty: [] });
  const prevHead = useRef({ x: 0, y: 0 });
  const phaseRef = useRef<Phase>("ready");
  phaseRef.current = phase;
  const passedBest = useRef(false);
  const latest = useRef({ onEvent, reducedMotion, level });
  latest.current.onEvent = onEvent;
  latest.current.reducedMotion = reducedMotion;

  // The field is always 480×360 logical px, drawn at whatever width fits (max 640).
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const measure = () => setCssWidth(el.clientWidth || FIELD_W);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.round(cssWidth * dpr);
    el.height = Math.round(((cssWidth * FIELD_H) / FIELD_W) * dpr);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cssWidth]);

  const reset = useCallback((lvl: Level) => {
    sim.current = createSnake(FIELD_W, FIELD_H, lvl);
    jelly.current = { x: [], y: [], vx: [], vy: [], tx: [], ty: [] };
    prevHead.current = { ...sim.current.head };
    passedBest.current = false;
    setScore(0);
    setNewBest(false);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    reset(latest.current.level);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const start = () => {
    // The first run plays the roll the ready card already drew; later runs reroll.
    const lvl = phaseRef.current === "ready" ? latest.current.level : randomLevel();
    setLevel(lvl);
    latest.current.level = lvl;
    reset(lvl);
    setCount(3);
    setPhase("countdown");
    latest.current.onEvent({ type: "start" });
    field.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (phase !== "countdown") return;
    if (count <= 0) {
      setPhase("playing");
      return;
    }
    const timer = window.setTimeout(() => setCount((c) => c - 1), COUNT_MS);
    return () => window.clearTimeout(timer);
  }, [phase, count]);

  const pause = useCallback(() => {
    if (phaseRef.current !== "playing" && phaseRef.current !== "countdown") return;
    setPhase("paused");
    draw();
    latest.current.onEvent({ type: "pause" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resume = () => {
    setCount(3);
    setPhase("countdown");
    field.current?.focus({ preventScroll: true });
  };

  // Pause when the tab hides or the window loses focus.
  useEffect(() => {
    const onHide = () => document.hidden && pause();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", pause);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", pause);
    };
  }, [pause]);

  // The loop. Sim state lives in refs; React only hears about score and the end.
  useEffect(() => {
    if (phase !== "playing") return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastLook = 0;
    let lastEaten = sim.current?.eaten ?? 0;
    const frame = (now: number) => {
      const state = sim.current;
      if (!state) return;
      const elapsed = (now - last) / 1000;
      last = now;
      acc += Math.min(elapsed, 0.25);
      while (acc >= STEP) {
        prevHead.current = { ...state.head };
        stepSnake(state);
        acc -= STEP;
        if (state.status !== "playing") break;
      }
      if (state.eaten !== lastEaten) {
        lastEaten = state.eaten;
        setScore(state.score);
        latest.current.onEvent({ type: "eat", eaten: state.eaten });
        if (state.eaten % 5 === 0) setAnnounce(`${state.eaten} specks. Score ${state.score}.`);
        const prior = readBest();
        if (!passedBest.current && prior > 0 && state.score > prior) {
          passedBest.current = true;
          setNewBest(true);
          latest.current.onEvent({ type: "best", score: state.score });
        }
      }
      if (now - lastLook >= LOOK_MS) {
        lastLook = now;
        latest.current.onEvent({ type: "look", x: state.head.x / (FIELD_W / 2) - 1, y: state.head.y / (FIELD_H / 2) - 1 });
      }
      springs(state, Math.min(elapsed, 1 / 30));
      draw(acc / STEP);
      if (state.status !== "playing") {
        finish(state);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const finish = (state: SnakeState) => {
    setPhase("over");
    setScore(state.score);
    const prior = readBest();
    const isBest = state.score > prior;
    if (isBest) {
      writeBest(state.score);
      setBest(state.score);
      setNewBest(true);
    }
    const shownBest = Math.max(prior, state.score);
    latest.current.onEvent(state.status === "won" ? { type: "win" } : { type: "crash", cause: state.cause ?? "wall", best: isBest });
    setAnnounce(`Game over. Score ${state.score}. Best ${shownBest}.`);
    draw();
  };

  /** Each blob springs toward its spot on the path; lower ω down the tail means more lag. */
  function springs(state: SnakeState, dt: number) {
    const j = jelly.current;
    if (latest.current.reducedMotion) return;
    const steps = Math.max(1, Math.ceil(dt / STEP));
    const h = dt / steps;
    const n = state.blobs;
    for (let i = 0; i < n; i += 1) {
      const target = pointBehind(state, blobDistance(i));
      const r = blobRadius(i, n);
      if (j.x[i] === undefined || Math.hypot(j.x[i] - target.x, j.y[i] - target.y) > 40) {
        // New blob, or the field wrapped under it: start on the spot.
        j.x[i] = target.x;
        j.y[i] = target.y;
        j.vx[i] = 0;
        j.vy[i] = 0;
      } else {
        const omega = OMEGA_HEAD + (OMEGA_TAIL - OMEGA_HEAD) * (n > 1 ? i / (n - 1) : 0);
        for (let k = 0; k < steps; k += 1) {
          const ax = -omega * omega * (j.x[i] - target.x) - 2 * ZETA * omega * j.vx[i];
          const ay = -omega * omega * (j.y[i] - target.y) - 2 * ZETA * omega * j.vy[i];
          j.vx[i] += ax * h;
          j.vy[i] += ay * h;
          j.x[i] += j.vx[i] * h;
          j.y[i] += j.vy[i] * h;
        }
        // Never more than 0.6r from where it really is.
        const dx = j.x[i] - target.x;
        const dy = j.y[i] - target.y;
        const d = Math.hypot(dx, dy);
        const max = OFFSET_CLAMP * r;
        if (d > max) {
          j.x[i] = target.x + (dx / d) * max;
          j.y[i] = target.y + (dy / d) * max;
        }
      }
      j.tx[i] = target.x;
      j.ty[i] = target.y;
    }
    for (const arr of Object.values(j)) arr.length = n;
  }

  function draw(alpha = 1) {
    const el = canvas.current;
    const state = sim.current;
    if (!el || !state) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const k = el.width / FIELD_W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, FIELD_W, FIELD_H);
    const reduced = latest.current.reducedMotion;
    const running = phaseRef.current === "playing";
    const t = state.t;
    const j = jelly.current;

    // Kill walls are a hazard (3:1 line); wrap walls are a decorative dash.
    ctx.lineWidth = 2;
    if (LEVELS[state.level].wrap) {
      ctx.strokeStyle = MUTED_SOFT;
      ctx.setLineDash([6, 6]);
    } else {
      ctx.strokeStyle = MUTED;
      ctx.setLineDash([]);
    }
    ctx.strokeRect(1, 1, FIELD_W - 2, FIELD_H - 2);
    ctx.setLineDash([]);

    const lastEat = state.eats.length ? state.eats[state.eats.length - 1] : -Infinity;
    const speckAge = reduced ? 1 : Math.min(1, (t - lastEat) / 0.16);
    drawSpeck(ctx, state.food.x, state.food.y, Number.isFinite(lastEat) ? speckAge : Math.min(1, t / 0.16 + (phaseRef.current === "ready" ? 1 : 0)));

    // Tail first, so the head sits on top.
    const n = state.blobs;
    const gloss: [number, number, number][] = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const target = pointBehind(state, blobDistance(i));
      const base = blobRadius(i, n);
      const x = reduced ? target.x : j.x[i] ?? target.x;
      const y = reduced ? target.y : j.y[i] ?? target.y;
      let r = base;
      let s = 1;
      let angle = 0;
      if (!reduced) {
        if (running) r *= 1 + 0.03 * Math.sin(2 * Math.PI * 1.2 * t - 0.5 * i);
        if (i < GULP_BLOBS) {
          for (const te of state.eats) {
            const u = t - (te + i * GULP_GAP) + GULP_LEN / 2;
            if (u > 0 && u < GULP_LEN) r *= 1 + GULP * 0.88 ** i * Math.sin((Math.PI * u) / GULP_LEN);
          }
        }
        // Squash along the blob's motion relative to its spot on the path.
        const omega = OMEGA_HEAD + (OMEGA_TAIL - OMEGA_HEAD) * (n > 1 ? i / (n - 1) : 0);
        const relX = (x - target.x) * omega;
        const relY = (y - target.y) * omega;
        const rel = Math.hypot(relX, relY);
        s = 1 + SQUASH * Math.min(rel / SQUASH_V, 1);
        angle = Math.atan2(relY, relX);
      }
      drawBlob(ctx, x, y, r, s, angle);
      gloss.push([x, y, r]);
    }
    // Gloss dots go on after every blob, so each bead reads on its own.
    ctx.fillStyle = "rgba(255,255,255,.35)";
    for (const [gx, gy, gr] of gloss) {
      ctx.beginPath();
      ctx.arc(gx - 0.3 * gr, gy - 0.3 * gr, 0.3 * gr, 0, Math.PI * 2);
      ctx.fill();
    }

    const hx = prevHead.current.x + (state.head.x - prevHead.current.x) * alpha;
    const hy = prevHead.current.y + (state.head.y - prevHead.current.y) * alpha;
    const near = Math.abs(hx - state.head.x) < 40 && Math.abs(hy - state.head.y) < 40;
    const inGrace = state.status === "playing" && t < GRACE_S && (running || phaseRef.current === "countdown");
    const blink = !reduced && inGrace && running && Math.floor(t / 0.15) % 2 === 1;
    const mood = state.status === "over" ? "bonk" : t - lastEat < HAPPY_EYES_S ? "happy" : "idle";
    drawHead(ctx, near ? hx : state.head.x, near ? hy : state.head.y, state.heading, mood, blink ? 0.35 : 1);
    if (reduced && inGrace) {
      ctx.strokeStyle = BLUE;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(state.head.x, state.head.y, HEAD_R + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " || event.key === "p" || event.key === "P") {
      event.preventDefault();
      if (phase === "playing" || phase === "countdown") pause();
      else if (phase === "paused") resume();
      else start();
      return;
    }
    if (event.key === "Enter" && (phase === "ready" || phase === "over")) {
      event.preventDefault();
      start();
      return;
    }
    const dir = keyDir(event.key);
    if (!dir) return;
    event.preventDefault();
    if (sim.current && (phase === "playing" || phase === "countdown")) steer(sim.current, dir);
  };

  // Swipes turn mid-gesture and re-anchor, so one finger can chain turns.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    anchor.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!anchor.current || !sim.current) return;
    const dir = swipeDir(e.clientX - anchor.current.x, e.clientY - anchor.current.y);
    if (!dir) return;
    steer(sim.current, dir);
    anchor.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = () => {
    anchor.current = null;
  };
  const turn = (side: "left" | "right") => {
    if (sim.current) steer(sim.current, relativeDir(sim.current, side));
  };
  // Pointers turn on press for speed; keyboards, screen readers and voice
  // control send a click, so the click turns too unless a press just did.
  const pressed = useRef(false);
  const press = (e: PointerEvent<HTMLButtonElement>, side: "left" | "right") => {
    e.preventDefault();
    pressed.current = true;
    window.setTimeout(() => (pressed.current = false), 600);
    turn(side);
  };
  const tap = (side: "left" | "right") => {
    if (pressed.current) {
      pressed.current = false;
      return;
    }
    turn(side);
  };

  const live = phase === "playing" || phase === "countdown";
  return (
    <div className="cp-snake">
      <div className="cp-snake-hud">
        <span className="cp-snake-stat">
          <span className="cp-snake-label">Score</span>
          <b>{score}</b>
        </span>
        <span className={`cp-snake-stat${newBest ? " is-best" : ""}`}>
          <span className="cp-snake-label">Best</span>
          <b>{Math.max(best, newBest ? score : 0)}</b>
          {newBest ? <span className="cp-snake-new">New best</span> : null}
        </span>
        {/* The rule, not the difficulty: the roll stays hidden (Dre, 2026-10-04). */}
        <span className="cp-snake-rule">{LEVELS[level].wrap ? "Walls wrap around" : "Walls end the run"}</span>
        <button
          type="button"
          className="cp-world-icon"
          aria-label={phase === "paused" ? "Resume" : "Pause"}
          disabled={!live && phase !== "paused"}
          onClick={phase === "paused" ? resume : pause}
        >
          {phase === "paused" ? <Play size={16} strokeWidth={1.75} aria-hidden="true" /> : <Pause size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      <div className="cp-snake-frame">
        <div ref={field} className="cp-snake-field" tabIndex={0} onKeyDown={onKey} aria-label="Snake. Arrow keys or WASD to steer, space to pause.">
          <canvas
            ref={canvas}
            role="img"
            aria-label={`Snake game. Score ${score}.`}
            style={{ width: "100%", aspectRatio: `${FIELD_W} / ${FIELD_H}`, touchAction: "none", display: "block" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {phase === "countdown" ? (
            <span key={count} className="cp-snake-count" aria-hidden="true">
              {count > 0 ? count : ""}
            </span>
          ) : null}
          {phase === "ready" || phase === "paused" || phase === "over" ? (
            <div className={`cp-snake-overlay${phase === "over" ? " is-over" : ""}`}>
              <div className="cp-snake-card">
                {phase === "ready" ? (
                  <>
                    <p className="cp-snake-card-title">Snake</p>
                    <p className="cp-snake-card-meta">eat the dust. don't bite your tail.</p>
                    <button type="button" className="cp-world-cta" onClick={start}>
                      Start
                    </button>
                    <p className="cp-snake-hint">Enter to start</p>
                  </>
                ) : phase === "paused" ? (
                  <>
                    <p className="cp-snake-card-title">Paused</p>
                    <button type="button" className="cp-world-cta" onClick={resume}>
                      Resume
                    </button>
                    <p className="cp-snake-hint">Space to resume</p>
                  </>
                ) : (
                  <>
                    <p className="cp-snake-card-title">Game over</p>
                    <p className="cp-snake-card-score">
                      Score {score} · Best {Math.max(best, score)}
                    </p>
                    <button type="button" className="cp-world-cta" onClick={start} autoFocus>
                      Play again
                    </button>
                    <p className="cp-snake-hint">Enter to play again</p>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {/* Phones: a pad shaped like Bam Bam's visor, its two eyes the turn buttons. */}
      <div className="cp-snake-pad">
        <button type="button" className="cp-snake-eye" aria-label="Turn left" onPointerDown={(e) => press(e, "left")} onClick={() => tap("left")}>
          <RotateCcw size={22} strokeWidth={2.25} aria-hidden="true" />
        </button>
        <span className="cp-snake-pad-mid" aria-hidden="true" />
        <button type="button" className="cp-snake-eye" aria-label="Turn right" onPointerDown={(e) => press(e, "right")} onClick={() => tap("right")}>
          <RotateCw size={22} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      <p className="cp-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

function drawBlob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, s: number, angle: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(s, 1 / s);
  ctx.fillStyle = BLUE;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 2D Bam Bam: rotates to the heading and mirrors past 90° so the visor never flips. */
function drawHead(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, mood: "idle" | "happy" | "bonk", opacity: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = opacity;
  ctx.rotate(heading);
  if (Math.abs(heading) > Math.PI / 2) ctx.scale(1, -1);
  const w = 28;
  const h = 24;
  ctx.fillStyle = BLUE;
  ctx.beginPath();
  ctx.roundRect(-w / 2 - 3, -4, 4, 8, 2);
  ctx.roundRect(w / 2 - 1, -4, 4, 8, 2);
  ctx.fill();
  ctx.fillStyle = "#f4f7ff";
  ctx.strokeStyle = "rgba(10,11,13,.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = NAVY;
  ctx.beginPath();
  ctx.roundRect(-10, -6, 20, 12, 6);
  ctx.fill();
  // Eyes sit 1.5px toward the direction of travel (+x in this frame).
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  for (const ex of [-4.5, 4.5]) {
    ctx.beginPath();
    if (mood === "happy") {
      ctx.arc(ex + 1.5, 0.8, 2.2, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else {
      ctx.arc(ex + 1.5, 0, mood === "bonk" ? 3 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawSpeck(ctx: CanvasRenderingContext2D, x: number, y: number, appear: number) {
  // The site's dust bunny at 20 logical px, in --muted so it reaches 3:1.
  const scale = 0.6 + 0.4 * appear;
  ctx.save();
  ctx.globalAlpha = appear;
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.translate(-FOOD_R, -FOOD_R);
  const k = (FOOD_R * 2) / 28;
  ctx.scale(k, k);
  ctx.fillStyle = MUTED;
  for (const [cx, cy, r] of [
    [14, 15, 8],
    [8.5, 12, 4],
    [19.5, 11.5, 4.5],
    [11, 20, 4],
    [18, 20, 4.2],
  ]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = INK;
  for (const cx of [11.5, 16.5]) {
    ctx.beginPath();
    ctx.arc(cx, 14.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
