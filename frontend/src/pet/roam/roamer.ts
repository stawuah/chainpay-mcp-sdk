import { useCallback, useEffect, useRef, useState } from "react";

// Where the robot hangs out. He picks a new spot every 8 to 20 seconds: perched
// on a heading marked `data-pet-perch`, leaning in from a side edge, wandering
// along the bottom, or resting in the corner. He gets out of the way of
// anything you are typing into and of open dialogs.
//
// He always stays whole and inside the visible part of the browser window,
// whatever monitor it is on or however it is resized: every spot passes through
// `bound()`, which measures the layout viewport without the scrollbar and the
// visual viewport on phones (pinch zoom, on-screen keyboard).

export type RoamMode = "rest" | "edge" | "peek" | "perch" | "held" | "pinned";

/** Where the visitor pinned him, as fractions of the viewport so it survives resizes. */
export type Pin = { fx: number; fy: number };

export type RoamPosition = {
  x: number;
  y: number;
  mode: RoamMode;
  /** At the left edge he faces right, into the page. */
  side: "left" | "right";
  /** Whether the move should animate (false while tracking scroll or a drag). */
  glide: boolean;
};

const NAV_CLEARANCE = 88;
const MARGIN = 16;

type Viewport = { left: number; top: number; width: number; height: number };

/** The area he may occupy, in the fixed-position coordinate space. */
export function viewport(): Viewport {
  const root = document.documentElement;
  // clientWidth excludes a classic scrollbar; innerWidth would put him under it.
  let width = root.clientWidth || window.innerWidth;
  let height = root.clientHeight || window.innerHeight;
  let left = 0;
  let top = 0;
  const visual = window.visualViewport;
  if (visual) {
    left = visual.offsetLeft;
    top = visual.offsetTop;
    width = Math.min(width, visual.width);
    height = Math.min(height, visual.height);
  }
  return { left, top, width, height };
}

/** Clamp a top-left position so the whole robot is on screen with a margin. */
export function bound(x: number, y: number, size: number, view: Viewport = viewport()) {
  const maxX = view.left + view.width - size - MARGIN;
  const maxY = view.top + view.height - size - MARGIN;
  const minX = view.left + MARGIN;
  const minY = view.top + MARGIN;
  return {
    // If the window is narrower than the robot plus margins, centre him.
    x: maxX < minX ? view.left + (view.width - size) / 2 : Math.min(Math.max(x, minX), maxX),
    y: maxY < minY ? view.top + (view.height - size) / 2 : Math.min(Math.max(y, minY), maxY),
  };
}

function within(position: RoamPosition, size: number): RoamPosition {
  return { ...position, ...bound(position.x, position.y, size) };
}

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
  const view = viewport();
  const { x, y } = bound(Infinity, Infinity, size, view);
  const focused = document.activeElement;
  if (isTypingTarget(focused) && focused) {
    const rect = focused.getBoundingClientRect();
    if (overlaps(rect, x, y, size)) return { ...bound(-Infinity, y, size, view), mode: "rest", side: "right", glide: true };
  }
  return { x, y, mode: "rest", side: "right", glide: true };
}

function perchTargets(size: number): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-pet-perch]")].filter((element) => {
    const rect = perchRect(element);
    return rect.width > size && rect.top > NAV_CLEARANCE + size && rect.top < viewport().height - MARGIN;
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
  const span = Math.max(0, rect.width - size);
  // Sit on the line: his body overlaps the top of the heading a little.
  const { x, y } = bound(rect.left + span * offset, rect.top - size * 0.86, size);
  return { x, y, mode: "perch", side: "right", glide: true };
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
  const view = viewport();
  if (roll < 0.65) {
    // Lean in against a side edge, fully on screen, facing into the page.
    const side = Math.random() < 0.5 ? "left" : "right";
    const y = NAV_CLEARANCE + Math.random() * Math.max(0, view.height - NAV_CLEARANCE - size);
    const spot = bound(side === "left" ? -Infinity : Infinity, y, size, view);
    return { position: { ...spot, mode: "peek", side, glide: true } };
  }
  if (roll < 0.9) {
    const spot = bound(view.left + Math.random() * view.width, Infinity, size, view);
    return { position: { ...spot, mode: "edge", side: "right", glide: true } };
  }
  return { position: restSpot(size) };
}

