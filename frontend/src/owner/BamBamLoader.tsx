import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Check, Gamepad2 } from "lucide-react";
import { setPetSuppressed } from "../pet-prefs";
import { RobotStill } from "../pet/RobotStill";
import type { WalletContextValue } from "../wallet/context";
import "../pet/world/world.css";
import "./bam-bam-loader.css";

// Bam Bam's sign-in loader. It opens right after a wallet sign-in, over the
// dashboard that is really loading underneath, and lists only the stages
// loadWalletState actually runs. "Go to dashboard" leaves at any time. It
// closes itself when the data lands, unless a game has started: then it waits
// for the user. Council ruling B1–B13, B36 (bam-bam-loader-ruling-2026-10-04).

const SharedRobot = lazy(() => import("../pet/shared/SharedRobot").then((m) => ({ default: m.SharedRobot })));
const BamBamWorld = lazy(() => import("../pet/world/BamBamWorld").then((m) => ({ default: m.BamBamWorld })));

export const LOADER_MIN_MS = 900;
export const LOADER_HOLD_MS = 300;
export const LOADER_CAP_MS = 8_000;
/** If no fresh load starts this soon after sign-in, the status we see is the real one. */
const LOAD_START_GRACE_MS = 600;

type Stage = NonNullable<WalletContextValue["loadStage"]>;
const STAGES: { id: Stage; label: string }[] = [
  { id: "wallet", label: "Checking Devnet setup" },
  { id: "permissions", label: "Reading your spending permissions" },
  { id: "agents", label: "Checking what your agents can see" },
];
const ERROR_LINE = "Some information could not be refreshed";

