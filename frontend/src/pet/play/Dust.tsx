import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { viewport } from "../roam/roamer";

// Dust specks: the Tamagotchi mess you clean up. One drifts into a side margin
// now and then (never onto what you're reading), and a click sweeps it up.
// Ignore it and it drifts off after a minute, at no cost.

export type Speck = { id: number; x: number; y: number; fromX: number; fromY: number; born: number; swept: boolean; settled: boolean };

const SIZE = 28;
const GUTTER_MIN = 72;
const LIFETIME_MS = 60_000;
const FIRST_MS = 60_000;

/**
 * Dust never land on text. They use a side gutter outside the page column
 * when it is wide enough, otherwise a spot right beside the robot.
 */
function spawnPoint(near: DOMRect | null): { x: number; y: number } {
  const view = viewport();
  const column = document.querySelector(".page-width")?.getBoundingClientRect();
  const top = view.top + 120;
  const span = Math.max(0, view.height - 120 - SIZE - 24);
  if (column) {
    const left = column.left - view.left;
    const right = view.left + view.width - column.right;
    const sides = [left >= GUTTER_MIN ? "left" : null, right >= GUTTER_MIN ? "right" : null].filter(Boolean);
    if (sides.length > 0) {
      const side = sides[Math.floor(Math.random() * sides.length)];
      const gutter = side === "left" ? left : right;
      const x = side === "left" ? view.left + (gutter - SIZE) / 2 : column.right + (gutter - SIZE) / 2;
      return { x, y: top + Math.random() * span };
    }
  }
  if (near) {
    // No margin (phones): settle on his own box, at his feet, never on text.
    const x = near.left + 4;
    const y = near.bottom - SIZE - 4;
    return {
      x: Math.min(Math.max(x, view.left + 8), view.left + view.width - SIZE - 8),
      y: Math.min(Math.max(y, view.top + 8), view.top + view.height - SIZE - 8),
    };
  }
  return { x: view.left + view.width - SIZE - 24, y: view.top + view.height - SIZE - 160 };
}

type Options = {
  enabled: boolean;
  /** Asked right before a spawn; false skips this one (distraction budget). */
  allow: () => boolean;
  /** The robot's box, for when there is no gutter. */
  near: () => DOMRect | null;
  reducedMotion: boolean;
  onSpawn: (speck: Speck) => void;
  onEscape: () => void;
};

/** One speck at a time; the first after a minute, then every two to three. */
export function useDust({ enabled, allow, near, reducedMotion, onSpawn, onEscape }: Options) {
  // The ref is the source of truth so side effects (spawn/escape callbacks)
  // run once, outside React's state updaters.
  const list = useRef<Speck[]>([]);
  const [specks, setSpecks] = useState<Speck[]>([]);
  const nextId = useRef(1);
  const latest = useRef({ enabled, allow, near, reducedMotion, onSpawn, onEscape });
  latest.current = { enabled, allow, near, reducedMotion, onSpawn, onEscape };
  const commit = (next: Speck[]) => {
    list.current = next;
    setSpecks(next);
  };

  const make = (): Speck => {
    const to = spawnPoint(latest.current.near());
    // Crawl in once from a little way off, then hold still.
    const from = latest.current.reducedMotion ? to : { x: to.x + (Math.random() < 0.5 ? -60 : 60), y: to.y + 40 };
    return { id: nextId.current++, x: to.x, y: to.y, fromX: from.x, fromY: from.y, born: Date.now(), swept: false, settled: latest.current.reducedMotion };
  };

  const add = () => {
    const speck = make();
    commit([...list.current, speck]);
    latest.current.onSpawn(speck);
    // Next frame: move to the resting spot so the crawl transition runs once.
    window.setTimeout(() => commit(list.current.map((item) => (item.id === speck.id ? { ...item, settled: true } : item))), 30);
  };

  useEffect(() => {
    if (!enabled) {
      commit([]);
      return;
    }
    let timer: number;
    const plan = (delay: number) => {
      timer = window.setTimeout(() => {
        const live = list.current.some((speck) => !speck.swept);
        if (!document.hidden && !live && Math.random() < 0.6 && latest.current.allow()) add();
        plan(120_000 + Math.random() * 60_000);
      }, delay);
    };
    plan(FIRST_MS);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  // Old specks leave quietly.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const escaped = list.current.filter((speck) => !speck.swept && now - speck.born > LIFETIME_MS);
      if (escaped.length === 0) return;
      commit(list.current.filter((speck) => !escaped.includes(speck)));
      escaped.forEach(() => latest.current.onEscape());
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const sweep = useCallback((id: number) => {
    commit(list.current.map((speck) => (speck.id === id ? { ...speck, swept: true } : speck)));
    window.setTimeout(() => commit(list.current.filter((speck) => speck.id !== id)), 600);
  }, []);

  /** For tests: drop a speck right now (still only on pages with specks). */
  const spawnNow = useCallback(() => {
    if (!latest.current.enabled) return;
    add();
  }, []);

  return { specks, sweep, spawnNow };
}

export function DustLayer({ specks, onSweep }: { specks: Speck[]; onSweep: (speck: Speck) => void }) {
  if (specks.length === 0) return null;
  return createPortal(
    <>
      {specks.map((speck) => (
        <button
          key={speck.id}
          type="button"
          className={`cp-pet-speck${speck.swept ? " is-swept" : ""}`}
          style={{ transform: `translate3d(${speck.settled ? speck.x : speck.fromX}px, ${speck.settled ? speck.y : speck.fromY}px, 0)` }}
          tabIndex={-1}
          aria-label="Sweep up the dust speck"
          disabled={speck.swept}
          onClick={() => onSweep(speck)}
        >
          <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
            {/* A dust bunny: a soft grey puff with two dot eyes. */}
            <g fill="#a8acb3">
              <circle cx="14" cy="15" r="8" />
              <circle cx="8.5" cy="12" r="4" />
              <circle cx="19.5" cy="11.5" r="4.5" />
              <circle cx="11" cy="20" r="4" />
              <circle cx="18" cy="20" r="4.2" />
            </g>
            <g stroke="#a8acb3" strokeWidth="1.2" strokeLinecap="round">
              <path d="M5 9 3 7M23 8l2-2M4 17H2M24 16h2" />
            </g>
            <circle cx="11.5" cy="14.5" r="1.3" fill="#0a0b0d" />
            <circle cx="16.5" cy="14.5" r="1.3" fill="#0a0b0d" />
          </svg>
        </button>
      ))}
    </>,
    document.body,
  );
}
