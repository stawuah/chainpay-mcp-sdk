import { useState } from "react";
import { ensureSessionReady } from "../session";

export function useOwnerSignIn() {
  const [status, setStatus] = useState<"idle" | "signing" | "ready" | "error">("idle");
  const [error, setError] = useState("");

  async function signIn() {
    setStatus("signing");
    setError("");
    try {
      await ensureSessionReady();
      setStatus("ready");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return { status, error, signIn };
}
