import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ensureSessionReady, hasReadySession, sessionWalletAddress, subscribeSession } from "../session";

export function useOwnerSignIn() {
  const ready = useSyncExternalStore(subscribeSession, hasReadySession, () => false);
  const owner = useSyncExternalStore(subscribeSession, sessionWalletAddress, () => null);
  const [status, setStatus] = useState<"idle" | "signing" | "error">("idle");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => { setStatus("idle"); setError(""); }, [owner]);

  async function signIn() {
    if (inFlight.current) return;
    inFlight.current = true;
    const expectedOwner = sessionWalletAddress();
    setStatus("signing");
    setError("");
    try {
      await ensureSessionReady();
      if (sessionWalletAddress() === expectedOwner) setStatus("idle");
    } catch (cause) {
      if (sessionWalletAddress() === expectedOwner) {
        setStatus("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally { inFlight.current = false; }
  }

  return { status: ready ? "ready" as const : status, error, signIn };
}
