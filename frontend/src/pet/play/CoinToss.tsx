import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COIN_HINT } from "./lines";

// Toss mode: a coin follows the pointer; a click anywhere drops it there and
// he flies over to catch it. A full-screen layer takes that one click so the
// page underneath is never clicked by accident. Escape cancels.

type Props = {
  onToss: (x: number, y: number) => void;
  onCancel: () => void;
  /** Started from the keyboard: mention Enter. */
  viaKeyboard: boolean;
};

const coarse = () => window.matchMedia("(pointer: coarse)").matches;

export function CoinToss({ onToss, onCancel, viaKeyboard }: Props) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    layer.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      ref={layer}
      className="cp-pet-toss"
      tabIndex={-1}
      role="application"
      aria-label="Toss a coin. Click anywhere on the page, or press Escape to cancel."
      onPointerMove={(event) => setPoint({ x: event.clientX, y: event.clientY })}
      onPointerDown={(event) => {
        event.preventDefault();
        onToss(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        // Keyboard: toss into the middle of the screen.
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToss(window.innerWidth / 2, window.innerHeight / 2);
        }
      }}
    >
      <p className="cp-pet-toss-hint">
        {coarse() ? COIN_HINT.touch : COIN_HINT.pointer}
        {viaKeyboard ? COIN_HINT.keyboard : ""}
      </p>
      {point ? <span className="cp-pet-coin is-held" style={{ left: point.x, top: point.y }} aria-hidden="true" /> : null}
    </div>,
    document.body,
  );
}

/** The tossed coin, sitting where it landed until he gets there. */
export function LandedCoin({ x, y }: { x: number; y: number }) {
  return createPortal(<span className="cp-pet-coin is-landed" style={{ left: x, top: y }} aria-hidden="true" />, document.body);
}
