import { Suspense, lazy, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { isNight, moodOf, NEEDS, stageFor, type Mood, type Need, type PetAction } from "./sim/needs";
import { petStore, usePet, type Reaction } from "./store";
import { useRoamer } from "./roam/roamer";
import { RobotStill } from "./RobotStill";
import type { Expression, Motion } from "./RobotModel";
import "./pet.css";

const RobotCanvas = lazy(() => import("./RobotCanvas"));

const LINES: Record<Mood, string> = {
  happy: "life's good. thanks for stopping by.",
  okay: "just floating around. you?",
  meh: "could use a snack, not gonna lie.",
  low: "low power… someone plug me in?",
  asleep: "zzz. it's night in UTC.",
  grumpy: "i was SLEEPING.",
};

const REACTION_LINES: Partial<Record<Reaction["kind"], string>> = {
  eat: "nom. battery up.",
  spin: "wheee",
  shake: "squeaky clean.",
  happy: "^^",
  surprised: "hey!",
  grumpy: "i was SLEEPING.",
};

const NEED_LABEL: Record<Need, string> = { battery: "Battery", joy: "Joy", clean: "Clean" };

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function expressionFor(mood: Mood, reaction: Reaction | null, now: number): Expression {
  const fresh = reaction && now - reaction.at < 1_500;
  if (fresh && reaction.kind === "surprised") return "surprised";
  if (mood === "grumpy" || (fresh && reaction.kind === "grumpy")) return "grumpy";
  if (mood === "asleep") return "sleep";
  if (fresh && ["happy", "eat", "spin", "shake"].includes(reaction.kind)) return "happy";
  if (mood === "low") return "low";
  return mood === "happy" ? "happy" : "idle";
}

function motionFor(reaction: Reaction | null, now: number): Motion {
  if (!reaction || now - reaction.at > 1_500) return "none";
  if (reaction.kind === "spin") return "spin";
  if (reaction.kind === "shake" || reaction.kind === "nope") return reaction.kind;
  if (reaction.kind === "eat") return "eat";
  return "none";
}

function minutes(ms: number) {
  return Math.max(1, Math.ceil(ms / 60_000));
}

export default function PetLayer({ onHide }: { onHide: () => void }) {
  const { snapshot, reaction } = usePet();
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const narrow = useMedia("(max-width: 600px)");
  const webgl = useMemo(hasWebGL, []);
  const size = narrow ? 96 : 140;
  const { position, hold, release } = useRoamer({ size, roam: !reducedMotion && !narrow });
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [clock, setClock] = useState(() => Date.now());
  const drag = useRef<{ startX: number; startY: number; dx: number; dy: number; moved: boolean } | null>(null);

  // Re-render shortly after a reaction so the face settles back.
  useEffect(() => {
    setClock(Date.now());
    if (!reaction) return;
    const timer = window.setTimeout(() => setClock(Date.now()), 1_600);
    return () => window.clearTimeout(timer);
  }, [reaction]);

  // Eyes follow the pointer, measured from his own centre.
  useEffect(() => {
    if (reducedMotion) return;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const cx = position.x + size / 2;
        const cy = position.y + size / 2;
        setLook({
          x: Math.max(-1, Math.min(1, (event.clientX - cx) / (window.innerWidth / 2))),
          y: Math.max(-1, Math.min(1, (event.clientY - cy) / (window.innerHeight / 2))),
        });
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, [position.x, position.y, size, reducedMotion]);

  const now = clock;
  const mood = moodOf(snapshot, now);
  const expression = expressionFor(mood, reaction, now);
  const motion = motionFor(reaction, now);
  const fresh = reaction && now - reaction.at < 1_500 ? REACTION_LINES[reaction.kind] : undefined;
  const line = note ?? fresh ?? LINES[mood];
  const stage = stageFor(snapshot.bornAt, now);

  const act = (action: PetAction) => {
    const result = petStore.act(action);
    setNote(result.ok ? null : `already did that. try again in ${minutes(result.retryMs ?? 0)}m.`);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      dx: event.clientX - position.x,
      dy: event.clientY - position.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
    current.moved = true;
    hold(event.clientX - current.dx, event.clientY - current.dy);
  };
  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.moved) {
      release();
      return;
    }
  };
  const onClick = () => {
    // A drag ends in a click too; only a still press counts as a pat.
    if (position.mode === "held") return;
    act("pet");
    setOpen((value) => !value);
  };

  const flip = position.mode === "peek" && position.side === "left";
  const bubbleBelow = position.y < 220;
  const bubbleLeft = position.x > window.innerWidth / 2;

  return (
    <div
      className={`cp-pet${position.glide ? " is-gliding" : ""}${mood === "low" ? " is-low" : ""}${mood === "asleep" ? " is-asleep" : ""}`}
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, width: size, height: size }}
      data-mode={position.mode}
      data-stage={stage}
    >
      <button
        type="button"
        className="cp-pet-body"
        aria-label="ChainPay robot. Pat him to say hi."
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
        style={flip ? { transform: "scaleX(-1)" } : undefined}
      >
        {webgl ? (
          <Suspense fallback={<RobotStill expression={expression} />}>
            <RobotCanvas expression={expression} motion={motion} look={look} animate={!reducedMotion} />
          </Suspense>
        ) : (
          <RobotStill expression={expression} />
        )}
        {mood === "asleep" ? <span className="cp-pet-zzz" aria-hidden="true">z z z</span> : null}
      </button>

      <div
        className={`cp-pet-bubble${open ? " is-open" : ""}${bubbleBelow ? " is-below" : ""}${bubbleLeft ? " is-left" : ""}`}
        role="group"
        aria-label="ChainPay robot"
        hidden={!open}
      >
        <p className="cp-pet-name">
          <strong>???</strong> <span>no name yet · {stage}</span>
        </p>
        <p className="cp-pet-line" aria-live="polite">{line}</p>
        <ul className="cp-pet-needs">
          {NEEDS.map((need) => (
            <li key={need}>
              <span>{NEED_LABEL[need]}</span>
              <span
                className={`cp-pet-bar${snapshot.needs[need] < 25 ? " is-low" : ""}`}
                role="meter"
                aria-label={NEED_LABEL[need]}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(snapshot.needs[need])}
              >
                <span style={{ width: `${snapshot.needs[need]}%` }} />
              </span>
            </li>
          ))}
        </ul>
        <div className="cp-pet-actions">
          <button type="button" onClick={() => act("feed")}>Charge</button>
          <button type="button" onClick={() => act("play")}>Play</button>
          <button type="button" onClick={() => act("clean")}>Polish</button>
          <button type="button" onClick={() => act("poke")}>Poke</button>
        </div>
        <p className="cp-pet-foot">
          <span>{isNight(now) ? "night mode · " : ""}he remembers you on this device</span>
          <button type="button" className="cp-pet-hide" onClick={onHide}>Hide</button>
        </p>
      </div>
    </div>
  );
}