type Phase = "loading" | "ready" | "error";

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function BamBamLoader({
  integrationStatus,
  loadStage,
  withAgents,
  onDone,
}: {
  integrationStatus: WalletContextValue["integrationStatus"];
  loadStage: WalletContextValue["loadStage"];
  /** Stage C only runs with a session; a skipped stage never shows (B6). */
  withAgents: boolean;
  onDone: () => void;
}) {
  const reduced = useReducedMotion();
  const t0 = useRef(performance.now());
  const [sawLoad, setSawLoad] = useState(integrationStatus === "loading");
  const [graceOver, setGraceOver] = useState(false);
  const [reached, setReached] = useState(() => (loadStage ? STAGES.findIndex((s) => s.id === loadStage) : 0));
  const [game, setGame] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [pose, setPose] = useState<{ expression: "idle" | "happy" | "excited" | "low"; id: number }>({ expression: "idle", id: 0 });
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const stages = STAGES.filter((s) => s.id !== "agents" || withAgents);

  useEffect(() => {
    setPetSuppressed("loader", true);
    return () => setPetSuppressed("loader", false);
  }, []);

  useEffect(() => {
    if (integrationStatus === "loading") setSawLoad(true);
  }, [integrationStatus]);
  useEffect(() => {
    const timer = window.setTimeout(() => setGraceOver(true), LOAD_START_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // A row turns done only when the load really moves past it.
  useEffect(() => {
    if (!loadStage) return;
    const index = STAGES.findIndex((s) => s.id === loadStage);
    setReached((r) => Math.max(r, index));
  }, [loadStage]);

  const settled = (sawLoad || graceOver) && integrationStatus !== "loading";
  const phase: Phase = settled ? (integrationStatus === "error" ? "error" : "ready") : "loading";
  // Every stage runs before an error is reported, so on error they all ran (m1).
  const doneCount = phase === "loading" ? reached : stages.length;

  // Bam Bam's face: happy for half a second per finished stage (B9).
  const lastDone = useRef(0);
  useEffect(() => {
    if (doneCount <= lastDone.current) return;
    lastDone.current = doneCount;
    if (phase === "ready" && gameStarted) {
      setPose((p) => ({ expression: "excited", id: p.id + 1 }));
      const timer = window.setTimeout(() => setPose((p) => ({ expression: "idle", id: p.id + 1 })), 800);
      return () => window.clearTimeout(timer);
    }
    setPose((p) => ({ expression: "happy", id: p.id + 1 }));
    if (phase === "ready") return;
    const timer = window.setTimeout(() => setPose((p) => ({ expression: "idle", id: p.id + 1 })), 500);
    return () => window.clearTimeout(timer);
  }, [doneCount, phase, gameStarted]);
  useEffect(() => {
    if (phase === "error" && gameStarted) setPose((p) => ({ expression: "low", id: p.id + 1 }));
  }, [phase, gameStarted]);

  const leave = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(
      () => {
        onDone();
        const main = document.querySelector<HTMLElement>("main#dashboard, main");
        if (main) {
          if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
          main.focus({ preventScroll: true });
        }
      },
      reduced ? 120 : 240,
    );
  }, [leaving, onDone, reduced]);

  // Closing by itself (B8): never once a game has started.
  useEffect(() => {
    if (gameStarted || leaving) return;
    const elapsed = performance.now() - t0.current;
    if (phase === "error") {
      leave();
      return;
    }
    if (phase === "ready") {
      const timer = window.setTimeout(leave, Math.max(LOADER_HOLD_MS, LOADER_MIN_MS - elapsed));
      return () => window.clearTimeout(timer);
    }
    const cap = window.setTimeout(leave, Math.max(0, LOADER_CAP_MS - elapsed));
    return () => window.clearTimeout(cap);
  }, [phase, gameStarted, leaving, leave]);

  useEffect(() => {
    button.current?.focus({ preventScroll: true });
  }, []);

  // Esc at the loader level leaves; inside a game the world closes the game first (B12).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (game) closeGame();
      else leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, leave]);

  const openGame = () => {
    setGame(true);
    setGameStarted(true);
  };
  const closeGame = () => {
    setGame(false);
    window.setTimeout(() => button.current?.focus({ preventScroll: true }), 0);
  };

  const primary = phase !== "loading" && gameStarted;
  const line = phase === "ready" && gameStarted ? "dashboard's ready. no rush." : phase === "error" && gameStarted ? "hmm. something didn't load." : "one sec. getting your stuff.";
  const current = phase === "loading" ? stages[Math.min(reached, stages.length - 1)] : null;
  const announce = phase === "ready" ? "Dashboard ready" : phase === "error" ? ERROR_LINE : current?.label ?? "";

  const goButton = (
    <button ref={button} type="button" className={`cp-bbl-go${primary ? " is-primary" : ""}`} onClick={leave}>
      Go to dashboard
    </button>
  );

  return (
    <div
      ref={root}
      className={`cp-bb cp-bbl${leaving ? " is-leaving" : ""}${game ? " is-playing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bb-loader-title"
    >
      <h2 id="bb-loader-title" className="cp-sr">
        Opening your dashboard
      </h2>
      <div className="cp-bbl-skeleton" aria-hidden="true">
        <span className="cp-bbl-side" />
        <span className="cp-bbl-top" />
        <span className="cp-bbl-card is-a" />
        <span className="cp-bbl-card is-b" />
        <span className="cp-bbl-card is-c" />
      </div>

      {game ? (
        <>
          <div className="cp-bbl-bar">
            <span className="cp-bbl-bar-step">
              {phase === "loading" && current ? (
                <>
                  <span className="cp-bbl-glyph is-current" aria-hidden="true" />
                  <span className="cp-bbl-bar-text">{current.label}</span>
                </>
              ) : phase === "ready" ? (
                <>
                  <Check className="cp-bbl-check" size={16} strokeWidth={2} aria-hidden="true" />
                  <span className="cp-bbl-bar-text">Dashboard's ready</span>
                </>
              ) : (
                <span className="cp-bbl-bar-text is-error">{ERROR_LINE}</span>
              )}
            </span>
            {goButton}
          </div>
          <Suspense fallback={null}>
            <BamBamWorld mode="loader" onClose={closeGame} />
          </Suspense>
        </>
      ) : (
        <div className="cp-bbl-stack">
          <div className="cp-bbl-robot">
            <Suspense fallback={<RobotStill expression="idle" />}>
              <SharedRobot state={null} action={null} expression={pose.expression} motion="none" look={{ x: 0, y: 0.55 }} reactionId={pose.id} stillWhenReduced />
            </Suspense>
          </div>
          <p className="cp-bbl-line">{line}</p>
          <ol className="cp-bbl-steps">
            {stages.map((stage, i) => {
              const state = phase === "ready" || i < doneCount ? "done" : phase === "loading" && i === reached ? "current" : "pending";
              return (
                <li key={stage.id} className={`cp-bbl-step is-${state}`}>
                  {state === "done" ? (
                    <Check className="cp-bbl-check" size={16} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <span className={`cp-bbl-glyph is-${state}`} aria-hidden="true" />
                  )}
                  <span>{stage.label}</span>
                </li>
              );
            })}
          </ol>
          {phase === "error" ? (
            <p className="cp-bbl-alert">
              {ERROR_LINE}
            </p>
          ) : null}
          {goButton}
          {/* Bam Bam picks the game (Dre, 2026-10-04): one offer, no menu. */}
          <button type="button" className="cp-bbl-pill" onClick={openGame}>
            <Gamepad2 size={14} strokeWidth={1.75} aria-hidden="true" /> Play while you wait
          </button>
        </div>
      )}
      <p className="cp-sr" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
