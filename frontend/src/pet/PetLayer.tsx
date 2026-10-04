import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { isNight, moodOf, NIGHT_END_UTC, stageFor, type Mood, type PetAction } from "./sim/needs";
import { petStore, usePet, type Reaction, type ReactionKind } from "./store";
import { pinAt, useRoamer, type Pin } from "./roam/roamer";
import { CanvasBoundary } from "./CanvasBoundary";
import { RobotStill } from "./RobotStill";
import { PetPanel, type PanelView } from "./PetPanel";
import { SpeechBubble } from "./play/SpeechBubble";
import { CoinToss, LandedCoin } from "./play/CoinToss";
import { DustLayer, useDust, type Speck } from "./play/Dust";
import { useAttentionCalls, useKeySecrets, useLandingTour, usePatCombo, useShake } from "./play/hooks";
import {
  BOOT_LINE,
  DUST_LINES,
  CALL_LINES,
  COIN_LINES,
  COOLING_LINES,
  CTA_LINE,
  DONE_LINES,
  GAME_COPY,
  GREETINGS,
  MOOD_LINES,
  SECRET_LINES,
} from "./play/lines";
import type { Expression, Motion } from "./RobotModel";
import { setPetSuppressed } from "../pet-prefs";
import "./pet.css";

const RobotCanvas = lazy(() => import("./RobotCanvas"));
const BamBamWorld = lazy(() => import("./world/BamBamWorld").then((m) => ({ default: m.BamBamWorld })));

const DAY = 86_400_000;
const DEBUG_KEY = "chainpay.pet.debug";
const PIN_KEY = "chainpay.pet.pin";

function readPin(): Pin | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(PIN_KEY) ?? "null") as Pin | null;
    return value && typeof value.fx === "number" && typeof value.fy === "number" ? value : null;
  } catch {
    return null;
  }
}

function writePin(pin: Pin | null) {
  try {
    if (pin) window.localStorage.setItem(PIN_KEY, JSON.stringify(pin));
    else window.localStorage.removeItem(PIN_KEY);
  } catch {
    // Memory only.
  }
}

// ---- Distraction budget (council ruling pet-play R5) -------------------------
// Everything he does without being asked goes through canVolunteer(). The
// tour is separate: it only ever speaks about the section you are reading.

const BUDGET_KEY = "chainpay.pet.budget";
const VOLUNTEER_GAP_MS = 20_000;
const VOLUNTEER_MAX = 6;
const CALLS_MAX = 2;

type Budget = { lines: number; lastAt: number; calls: number; dustLine: boolean };

function readBudget(): Budget {
  try {
    return { lines: 0, lastAt: 0, calls: 0, dustLine: false, ...JSON.parse(window.sessionStorage.getItem(BUDGET_KEY) ?? "{}") };
  } catch {
    return { lines: 0, lastAt: 0, calls: 0, dustLine: false };
  }
}

function writeBudget(budget: Budget) {
  try {
    window.sessionStorage.setItem(BUDGET_KEY, JSON.stringify(budget));
  } catch {
    // Memory only.
  }
}

let lastScrollAt = 0;
if (typeof window !== "undefined") {
  window.addEventListener("scroll", () => (lastScrollAt = Date.now()), { passive: true });
}

function readerIsBusy() {
  const speech = petStore.get().speech;
  const tourShowing = speech?.source === "tour" && Date.now() - speech.at < speech.ms;
  const dialog = [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"]')].some(
    (element) => !element.closest(".cp-pet-panel") && element.getClientRects().length > 0,
  );
  return tourShowing || dialog || Date.now() - lastScrollAt < 450;
}

/** How long each reaction drives his face and body. */
const REACTION_MS: Partial<Record<ReactionKind, number>> = { dizzy: 3_000, dance: 2_400, excited: 2_000, flip: 1_000 };
const reactionLive = (reaction: Reaction | null, now: number): reaction is Reaction =>
  Boolean(reaction && now - reaction.at < (REACTION_MS[reaction.kind] ?? 1_500));

const pickLine = <T,>(options: readonly T[]) => options[Math.floor(Math.random() * options.length)]!;

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

