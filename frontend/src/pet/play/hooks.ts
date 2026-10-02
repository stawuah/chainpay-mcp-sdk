import { useCallback, useEffect, useRef, useState } from "react";
import { TOUR_LINES } from "./lines";

// ---- "!" attention calls ---------------------------------------------------
// Now and then he wants you. Click him within 30 seconds and you made his day;
// let it lapse and he remembers. First call comes early so a visitor sees it.

const CALL_OPEN_MS = 30_000;

export function useAttentionCalls({
  enabled,
  allow,
  onMissed,
}: {
  enabled: boolean;
  /** Asked right before a call starts; false skips it (distraction budget). */
  allow: () => boolean;
  onMissed: () => void;
}) {
  const [callingSince, setCallingSince] = useState<number | null>(null);
  const missed = useRef(onMissed);
  missed.current = onMissed;
  const allowed = useRef(allow);
  allowed.current = allow;
  const timer = useRef<number | undefined>(undefined);

  const schedule = useCallback((delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (document.hidden || !allowed.current()) {
        schedule(60_000);
        return;
      }
      setCallingSince(Date.now());
      timer.current = window.setTimeout(() => {
        setCallingSince(null);
        missed.current();
        schedule(180_000 + Math.random() * 180_000);
      }, CALL_OPEN_MS);
    }, delay);
  }, []);

  useEffect(() => {
    if (!enabled) {
      window.clearTimeout(timer.current);
      setCallingSince(null);
      return;
    }
    schedule(75_000 + Math.random() * 30_000);
    return () => window.clearTimeout(timer.current);
  }, [enabled, schedule]);

  /** Returns true if there was a call to answer. */
  const answer = useCallback(() => {
    if (callingSince === null) return false;
    setCallingSince(null);
    schedule(180_000 + Math.random() * 180_000);
    return true;
  }, [callingSince, schedule]);

  /** For tests: call right now, skipping the budget. */
  const callNow = useCallback(() => {
    window.clearTimeout(timer.current);
    setCallingSince(Date.now());
    timer.current = window.setTimeout(() => {
      setCallingSince(null);
      missed.current();
    }, CALL_OPEN_MS);
  }, []);

  return { calling: callingSince !== null, answer, callNow };
}

// ---- Secrets -----------------------------------------------------------------
// Konami code, typing "gm" anywhere that isn't a text field.

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

function typingInto(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function useKeySecrets({ enabled, onSecret }: { enabled: boolean; onSecret: (name: "konami" | "gm") => void }) {
  const latest = useRef(onSecret);
  latest.current = onSecret;
  useEffect(() => {
    if (!enabled) return;
    let konami = 0;
    let typed = "";
    const onKey = (event: KeyboardEvent) => {
      if (typingInto(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      konami = key === KONAMI[konami] ? konami + 1 : key === KONAMI[0] ? 1 : 0;
      if (konami === KONAMI.length) {
        konami = 0;
        latest.current("konami");
      }
      if (key.length === 1) {
        typed = (typed + key).slice(-2);
        if (typed === "gm") {
          typed = "";
          latest.current("gm");
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Five pats inside four seconds. */
export function usePatCombo(onCombo: () => void) {
  const pats = useRef<number[]>([]);
  return useCallback(() => {
    const now = Date.now();
    pats.current = [...pats.current.filter((at) => now - at < 4_000), now];
    if (pats.current.length >= 5) {
      pats.current = [];
      onCombo();
    }
  }, [onCombo]);
}

/** Shake detection while dragging: four direction reversals inside 1.5s. */
export function useShake(onShake: () => void) {
  const state = useRef<{ lastX: number; dir: number; flips: number[] }>({ lastX: 0, dir: 0, flips: [] });
  const reset = useCallback((x: number) => {
    state.current = { lastX: x, dir: 0, flips: [] };
  }, []);
  const move = useCallback(
    (x: number) => {
      const current = state.current;
      const dx = x - current.lastX;
      if (Math.abs(dx) < 8) return;
      const dir = Math.sign(dx);
      current.lastX = x;
      if (current.dir !== 0 && dir !== current.dir) {
        const now = Date.now();
        current.flips = [...current.flips.filter((at) => now - at < 1_500), now];
        if (current.flips.length >= 4) {
          current.flips = [];
          onShake();
        }
      }
      current.dir = dir;
    },
    [onShake],
  );
  return { reset, move };
}

// ---- Landing tour ------------------------------------------------------------
// He comments once per session on the section you are actually reading: the
// one crossing the middle of the screen, after you have stopped scrolling on
// it for a moment. Fast scrolling past a section says nothing. Where he is
// sitting on screen does not matter. He also gets excited when you hover
// "Open dashboard".

const TOUR_SEEN = "chainpay.pet.tour";
const SETTLE_MS = 450;
const DWELL_MS = 700;

function seen(): Set<string> {
  try {
    return new Set(JSON.parse(window.sessionStorage.getItem(TOUR_SEEN) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function remember(ids: Set<string>) {
  try {
    window.sessionStorage.setItem(TOUR_SEEN, JSON.stringify([...ids]));
  } catch {
    // Memory only.
  }
}

/** The tour section under the reading line (45% down the viewport). */
function sectionInView(): HTMLElement | null {
  const line = window.innerHeight * 0.45;
  for (const id of Object.keys(TOUR_LINES)) {
    const element = document.getElementById(id);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.top <= line && rect.bottom >= line) return element;
  }
  return null;
}

export function useLandingTour({
  enabled,
  onSection,
  onLeave,
  onCta,
}: {
  enabled: boolean;
  /** Return true if he said it (false when busy, so it can be tried again). */
  onSection: (id: string, line: string, heading: Element | null) => boolean;
  /** The reader moved off this section: drop its line at once. */
  onLeave: (id: string) => void;
  onCta: () => boolean;
}) {
  const latest = useRef({ onSection, onLeave, onCta });
  latest.current = { onSection, onLeave, onCta };

  useEffect(() => {
    if (!enabled) return;
    const done = seen();
    let lastScroll = 0;
    let candidate: string | null = null;
    let since = 0;

    // Leaving is checked on every scroll frame, so a line never outlives its
    // section; speaking waits for the slower settle-and-dwell check below.
    let frame = 0;
    const onScroll = () => {
      lastScroll = performance.now();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = sectionInView()?.id ?? null;
        if (id === candidate) return;
        if (candidate) latest.current.onLeave(candidate);
        candidate = id;
        since = performance.now();
      });
    };
    const check = () => {
      const now = performance.now();
      const section = sectionInView();
      const id = section?.id ?? null;
      if (id !== candidate) {
        if (candidate) latest.current.onLeave(candidate);
        candidate = id;
        since = now;
        return;
      }
      if (!section || !id || done.has(id)) return;
      if (now - lastScroll < SETTLE_MS || now - since < DWELL_MS) return;
      const heading = section.querySelector("h2");
      if (latest.current.onSection(id, TOUR_LINES[id]!, heading)) {
        done.add(id);
        remember(done);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const timer = window.setInterval(check, 200);

    const onOver = (event: PointerEvent) => {
      if (done.has("cta") || !(event.target instanceof Element)) return;
      const button = event.target.closest("button, a");
      if (!button || !/open dashboard/i.test(button.textContent ?? "")) return;
      if (latest.current.onCta()) {
        done.add("cta");
        remember(done);
      }
    };
    document.addEventListener("pointerover", onOver);
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      document.removeEventListener("pointerover", onOver);
    };
  }, [enabled]);
}
