// Shared by convex/status.ts (writes) and frontend/src/status (reads). Pure: no I/O.

export const STATUS_COMPONENTS = [
  { id: "web", name: "Website", description: "ChainPay web app and dashboard" },
  { id: "relay", name: "Payment relay", description: "Prepares and submits payments" },
  { id: "mcp", name: "MCP server", description: "Agent tools for Claude, Cursor and other MCP apps" },
  { id: "solana", name: "Solana devnet", description: "The network payments settle on" },
  { id: "program", name: "ChainPay program", description: "On-chain spending rules" },
] as const;

export type ComponentId = (typeof STATUS_COMPONENTS)[number]["id"];
export type CheckState = "up" | "degraded" | "down";
export type DayLevel = "operational" | "degraded" | "partial" | "major" | "gaps" | "none";
export type Overall = "operational" | "degraded" | "partial" | "major" | "unknown";

export const HISTORY_DAYS = 90;
export const SLOW_MS = 3_000;
export const TIMEOUT_MS = 10_000;
/** A check older than this means the prober itself stopped. */
export const STALE_MS = 20 * 60_000;
/** The cron in convex/crons.ts runs the probe every 5 minutes. */
export const CHECK_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** A day with fewer than this share of its expected checks is "partial data", never green. */
export const MIN_COVERAGE = 0.9;

export type DayCounts = { total: number; up: number; degraded: number; down: number };

export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Checks the prober should have run on `day` by `now`: 288 for a past day, the elapsed share of today. */
export function expectedChecks(day: string, now: number): number {
  const start = Date.parse(`${day}T00:00:00Z`);
  return Math.max(0, Math.min(DAY_MS / CHECK_INTERVAL_MS, Math.floor((now - start) / CHECK_INTERVAL_MS)));
}

/** Share of the window's expected checks that actually ran. Missing time is unknown, not up. */
export function coverage(keys: readonly string[], days: ReadonlyMap<string, DayCounts>, now: number): number | null {
  let expected = 0;
  let observed = 0;
  for (const key of keys) {
    const want = expectedChecks(key, now);
    expected += want;
    observed += Math.min(want, days.get(key)?.total ?? 0);
  }
  return expected === 0 ? null : observed / expected;
}

/** Up time counts slow-but-working checks as up, the way public status pages do. Only observed checks count. */
export function uptimeRatio(days: readonly DayCounts[]): number | null {
  const total = days.reduce((sum, d) => sum + d.total, 0);
  if (total === 0) return null;
  const up = days.reduce((sum, d) => sum + d.up + d.degraded, 0);
  return up / total;
}

/** `expected` is how many checks should have run that day (see `expectedChecks`). */
export function dayLevel(day: DayCounts | undefined, expected = DAY_MS / CHECK_INTERVAL_MS): DayLevel {
  if (!day || day.total === 0) return "none";
  const downShare = day.down / day.total;
  if (downShare >= 0.05) return "major";
  if (day.down > 0) return "partial";
  // Outages seen are reported above; a day mostly unobserved is never graded as fine.
  if (day.total < Math.floor(expected * MIN_COVERAGE)) return "gaps";
  if (day.degraded > 0) return "degraded";
  return "operational";
}

type Current = { state: CheckState | null; at: number | null };

/** A component's state now: a missing or stale check is unknown, never its last state. */
export function currentState(row: Current | undefined, now: number): CheckState | "unknown" {
  if (!row || row.state === null || row.at === null || now - row.at > STALE_MS) return "unknown";
  return row.state;
}

export function overallState(current: readonly Current[], now: number): Overall {
  const states = current.map((c) => currentState(c, now));
  // A fresh outage is known even while another component is unknown; "operational" needs every component fresh.
  const down = states.filter((s) => s === "down").length;
  if (down >= 2) return "major";
  if (down === 1) return "partial";
  if (states.length === 0 || states.includes("unknown")) return "unknown";
  if (states.includes("degraded")) return "degraded";
  return "operational";
}

/** Last `count` UTC day keys, oldest first, ending today. */
export function recentDays(now: number, count = HISTORY_DAYS): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: count }, (_, i) => dayKey(today - (count - 1 - i) * 86_400_000));
}
