import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { isNight, moodOf, NIGHT_END_UTC, stageFor, type Mood, type PetAction } from "./sim/needs";
import { petStore, usePet, type Reaction } from "./store";
import { useRoamer } from "./roam/roamer";
import { RobotStill } from "./RobotStill";
import { PetPanel } from "./PetPanel";
import type { Expression, Motion } from "./RobotModel";
import "./pet.css";

const RobotCanvas = lazy(() => import("./RobotCanvas"));

// Copy per the council ruling, P6/P7: he speaks lowercase, no exclamation marks.
const LINES: Record<Mood, string> = {
  happy: "life's good. thanks for stopping by.",
  okay: "just floating around. you?",
  meh: "could use some attention, not gonna lie.",
  low: "low power… someone plug me in?",
  asleep: "zzz. dreaming in UTC.",
  grumpy: "i was SLEEPING.",
};

const DONE_LINES: Record<PetAction, string> = {
  feed: "nom. battery up.",
  play: "wheee.",
  clean: "squeaky clean.",
  pet: "hehe.",
  poke: "hey.",
};

const COOLING_LINES: Partial<Record<PetAction, (m: number) => string>> = {
  feed: (m) => `still full. back in ${m}m.`,
  play: (m) => `need a breather. ${m}m.`,
  clean: (m) => `already shiny. ${m}m.`,
};

const FIRST_LINE = "oh hi. i'm new here. no name yet.";
const MET_KEY = "chainpay.pet.met";
const SAY_MS = 4_000;
const DAY = 86_400_000;

function firstMeeting(): boolean {
  try {
    if (window.localStorage.getItem(MET_KEY)) return false;
    window.localStorage.setItem(MET_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Next 06:00 UTC, in the visitor's own clock. */
function wakeTime(now: number) {
  const wake = new Date(now);
  wake.setUTCHours(NIGHT_END_UTC, 0, 0, 0);
  if (wake.getTime() <= now) wake.setUTCDate(wake.getUTCDate() + 1);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(wake);
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

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

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export default function PetLayer({ onHide, routeKey }: { onHide: () => void; routeKey: string }) {
  const { snapshot, reaction } = usePet();
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const narrow = useMedia("(max-width: 600px)");
  const sheet = useMedia("(max-width: 600px), (max-height: 520px)");
  const webgl = useMemo(hasWebGL, []);
  const size = narrow ? 96 : 140;
  const { position, hold, release, pause, resume, settle } = useRoamer({ size, roam: !reducedMotion && !narrow });
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ text: string; at: number } | null>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [clock, setClock] = useState(() => Date.now());
  const body = useRef<HTMLButtonElement>(null);
  const satOnSheet = useRef(false);
  const drag = useRef<{ startX: number; startY: number; dx: number; dy: number; moved: boolean } | null>(null);

  // Re-render shortly after a reaction so the face settles back.
  useEffect(() => {
    setClock(Date.now());
    if (!reaction) return;
    const timer = window.setTimeout(() => setClock(Date.now()), 1_600);
    return () => window.clearTimeout(timer);
  }, [reaction]);

  // Spoken lines last four seconds, then his mood line comes back.
  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), SAY_MS);
    return () => window.clearTimeout(timer);
  }, [said]);

  // Cooldown countdowns tick once a minute while the panel is open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

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

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      if (satOnSheet.current) {
        satOnSheet.current = false;
        settle();
      }
      resume(1_500);
      if (returnFocus) body.current?.focus({ preventScroll: true });
    },
    [resume, settle],
  );

  // A new page closes the panel.
  const firstRoute = useRef(routeKey);
  useEffect(() => {
    if (firstRoute.current === routeKey) return;
    firstRoute.current = routeKey;
    close(false);
  }, [routeKey, close]);

  // P15: on phones, if he overlaps the sheet he hops up and sits on it.
  const onSheetRect = useCallback(
    (rect: DOMRect | null) => {
      if (!rect || !body.current) return;
      const me = body.current.getBoundingClientRect();
      const overlap = me.bottom > rect.top && me.top < rect.bottom && me.right > rect.left && me.left < rect.right;
      if (!overlap) return;
      satOnSheet.current = true;
      hold(rect.right - size - 8, rect.top - size + 20, true);
    },
    [hold, size],
  );

  const now = clock;
  const mood = moodOf(snapshot, now);
  const expression = expressionFor(mood, reaction, now);
  const motion = motionFor(reaction, now);
  const line = said && now - said.at < SAY_MS + 100 ? said.text : LINES[mood];
  const stage = stageFor(snapshot.bornAt, now);
  const day = Math.floor((now - snapshot.bornAt) / DAY) + 1;

  const say = (text: string) => {
    const at = Date.now();
    setClock(at);
    setSaid({ text, at });
  };

  const act = (action: PetAction) => {
    const wasAsleep = moodOf(petStore.get().snapshot, Date.now()) === "asleep";
    const result = petStore.act(action);
    if (!result.ok) {
      const cooling = COOLING_LINES[action];
      if (cooling) say(cooling(minutes(result.retryMs ?? 0)));
      return;
    }
    say(action === "poke" && wasAsleep ? LINES.grumpy : DONE_LINES[action]);
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
    if (current?.moved) release();
  };
  const onClick = () => {
    // A drag ends in a click too; only a still press counts as a pat.
    if (position.mode === "held" && !open) return;
    if (open) {
      petStore.act("pet");
      close(false);
      return;
    }
    pause();
    setOpen(true);
    const result = petStore.act("pet");
    if (firstMeeting()) say(FIRST_LINE);
    else if (result.ok) say(DONE_LINES.pet);
  };

  const flip = position.mode === "peek" && position.side === "left";

  return (
    <>
      <div
        className={`cp-pet${position.glide ? " is-gliding" : ""}${mood === "low" ? " is-low" : ""}${mood === "asleep" ? " is-asleep" : ""}`}
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, width: size, height: size }}
        data-mode={position.mode}
        data-stage={stage}
      >
        <button
          ref={body}
          type="button"
          className="cp-pet-body"
          aria-label="ChainPay robot"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? "cp-pet-panel" : undefined}
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
      </div>
      <PetPanel
        open={open}
        sheet={sheet}
        anchor={body.current}
        snapshot={snapshot}
        now={now}
        stage={`${capitalize(stage)} · day ${day}`}
        asleepUntil={isNight(now) && mood !== "grumpy" ? wakeTime(now) : null}
        line={line}
        onCare={act}
        onQuick={act}
        onHide={() => {
          close(false);
          onHide();
        }}
        onClose={close}
        onSheetRect={onSheetRect}
      />
    </>
  );
}
