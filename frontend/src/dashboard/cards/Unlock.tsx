import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Eye, Lock } from "lucide-react";
import { errorText, type CardsShared } from "./shared";

/** One explicit, read-only signature opens the owner's private card details (ruling K3). */
export function UnlockStrip({ source, onUnlocked, compact = false }: Pick<CardsShared, "source" | "onUnlocked"> & { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function unlock() {
    setBusy(true);
    setError("");
    try {
      await source.unlock();
      onUnlocked();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`cp-unlock${compact ? " is-compact" : ""}`} data-testid="cards-unlock">
      <span className="cp-unlock-icon" aria-hidden="true"><Lock size={18} /></span>
      <div>
        <b>Your limits are private</b>
        <p>Only your wallet and people you add can read them. This signature only lets you read. It doesn't move money.</p>
        {error && <p className="cp-inline-error" role="alert">{error}</p>}
      </div>
      <Button type="button" variant="secondary" label={busy ? "Waiting for wallet…" : "Show private details"} icon={<Eye size={16} />} isDisabled={busy} onClick={() => void unlock()} />
    </div>
  );
}
