import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// What he says while his panel is closed: a small card beside him, gone after
// a few seconds. It never takes focus and never blocks the page.

type Props = { text: string; anchor: { x: number; y: number; size: number } };

const GAP = 4;
const EDGE = 12;

export function SpeechBubble({ text, anchor }: Props) {
  const bubble = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const node = bubble.current;
    if (!node) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const cx = anchor.x + anchor.size / 2;
    // His head sits in the top half of the box; speak from just above it.
    const top = anchor.y + anchor.size * 0.12;
    let y = top - GAP - height;
    if (y < EDGE) y = anchor.y + anchor.size + GAP;
    y = Math.min(Math.max(y, EDGE), vh - EDGE - height);
    const x = Math.min(Math.max(cx - width / 2, EDGE), vw - EDGE - width);
    setPlace({ x, y });
  }, [text, anchor.x, anchor.y, anchor.size]);

  return createPortal(
    <div
      ref={bubble}
      className={`cp-pet-speech${place ? " is-shown" : ""}`}
      style={place ? { left: place.x, top: place.y } : { left: 0, top: 0, visibility: "hidden" }}
      role="status"
    >
      {text}
    </div>,
    document.body,
  );
}
