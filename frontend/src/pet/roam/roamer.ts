import { useCallback, useEffect, useRef, useState } from "react";

// Where the robot hangs out. He picks a new spot every 8 to 20 seconds: perched
// on a heading marked `data-pet-perch`, peeking in from a side edge, wandering
// along the bottom, or resting in the corner. He gets out of the way of
// anything you are typing into and of open dialogs.

export type RoamMode = "rest" | "edge" | "peek" | "perch" | "held";

export type RoamPosition = {
  x: number;
  y: number;
  mode: RoamMode;
  /** Peeking from the left edge mirrors him. */
  side: "left" | "right";
  /** Whether the move should animate (false while tracking scroll or a drag). */
  glide: boolean;
};

const NAV_CLEARANCE = 88;
const MARGIN = 16;

function isTypingTarget(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

function dialogOpen(): boolean {
  // Astryx keeps closed <dialog role="dialog"> elements in the DOM, so presence
  // alone means nothing; only a dialog that is actually on screen counts.
  return [...document.querySelectorAll<HTMLElement>('dialog, [role="dialog"], [aria-modal="true"]')].some(
    (element) => !element.closest(".cp-pet") && element.getClientRects().length > 0,
  );
}

function overlaps(a: DOMRect, x: number, y: number, size: number) {
  return x < a.right && x + size > a.left && y < a.bottom && y + size > a.top;
}

function restSpot(size: number): RoamPosition {
  const x = window.innerWidth - size - MARGIN;
  const y = window.innerHeight - size - MARGIN;
  const focused = document.activeElement;
  if (isTypingTarget(focused) && focused) {
    const rect = focused.getBoundingClientRect();
    if (overlaps(rect, x, y, size)) return { x: MARGIN, y, mode: "rest", side: "right", glide: true };
  }
  return { x, y, mode: "rest", side: "right", glide: true };
}

function perchTargets(size: number): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-pet-perch]")].filter((element) => {
    const rect = perchRect(element);
    return rect.width > size && rect.top > NAV_CLEARANCE + size && rect.top < window.innerHeight - MARGIN;
  });
}

/**
 * Headings often have a kicker or step label right above them. Sitting on the
 * heading would cover that label, so climb to the top of the stack.
 */
function perchRect(element: HTMLElement): DOMRect {
  let rect = element.getBoundingClientRect();
  let above = element.previousElementSibling;
  while (above) {
    const aboveRect = above.getBoundingClientRect();
    if (aboveRect.height === 0 || rect.top - aboveRect.bottom > 40) break;
    rect = new DOMRect(rect.left, aboveRect.top, rect.width, rect.bottom - aboveRect.top);
    above = above.previousElementSibling;
  }
  return rect;
}

function perchSpot(element: HTMLElement, size: number, offset: number): RoamPosition {
  const rect = perchRect(element);
  const span = Math.max(0, Math.min(rect.width, window.innerWidth - rect.left - MARGIN) - size);
  return {
    x: rect.left + span * offset,
    // Sit on the line: his body overlaps the top of the heading a little.
    y: rect.top - size * 0.86,
    mode: "perch",
    side: "right",
    glide: true,
  };
}

function pick(size: number): { position: RoamPosition; perch?: { element: HTMLElement; offset: number } } {
  if (isTypingTarget(document.activeElement) || dialogOpen()) return { position: restSpot(size) };
  const roll = Math.random();
  const perches = perchTargets(size);
  if (roll < 0.4 && perches.length > 0) {
    const element = perches[Math.floor(Math.random() * perches.length)]!;
    const offset = Math.random();
    return { position: perchSpot(element, size, offset), perch: { element, offset } };
  }
  if (roll < 0.65) {
    const side = Math.random() < 0.5 ? "left" : "right";
    const y = NAV_CLEARANCE + Math.random() * Math.max(0, window.innerHeight - NAV_CLEARANCE - size * 1.5);
    // Half of him stays off-screen.
    const x = side === "left" ? -size * 0.45 : window.innerWidth - size * 0.55;
    return { position: { x, y, mode: "peek", side, glide: true } };
  }
  if (roll < 0.9) {
    const x = MARGIN + Math.random() * Math.max(0, window.innerWidth - size - MARGIN * 2);
    return { position: { x, y: window.innerHeight - size - MARGIN, mode: "edge", side: "right", glide: true } };
  }
  return { position: restSpot(size) };
}

export function useRoamer({ size, roam }: { size: number; roam: boolean }) {
  const [position, setPosition] = useState<RoamPosition>(() => restSpot(size));
  const perch = useRef<{ element: HTMLElement; offset: number } | null>(null);
  const heldUntil = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const schedule = useCallback(
    (delay: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (Date.now() < heldUntil.current || document.hidden) {
          schedule(4_000);
          return;
        }
        const next = roam ? pick(size) : { position: restSpot(size) };
        perch.current = next.perch ?? null;
        setPosition(next.position);
        schedule(8_000 + Math.random() * 12_000);
      }, delay);
    },
    [roam, size],
  );

  useEffect(() => {
    setPosition(restSpot(size));
    schedule(roam ? 3_000 : 60_000);
    return () => window.clearTimeout(timer.current);
  }, [roam, size, schedule]);

  // Keep a perch glued to its heading while the page scrolls; leave once the
  // heading is gone.
  useEffect(() => {
    let frame = 0;
    const follow = (event: Event) => {
      const resized = event.type === "resize";
      if (!perch.current && !resized) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = perch.current;
        if (current) {
          const rect = perchRect(current.element);
          if (rect.top < NAV_CLEARANCE + size || rect.top > window.innerHeight) {
            perch.current = null;
            setPosition(restSpot(size));
            return;
          }
          setPosition({ ...perchSpot(current.element, size, current.offset), glide: false });
          return;
        }
        setPosition((previous) => (previous.mode === "held" ? previous : clampToViewport(previous, size)));
      });
    };
    const dodge = () => {
      if (!isTypingTarget(document.activeElement)) return;
      perch.current = null;
      setPosition(restSpot(size));
    };
    window.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    document.addEventListener("focusin", dodge);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
      document.removeEventListener("focusin", dodge);
    };
  }, [size]);

  const hold = useCallback(
    (x: number, y: number) => {
      perch.current = null;
      heldUntil.current = Date.now() + 15_000;
      setPosition(clampToViewport({ x, y, mode: "held", side: "right", glide: false }, size));
    },
    [size],
  );

  const release = useCallback(() => {
    setPosition((previous) => ({ ...previous, mode: "rest", glide: true }));
    schedule(15_000);
  }, [schedule]);

  return { position, hold, release };
}

function clampToViewport(position: RoamPosition, size: number): RoamPosition {
  if (position.mode === "peek") {
    const x = position.side === "left" ? -size * 0.45 : window.innerWidth - size * 0.55;
    return { ...position, x, glide: false };
  }
  return {
    ...position,
    x: Math.min(Math.max(position.x, 0), window.innerWidth - size),
    y: Math.min(Math.max(position.y, 0), window.innerHeight - size),
    glide: false,
  };
}