export function pinAt(x: number, y: number): Pin {
  const view = viewport();
  return { fx: (x - view.left) / view.width, fy: (y - view.top) / view.height };
}

function pinnedSpot(pin: Pin, size: number): RoamPosition {
  const view = viewport();
  const spot = bound(view.left + pin.fx * view.width, view.top + pin.fy * view.height, size, view);
  return { ...spot, mode: "pinned", side: "right", glide: true };
}

export function useRoamer({ size, roam, pin }: { size: number; roam: boolean; pin: Pin | null }) {
  // Pinned: he stays put (and comes back there after a coin or a phone sheet).
  const home = useCallback(() => (pin ? pinnedSpot(pin, size) : restSpot(size)), [pin, size]);
  const [position, setPosition] = useState<RoamPosition>(() => (pin ? pinnedSpot(pin, size) : restSpot(size)));
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
        if (pin) {
          perch.current = null;
          setPosition(home());
          return;
        }
        const next = roam ? pick(size) : { position: restSpot(size) };
        perch.current = next.perch ?? null;
        setPosition(next.position);
        schedule(8_000 + Math.random() * 12_000);
      }, delay);
    },
    [roam, size, pin, home],
  );

  useEffect(() => {
    perch.current = null;
    setPosition(home());
    if (!pin) schedule(roam ? 3_000 : 60_000);
    return () => window.clearTimeout(timer.current);
  }, [roam, size, pin, home, schedule]);

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
          if (rect.top < NAV_CLEARANCE + size || rect.top > viewport().height) {
            perch.current = null;
            setPosition(restSpot(size));
            return;
          }
          setPosition({ ...perchSpot(current.element, size, current.offset), glide: false });
          return;
        }
        // Window resized, zoomed, or moved to a monitor of a different size:
        // keep his current spot if it still fits, otherwise pull him back in.
        setPosition((previous) => {
          if (previous.mode === "pinned") return { ...home(), glide: false };
          if (previous.mode === "peek") {
            const spot = bound(previous.side === "left" ? -Infinity : Infinity, previous.y, size);
            return { ...previous, ...spot, glide: false };
          }
          return { ...within(previous, size), glide: false };
        });
      });
    };
    const dodge = () => {
      if (!isTypingTarget(document.activeElement)) return;
      perch.current = null;
      setPosition(restSpot(size));
    };
    // A pinned robot steps aside while you type, then goes back to his pin.
    const undodge = () => {
      if (!pin) return;
      window.setTimeout(() => {
        if (!isTypingTarget(document.activeElement)) setPosition(home());
      }, 0);
    };
    window.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    window.visualViewport?.addEventListener("resize", follow);
    document.addEventListener("focusin", dodge);
    document.addEventListener("focusout", undodge);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
      window.visualViewport?.removeEventListener("resize", follow);
      document.removeEventListener("focusin", dodge);
      document.removeEventListener("focusout", undodge);
    };
  }, [size, pin, home]);

  const hold = useCallback(
    (x: number, y: number, glide = false) => {
      perch.current = null;
      heldUntil.current = Math.max(heldUntil.current, Date.now() + 15_000);
      setPosition(within({ x, y, mode: "held", side: "right", glide }, size));
    },
    [size],
  );

  const release = useCallback(() => {
    setPosition((previous) => ({ ...previous, mode: pin ? "pinned" : "rest", glide: true }));
    if (!pin) schedule(15_000);
  }, [schedule, pin]);

  /** Stay put (perch included) until `resume`; used while his panel is open. */
  const pause = useCallback(() => {
    heldUntil.current = Infinity;
    window.clearTimeout(timer.current);
  }, []);

  const resume = useCallback(
    (delay: number) => {
      heldUntil.current = 0;
      if (pin) {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPosition(home()), Math.min(delay, 1_500));
        return;
      }
      schedule(delay);
    },
    [schedule, pin, home],
  );

  /** Put him back somewhere sensible, e.g. after he sat on the phone sheet. */
  const settle = useCallback(() => {
    perch.current = null;
    setPosition(home());
  }, [home]);

  return { position, hold, release, pause, resume, settle };
}