function expressionFor(mood: Mood, reaction: Reaction | null, now: number, booting: boolean, calling: boolean): Expression {
  if (booting) return "off";
  const live = reactionLive(reaction, now) ? reaction : null;
  if (live?.kind === "dizzy") return "dizzy";
  if (live?.kind === "surprised") return "surprised";
  if (mood === "grumpy" || live?.kind === "grumpy") return "grumpy";
  if (live?.kind === "excited" || live?.kind === "flip") return "excited";
  if (mood === "asleep") return "sleep";
  if (calling) return "excited";
  if (live && ["happy", "eat", "spin", "shake", "dance"].includes(live.kind)) return "happy";
  if (mood === "low") return "low";
  return mood === "happy" ? "happy" : "idle";
}

function motionFor(reaction: Reaction | null, now: number): Motion {
  if (!reactionLive(reaction, now)) return "none";
  switch (reaction.kind) {
    case "spin":
    case "shake":
    case "nope":
    case "eat":
    case "dance":
    case "flip":
      return reaction.kind;
    default:
      return "none";
  }
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

// Counting the visit must happen once per page load, even though React may
// run effects twice in development. Timers are rescheduled per effect run.
let arrival: ReturnType<typeof petStore.visit> | null = null;
const arrive = () => (arrival ??= petStore.visit());

type Props = {
  onHide: () => void;
  routeKey: string;
  routeKind: string;
  /** Turned on with the toggle: not an arrival, so no boot and no hello (B17). */
  quiet?: boolean;
};

export default function PetLayer({ onHide, routeKey, routeKind, quiet = false }: Props) {
  const { snapshot, bond, reaction, speech, now: storeClock } = usePet();
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const narrow = useMedia("(max-width: 600px)");
  const sheet = useMedia("(max-width: 600px), (max-height: 520px)");
  const webgl = useMemo(hasWebGL, []);
  const size = narrow ? 96 : 140;
  const [pin, setPinState] = useState<Pin | null>(readPin);
  const setPin = (next: Pin | null) => {
    writePin(next);
    setPinState(next);
  };
  const { position, hold, release, pause, resume, settle } = useRoamer({ size, roam: !reducedMotion && !narrow, pin });
  // While he comments on a section, he looks at its heading instead of the cursor.
  const [gaze, setGaze] = useState<{ x: number; y: number; until: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PanelView>("main");
  const [booting, setBooting] = useState(false);
  const [tossing, setTossing] = useState(false);
  const [world, setWorld] = useState(false);
  const [coin, setCoin] = useState<{ x: number; y: number } | null>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [clock, setClock] = useState(() => Date.now());
  const body = useRef<HTMLButtonElement>(null);
  const satOnSheet = useRef(false);
  const drag = useRef<{ startX: number; startY: number; dx: number; dy: number; moved: boolean } | null>(null);
  // React flushes the pointerup state change before the click event fires, so
  // "was that a drag?" has to live in a ref, not in render state.
  const dragged = useRef(false);

  // Play that happens to you (specks, calls, the tour) lives on the landing page
  // only. The dashboard and public receipts are for reading money, not play.
  const playful = routeKind === "landing";
  useEffect(() => {
    setPetSuppressed("pet-panel", open || tossing || world, "toggle");
    return () => setPetSuppressed("pet-panel", false);
  }, [open, tossing, world]);
  const latestBusy = useRef(false);

  /** One gate for specks, calls and lines he volunteers. Counts what it allows. */
  const canVolunteer = useCallback((kind: "line" | "speck" | "call") => {
    if (latestBusy.current || readerIsBusy()) return false;
    const budget = readBudget();
    const at = Date.now();
    if (kind === "call") {
      if (budget.calls >= CALLS_MAX) return false;
      writeBudget({ ...budget, calls: budget.calls + 1 });
      return true;
    }
    if (kind === "speck") return true;
    if (budget.lines >= VOLUNTEER_MAX || at - budget.lastAt < VOLUNTEER_GAP_MS) return false;
    writeBudget({ ...budget, lines: budget.lines + 1, lastAt: at });
    return true;
  }, []);
  const now = Math.max(clock, storeClock);
  const mood = moodOf(snapshot, now);
  const asleep = mood === "asleep";
  const busy = open || booting || tossing || coin !== null;

  // Re-render when a reaction or a spoken line should end.
  useEffect(() => {
    setClock(Date.now());
    const ends: number[] = [];
    if (reaction) ends.push(reaction.at + (REACTION_MS[reaction.kind] ?? 1_500) + 50);
    if (speech) ends.push(speech.at + speech.ms + 50);
    if (gaze) ends.push(gaze.until + 50);
    const timers = ends.map((at) => window.setTimeout(() => setClock(Date.now()), Math.max(0, at - Date.now())));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [reaction, speech, gaze]);

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

  // ---- Arrival: boot up the first time, welcome back after that. ----------
  const quietArrival = useRef(quiet);
  const routeKindAtMount = useRef(routeKind);
  useEffect(() => {
    const timers: number[] = [];
    let cancelled = false;
    // A hello is volunteered speech, which R5 allows on the landing only. Turning
    // him on with the toggle is not an arrival at all.
    if (quietArrival.current || routeKindAtMount.current !== "landing") return;
    void arrive().then(greeting => {
      if (cancelled) return;
      if (greeting !== "same-day") {
        // The hello (boot plus greeting) counts as one volunteered line.
        const budget = readBudget();
        writeBudget({ ...budget, lines: budget.lines + 1, lastAt: Date.now() });
      }
      const later = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms));
      if (greeting === "first") {
        setBooting(true);
        later(1_600, () => {
          setBooting(false);
          petStore.react("excited");
          petStore.say(BOOT_LINE, 2_400, "volunteer");
        });
        later(4_200, () => petStore.say(GREETINGS.first, 5_000, "volunteer"));
      } else if (greeting === "streak") {
        later(1_400, () => petStore.say(GREETINGS.streak(petStore.get().bond.streak), 5_000, "volunteer"));
      } else if (greeting === "back") {
        later(1_400, () => petStore.say(GREETINGS.back, 4_000, "volunteer"));
      }
      // Once greeted, hiding and un-hiding him does not replay the hello.
      later(4_300, () => {
        arrival = Promise.resolve("same-day");
      });
    });
    return () => { cancelled = true; timers.forEach((timer) => window.clearTimeout(timer)); };
  }, []);

  // ---- Panel ---------------------------------------------------------------
  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      setView("main");
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

  const speaking = speech && now - speech.at < speech.ms ? speech.text : null;
  const line = speaking ?? MOOD_LINES[mood];

  // ---- Combos and secrets ---------------------------------------------------
  const secret = async (name: string, line: string, kind: ReactionKind) => {
    petStore.react(kind);
    petStore.say(await petStore.secret(name) ? `${line} (${SECRET_LINES.found})` : line);
  };
  const onPatCombo = usePatCombo(useCallback(() => secret("dance", SECRET_LINES.dance, "dance"), []));
  const shake = useShake(
    useCallback(() => {
      petStore.note("dizzy");
      secret("dizzy", SECRET_LINES.dizzy, "dizzy");
    }, []),
  );
  useKeySecrets({
    enabled: true,
    onSecret: (name) => secret(name, name === "konami" ? SECRET_LINES.konami : SECRET_LINES.gm, name === "konami" ? "flip" : "happy"),
  });

  // ---- Care ----------------------------------------------------------------
  const act = async (action: PetAction) => {
    const wasAsleep = moodOf(petStore.get().snapshot, Date.now()) === "asleep";
    const result = await petStore.act(action);
    if (action === "pet") onPatCombo();
    if (!result.ok) {
      const cooling = COOLING_LINES[action];
      if (cooling) petStore.say(cooling(minutes(result.retryMs ?? 0)));
      return;
    }
    petStore.say(action === "poke" && wasAsleep ? MOOD_LINES.grumpy : DONE_LINES[action]);
  };

  const onGameFinish = async (won: boolean) => {
    // Winning is a full play session; losing still cheers him up a little.
    const result = await petStore.act("play", won ? undefined : { joy: 6, battery: -3 });
    petStore.note("games");
    if (won) petStore.note("wins");
    if (result.ok) petStore.reward(won ? "game-won" : "game-played", null, {}, won ? "dance" : "happy");
    else petStore.react(won ? "dance" : "happy");
    petStore.say(result.ok ? won ? GAME_COPY.wonLine : GAME_COPY.lostLine : "good game. still enjoying the last top-up.");
  };

  // ---- "!" calls -------------------------------------------------------------
  const calls = useAttentionCalls({
    enabled: playful && !busy && !asleep,
    allow: () => canVolunteer("call"),
    // Ignoring him costs nothing; the diary just notes you were busy.
    onMissed: () => petStore.miss("callsMissed"),
  });

  // ---- Dust ----------------------------------------------------------------
  const { specks, sweep, spawnNow } = useDust({
    enabled: playful && !booting,
    allow: () => canVolunteer("speck"),
    near: () => body.current?.getBoundingClientRect() ?? null,
    reducedMotion,
    onSpawn: () => {
      // The spawn line only for the first speck of the session.
      const budget = readBudget();
      if (budget.dustLine || open || asleep) return;
      writeBudget({ ...budget, dustLine: true });
      if (canVolunteer("line")) petStore.say(DUST_LINES.spawn, 2_500, "volunteer");
    },
    onEscape: () => petStore.miss("specksMissed"),
  });
  const onSweep = (speck: Speck) => {
    sweep(speck.id);
    petStore.reward("speck", "specks", { clean: 4 }, "happy");
    petStore.say(pickLine(DUST_LINES.sweep), 2_500);
  };

  // ---- Coin toss -------------------------------------------------------------
  const [tossByKeyboard, setTossByKeyboard] = useState(false);
  const startToss = (viaKeyboard: boolean) => {
    setTossByKeyboard(viaKeyboard);
    setOpen(false);
    setView("main");
    pause();
    setTossing(true);
  };
  const cancelToss = useCallback(() => {
    setTossing(false);
    resume(2_000);
    body.current?.focus({ preventScroll: true });
  }, [resume]);
  const onToss = (x: number, y: number) => {
    setTossing(false);
    body.current?.focus({ preventScroll: true });
    setCoin({ x, y });
    // Fly over so the coin lands in his visor's line of sight.
    hold(x - size / 2, y - size * 0.55, true);
    window.setTimeout(
      () => {
        setCoin(null);
        petStore.reward("coin", "coins", { joy: 3 }, "eat");
        petStore.say(pickLine(COIN_LINES), 2_500);
        resume(6_000);
      },
      reducedMotion ? 300 : 1_850,
    );
  };

  // ---- Landing tour ----------------------------------------------------------
  latestBusy.current = busy;
  const callingRef = useRef(false);
  callingRef.current = calls.calling;
  useLandingTour({
    enabled: playful,
    onSection: (id, text, heading) => {
      // One thing at a time: no tour bubble on top of a "!" call.
      if (latestBusy.current || callingRef.current) return false;
      // Don't talk over a direct answer to something you just did.
      const current = petStore.get().speech;
      if (current?.source === "reply" && Date.now() - current.at < 1_500) return false;
      petStore.say(text, 6_000, "tour", id);
      if (heading) {
        const rect = heading.getBoundingClientRect();
        setGaze({ x: rect.left + Math.min(rect.width, 360) / 2, y: rect.top + rect.height / 2, until: Date.now() + 2_500 });
      }
      return true;
    },
    onLeave: (id) => {
      const current = petStore.get().speech;
      if (current?.source === "tour" && current.key === id) {
        petStore.hush();
        setGaze(null);
      }
    },
    onCta: () => {
      if (latestBusy.current) return false;
      petStore.react("excited");
      petStore.say(CTA_LINE, 3_000, "tour", "cta");
      return true;
    },
  });

  // ---- Debug hooks for browser tests (opt-in via localStorage). -------------
  useEffect(() => {
    let debug = false;
    try {
      debug = window.localStorage.getItem(DEBUG_KEY) === "1";
    } catch {
      // ignore
    }
    if (!debug) return;
    const handle = { spawnDust: spawnNow, call: calls.callNow, say: (text: string) => petStore.say(text), state: () => petStore.get() };
    (window as unknown as { __chainpayPet?: typeof handle }).__chainpayPet = handle;
    return () => {
      delete (window as unknown as { __chainpayPet?: typeof handle }).__chainpayPet;
    };
  }, [spawnNow, calls.callNow]);

  // ---- Robot pointer handling --------------------------------------------
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      dx: event.clientX - position.x,
      dy: event.clientY - position.y,
      moved: false,
    };
    shake.reset(event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
    current.moved = true;
    shake.move(event.clientX);
    hold(event.clientX - current.dx, event.clientY - current.dy);
  };
  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.moved) {
      dragged.current = true;
      if (pin) setPin(pinAt(position.x, position.y));
      release();
    }
  };
  const onClick = () => {
    // A drag ends in a click too; only a still press counts as a pat.
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (booting) return;
    const answered = calls.answer();
    if (answered) {
      petStore.reward("call", "calls", { joy: 4 }, "excited");
      petStore.say(pickLine(CALL_LINES.answered));
    }
    if (open) {
      act("pet");
      close(false);
      return;
    }
    pause();
    setOpen(true);
    if (answered) {
      // He already said something; the pat still counts.
      petStore.act("pet");
      onPatCombo();
    } else {
      act("pet");
    }
  };

  const flip = position.mode === "peek" && position.side === "left";
  const gazing = gaze && gaze.until > now;
  const lookAt = gazing
    ? {
        x: Math.max(-1, Math.min(1, (gaze.x - (position.x + size / 2)) / (window.innerWidth / 2))),
        y: Math.max(-1, Math.min(1, (gaze.y - (position.y + size / 2)) / (window.innerHeight / 2))),
      }
    : look;
  const expression = expressionFor(mood, reaction, now, booting, calls.calling);
  const motion = motionFor(reaction, now);
  const stage = stageFor(snapshot.bornAt, now);
  const day = Math.floor((now - snapshot.bornAt) / DAY) + 1;

  return (
    <>
      <div
        className={`cp-pet${position.glide ? " is-gliding" : ""}${mood === "low" ? " is-low" : ""}${asleep ? " is-asleep" : ""}${booting ? " is-booting" : ""}`}
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, width: size, height: size, visibility: world ? "hidden" : undefined }}
        data-mode={position.mode}
        data-stage={stage}
      >
        <button
          ref={body}
          type="button"
          className="cp-pet-body"
          aria-label={calls.calling ? "Bam Bam is calling you" : "Open Bam Bam"}
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
            <CanvasBoundary fallback={<RobotStill expression={expression} />}><Suspense fallback={<RobotStill expression={expression} />}>
              <RobotCanvas expression={expression} motion={motion} look={lookAt} animate={!reducedMotion} gear={bond.gearOn} />
            </Suspense></CanvasBoundary>
          ) : (
            <RobotStill expression={expression} />
          )}
          {asleep ? <span className="cp-pet-zzz" aria-hidden="true">z z z</span> : null}
        </button>
        {calls.calling ? <span className="cp-pet-call" aria-hidden="true">!</span> : null}
      </div>

      {speaking && !open && !tossing ? <SpeechBubble key={speech!.at} text={speaking} anchor={{ x: position.x, y: position.y, size }} /> : null}
      {tossing ? <CoinToss onToss={onToss} onCancel={cancelToss} viaKeyboard={tossByKeyboard} /> : null}
      {coin ? <LandedCoin x={coin.x} y={coin.y} /> : null}
      <DustLayer specks={specks} onSweep={onSweep} />
      {world ? (
        <Suspense fallback={null}>
          <BamBamWorld
            mode="panel"
            onClose={() => {
              setWorld(false);
              requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-world-opener]")?.focus({ preventScroll: true }));
            }}
            onFinish={({ won }) => void onGameFinish(won)}
          />
        </Suspense>
      ) : null}

      <PetPanel
        open={open}
        view={view}
        onView={setView}
        bond={bond}
        onToss={startToss}
        onGameFinish={onGameFinish}
        onOpenWorld={() => setWorld(true)}
        onToggleGear={(item) => petStore.toggleGear(item)}
        pinned={pin !== null}
        onTogglePin={() => {
          if (pin) {
            setPin(null);
            petStore.say("free to roam again.", 2_500);
          } else {
            setPin(pinAt(position.x, position.y));
            petStore.say("ok. i'll stay right here.", 2_500);
          }
        }}
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
