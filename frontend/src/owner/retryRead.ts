/**
 * Retry a network read that the dashboard performs once at mount.
 *
 * The relay sleeps when idle, and its first replies after waking never reach the
 * page. A read that runs once and gives up leaves its value null for as long as
 * the tab stays open: the expiry field falls back to manual slot entry, and only
 * a reload restores it. These reads are safe to repeat because they change
 * nothing.
 *
 * Resolves to null once the attempts are spent, so callers keep their existing
 * "unavailable" handling.
 */
export async function retryRead<T>(
  read: () => Promise<T | null>,
  options: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    cancelled?: () => boolean;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T | null> {
  const attempts = options.attempts ?? 4;
  // Backs off far enough to outlast a cold start without holding the field
  // empty while the relay is merely slow: 0.5s, 1s, 2s.
  const delayMs = options.delayMs ?? ((attempt: number) => 500 * 2 ** attempt);
  const cancelled = options.cancelled ?? (() => false);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (cancelled()) return null;
    try {
      const value = await read();
      if (value !== null && value !== undefined) return value;
    } catch {
      // A failed read is indistinguishable from an empty one here; both retry.
    }
    if (attempt < attempts - 1) await wait(delayMs(attempt));
  }
  return null;
}
