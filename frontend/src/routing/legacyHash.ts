const MICROSITE_USE_CASE = /^#\/use-cases(?:\/[^/?#]*)?\/?$/;
const MICROSITE_AIFI = /^#\/aifi\/?$/;

export function isLegacyMicrositeHash(hash: string): boolean {
  return MICROSITE_USE_CASE.test(hash) || MICROSITE_AIFI.test(hash);
}

export function legacyHashTarget(hash: string): string | null {
  if (MICROSITE_USE_CASE.test(hash) || MICROSITE_AIFI.test(hash)) return "/#how-it-works";
  return null;
}

export function applyLegacyHashRedirect(
  location: Pick<Location, "hash" | "pathname"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): boolean {
  const target = legacyHashTarget(location.hash);
  if (!target) return false;
  history.replaceState(history.state, "", target);
  return true;
}
