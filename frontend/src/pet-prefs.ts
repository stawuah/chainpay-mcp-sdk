import { useSyncExternalStore } from "react";

// Whether Bam Bam is out, per surface, remembered per browser. He's on by
// default on the public pages and off in the dashboard, where people come to
// read money. Lives outside src/pet so the every-route bundle stays tiny.

export type PetSurface = "landing" | "app";

const KEYS: Record<PetSurface, string> = { landing: "chainpay.pet.on.landing", app: "chainpay.pet.on.app" };
const DEFAULTS: Record<PetSurface, boolean> = { landing: true, app: false };
const LEGACY_HIDDEN = "chainpay.pet.hidden";

const listeners = new Set<() => void>();
const memory: Partial<Record<PetSurface, boolean>> = {};

export const surfaceFor = (routeKind: string): PetSurface => (routeKind === "app" ? "app" : "landing");

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Someone who hid the robot before the toggle existed keeps him hidden everywhere. */
function migrate(store: Storage) {
  try {
    if (store.getItem(LEGACY_HIDDEN) !== "1") return;
    store.setItem(KEYS.landing, "0");
    store.setItem(KEYS.app, "0");
    store.removeItem(LEGACY_HIDDEN);
  } catch {
    // Memory only.
  }
}

export function getPetEnabled(surface: PetSurface): boolean {
  const store = storage();
  if (!store) return memory[surface] ?? DEFAULTS[surface];
  migrate(store);
  try {
    const value = store.getItem(KEYS[surface]);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    // Fall through to memory.
  }
  return memory[surface] ?? DEFAULTS[surface];
}

export function setPetEnabled(surface: PetSurface, on: boolean) {
  memory[surface] = on;
  try {
    storage()?.setItem(KEYS[surface], on ? "1" : "0");
  } catch {
    // Memory only.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || Object.values(KEYS).includes(event.key)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePetEnabled(surface: PetSurface): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getPetEnabled(surface),
    () => DEFAULTS[surface],
  );
}

// While Bam Bam's loader or his world is open, the roaming robot and the
// toggle step aside so there's only ever one of him on screen (B1, B19). His
// own panel and coin toss hide only the toggle (B16b).
type Scope = "pet" | "toggle";
const suppressors = new Map<string, Scope>();
const suppressListeners = new Set<() => void>();

export function setPetSuppressed(reason: string, on: boolean, scope: Scope = "pet") {
  if (on === suppressors.has(reason) && (!on || suppressors.get(reason) === scope)) return;
  if (on) suppressors.set(reason, scope);
  else suppressors.delete(reason);
  suppressListeners.forEach((listener) => listener());
}

/** "pet": hide the robot too. "toggle": only the toggle needs to step aside. */
export function usePetSuppressed(scope: Scope): boolean {
  return useSyncExternalStore(
    (listener) => {
      suppressListeners.add(listener);
      return () => suppressListeners.delete(listener);
    },
    () => (scope === "toggle" ? suppressors.size > 0 : [...suppressors.values()].includes("pet")),
    () => false,
  );
}
