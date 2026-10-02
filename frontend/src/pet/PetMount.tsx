import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";

// The only pet module on the every-route path. It stays tiny: it waits for the
// page to finish loading and go idle, then pulls in the pet chunk (and three.js
// after that). Hiding the robot is remembered per browser.

const PetLayer = lazy(() => import("./PetLayer"));

const HIDDEN_KEY = "chainpay.pet.hidden";
const DISABLED = import.meta.env.VITE_CHAINPAY_PET === "off";

function readHidden() {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(HIDDEN_KEY, "1");
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Memory only.
  }
}

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
  const [hidden, setHidden] = useState(readHidden);
  // Hiding him from his panel moves focus to the button that brings him back,
  // so keyboard users are not dropped onto <body>.
  const focusRestore = useRef(false);
  const restore = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!hidden || !focusRestore.current) return;
    focusRestore.current = false;
    restore.current?.focus();
  }, [hidden]);

  useEffect(() => {
    if (DISABLED) return;
    return whenIdle(() => setReady(true));
  }, []);

  // Embeds live inside someone else's page; he stays home for those.
  if (DISABLED || !ready || routeKind === "embed-overview") return null;

  if (hidden) {
    return (
      <button
        ref={restore}
        type="button"
        className="cp-pet-return"
        onClick={() => {
          writeHidden(false);
          setHidden(false);
        }}
        aria-label="Bring the robot back"
        title="Bring the robot back"
        style={{
          position: "fixed",
          right: 16,
          bottom: "calc(16px + env(safe-area-inset-bottom))",
          // pet.css may not be loaded yet when he starts hidden, hence the fallback.
          zIndex: "var(--z-pet, 50)",
          display: "grid",
          placeItems: "center",
          width: 40,
          height: 40,
          padding: 0,
          border: 0,
          borderRadius: 100,
          background: "#fff",
          color: "#0a0b0d",
          boxShadow: "0 0 0 1px rgba(10,11,13,.06), 0 2px 4px rgba(10,11,13,.04), 0 18px 48px -16px rgba(20,33,61,.28)",
          cursor: "pointer",
        }}
      >
        <Bot size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    );
  }

  return (
    <Suspense fallback={null}>
      <PetLayer
        routeKey={routeKey}
        routeKind={routeKind}
        onHide={() => {
          focusRestore.current = true;
          writeHidden(true);
          setHidden(true);
        }}
      />
    </Suspense>
  );
}
