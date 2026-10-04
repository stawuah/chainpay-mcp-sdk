import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Bot, BotOff } from "lucide-react";
import { setPetEnabled, surfaceFor, usePetEnabled, usePetSuppressed } from "../pet-prefs";
import "../pet-toggle.css";

// The only pet module on the every-route path. It stays tiny: it waits for the
// page to finish loading and go idle, then pulls in the pet chunk (and three.js
// after that). Bam Bam is on by default on public pages and off in the
// dashboard; the bottom-right toggle flips him per surface, remembered per
// browser (council ruling B14–B18).

const PetLayer = lazy(() => import("./PetLayer"));
const CommunityCompanion = lazy(() => import("./shared/CommunityCompanion"));
const SHARED = import.meta.env.VITE_CHAINPAY_SHARED_PET === "on";

const DISABLED = import.meta.env.VITE_CHAINPAY_PET === "off";

function whenIdle(callback: () => void): () => void {
  let cancelled = false;
  let idleHandle: number | undefined;
  const run = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") idleHandle = window.requestIdleCallback(callback, { timeout: 4_000 });
    else idleHandle = globalThis.setTimeout(callback, 1_500) as unknown as number;
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", run);
    if (idleHandle === undefined) return;
    if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleHandle);
    else globalThis.clearTimeout(idleHandle);
  };
}

export function PetMount({ routeKind, routeKey }: { routeKind: string; routeKey: string }) {
  const [ready, setReady] = useState(false);
  const surface = surfaceFor(routeKind);
  const on = usePetEnabled(surface);
  const hiddenForOverlay = usePetSuppressed("pet");
  const toggleAway = usePetSuppressed("toggle");
  const toggle = useRef<HTMLButtonElement>(null);
  // Turning him on is not an arrival: no boot, no greeting (B17). Only the
  // first mount of a page visit with him already on may say hello.
  const [quiet, setQuiet] = useState(false);
  const focusToggle = useRef(false);
  // After Hide, focus lands on the toggle once it's back on screen (B17).
  useEffect(() => {
    if (on || !focusToggle.current || !toggle.current) return;
    focusToggle.current = false;
    toggle.current.focus();
  }, [on, toggleAway]);

  useEffect(() => {
    if (DISABLED) return;
    return whenIdle(() => setReady(true));
  }, []);

  // Embeds live inside someone else's page; he stays home for those.
  // /support stars the robot in its hero, and the floating pet covered the tip card on phones (support-v2 ruling P13).
  if (DISABLED || !ready || routeKind === "embed-overview" || routeKind === "pet" || routeKind === "support") return null;

  const Layer = SHARED ? CommunityCompanion : PetLayer;
  return (
    <>
      {on && !hiddenForOverlay ? (
        <Suspense fallback={null}>
          <Layer
            routeKey={routeKey}
            routeKind={routeKind}
            quiet={quiet}
            onHide={() => {
              focusToggle.current = true;
              setPetEnabled(surface, false);
            }}
          />
        </Suspense>
      ) : null}
      {toggleAway ? null : (
        <button
          ref={toggle}
          type="button"
          className={`cp-pet-toggle${on ? " is-on" : ""}`}
          aria-label="Bam Bam"
          aria-pressed={on}
          title={on ? "Bam Bam: on" : "Bam Bam: off"}
          onClick={() => {
            setQuiet(true);
            setPetEnabled(surface, !on);
          }}
        >
          {on ? <Bot size={18} strokeWidth={1.75} aria-hidden="true" /> : <BotOff size={18} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      )}
    </>
  );
}
