import { useEffect, useSyncExternalStore } from "react";
import { BACKEND_URL } from "../../config/public";
import { createSharedClient } from "./client";

let storage: Storage | undefined;
let pendingStorage: Storage | undefined;
try { storage = window.localStorage; pendingStorage = window.sessionStorage; } catch { /* Privacy mode remains usable. */ }
export const communityPet = createSharedClient({ base: BACKEND_URL, storage, pendingStorage });

export function useCommunityPet(active: boolean) {
  const view = useSyncExternalStore(communityPet.subscribe, communityPet.get);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      void communityPet.refresh();
      timer = setTimeout(poll, active ? 5_000 : 30_000);
    };
    const visible = () => { clearTimeout(timer); if (!document.hidden) poll(); };
    poll();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, [active]);
  return view;
}
