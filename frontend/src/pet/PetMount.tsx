import { lazy, Suspense, useEffect, useState } from "react";

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

export function PetMount({ routeKind }: { routeKind: string }) {
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(readHidden);

  useEffect(() => {
    if (DISABLED) return;
    return whenIdle(() => setReady(true));
  }, []);

  // Embeds live inside someone else's page; he stays home for those.
  if (DISABLED || !ready || routeKind === "embed-overview") return null;

  if (hidden) {
    return (
      <button
        type="button"
        className="cp-pet-return"
        onClick={() => {
          writeHidden(false);
          setHidden(false);
        }}
        aria-label="Bring the ChainPay robot back"
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 60,
          width: 36,
          height: 36,
          border: "1px solid #dbe5ff",
          borderRadius: 18,
          background: "#fff",
          color: "#0052ff",
          font: "700 13px/1 system-ui, sans-serif",
          boxShadow: "0 8px 20px -12px rgb(20 33 61 / 0.5)",
          cursor: "pointer",
        }}
      >
        ••
      </button>
    );
  }

  return (
    <Suspense fallback={null}>
      <PetLayer
        onHide={() => {
          writeHidden(true);
          setHidden(true);
        }}
      />
    </Suspense>
  );
}
