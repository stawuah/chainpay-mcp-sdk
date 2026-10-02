import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { viewport } from "../roam/roamer";

// Little glitch bugs: the Tamagotchi mess you clean up. They wander along the
// edges of the window (never across the middle of what you're reading), and a
// click squashes one. Ignore one long enough and it gets away.

export type Bug = { id: number; x: number; y: number; angle: number; born: number; squashed: boolean };

const BAND = 96;
const SIZE = 28;
const LIFETIME_MS = 60_000;
const MAX_BUGS = 3;

function edgePoint(): { x: number; y: number } {
  const view = viewport();
  const side = Math.random();
  const margin = 12;
  const along = (span: number) => margin + Math.random() * Math.max(0, span - SIZE - margin * 2);
  if (side < 0.5) return { x: view.left + along(view.width), y: view.top + view.height - margin - SIZE - Math.random() * BAND };
  if (side < 0.75) return { x: view.left + margin + Math.random() * BAND, y: view.top + 96 + along(view.height - 96) };
  return { x: view.left + view.width - margin - SIZE - Math.random() * BAND, y: view.top + 96 + along(view.height - 96) };
}

function step(bug: Bug): Bug {
  const view = viewport();
  const next = { x: bug.x + (Math.random() - 0.5) * 140, y: bug.y + (Math.random() - 0.5) * 100 };
  // Stay in the edge bands: snap back toward the nearest edge if he strays.
  const nearBottom = view.top + view.height - next.y < BAND + SIZE + 12;
  const nearLeft = next.x - view.left < BAND + 12;
  const nearRight = view.left + view.width - next.x < BAND + SIZE + 12;
  if (!nearBottom && !nearLeft && !nearRight) return { ...bug, ...edgePoint(), angle: bug.angle };
  next.x = Math.min(Math.max(next.x, view.left + 12), view.left + view.width - SIZE - 12);
  next.y = Math.min(Math.max(next.y, view.top + 96), view.top + view.height - SIZE - 12);
  const angle = (Math.atan2(next.y - bug.y, next.x - bug.x) * 180) / Math.PI + 90;
  return { ...bug, ...next, angle };
}

type Options = {
  enabled: boolean;
  /** 0–100; dirtier robot, more bugs. */
  clean: number;
  onSpawn: (bug: Bug) => void;
  onEscape: () => void;
};

export function useBugs({ enabled, clean, onSpawn, onEscape }: Options) {
  // The ref is the source of truth so side effects (spawn/escape callbacks)
  // run once, outside React's state updaters.
  const list = useRef<Bug[]>([]);
  const [bugs, setBugs] = useState<Bug[]>([]);
  const nextId = useRef(1);
  const latest = useRef({ enabled, clean, onSpawn, onEscape });
  latest.current = { enabled, clean, onSpawn, onEscape };
  const commit = (next: Bug[]) => {
    list.current = next;
    setBugs(next);
  };

  // Spawn every 40–70s while the page is visible; more likely when he's dusty.
  useEffect(() => {
    if (!enabled) {
      commit([]);
      return;
    }
    let timer: number;
    const plan = (delay: number) => {
      timer = window.setTimeout(() => {
        const live = list.current.filter((bug) => !bug.squashed).length;
        const chance = latest.current.clean < 70 ? 0.85 : 0.4;
        if (!document.hidden && live < MAX_BUGS && Math.random() < chance) {
          const bug: Bug = { id: nextId.current++, ...edgePoint(), angle: 0, born: Date.now(), squashed: false };
          commit([...list.current, bug]);
          latest.current.onSpawn(bug);
        }
        plan(40_000 + Math.random() * 30_000);
      }, delay);
    };
    plan(25_000);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  // Crawl, and let old bugs escape.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (list.current.length === 0) return;
      const now = Date.now();
      const escaped = list.current.filter((bug) => !bug.squashed && now - bug.born > LIFETIME_MS);
      const kept = list.current.filter((bug) => !escaped.includes(bug));
      commit(kept.map((bug) => (bug.squashed ? bug : step(bug))));
      escaped.forEach(() => latest.current.onEscape());
    }, 2_400);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const squash = useCallback((id: number) => {
    commit(list.current.map((bug) => (bug.id === id ? { ...bug, squashed: true } : bug)));
    window.setTimeout(() => commit(list.current.filter((bug) => bug.id !== id)), 600);
  }, []);

  /** For tests and the room page later: drop a bug right now. */
  const spawnNow = useCallback(() => {
    if (!latest.current.enabled) return;
    const bug: Bug = { id: nextId.current++, ...edgePoint(), angle: 0, born: Date.now(), squashed: false };
    commit([...list.current, bug]);
    latest.current.onSpawn(bug);
  }, []);

  return { bugs, squash, spawnNow };
}

export function BugLayer({ bugs, onSquash }: { bugs: Bug[]; onSquash: (bug: Bug) => void }) {
  if (bugs.length === 0) return null;
  return createPortal(
    <>
      {bugs.map((bug) => (
        <button
          key={bug.id}
          type="button"
          className={`cp-pet-bug${bug.squashed ? " is-squashed" : ""}`}
          style={{ transform: `translate3d(${bug.x}px, ${bug.y}px, 0)` }}
          aria-label="Squash the bug"
          disabled={bug.squashed}
          onClick={() => onSquash(bug)}
        >
          <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" style={{ transform: `rotate(${bug.angle}deg)` }}>
            <g stroke="#0a0b0d" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 11 4 8M8 15H3M8 19l-4 3M20 11l4-3M20 15h5M20 19l4 3M12 7 10 4M16 7l2-3" />
            </g>
            <ellipse cx="14" cy="16" rx="6.5" ry="8" fill="#0a0b0d" />
            <circle cx="14" cy="9" r="3.6" fill="#0a0b0d" />
            <path d="M14 9.5v13.5" stroke="#0052ff" strokeWidth="1.4" />
            <circle cx="12.6" cy="8.4" r="0.9" fill="#fff" />
            <circle cx="15.4" cy="8.4" r="0.9" fill="#fff" />
          </svg>
        </button>
      ))}
    </>,
    document.body,
  );
}
