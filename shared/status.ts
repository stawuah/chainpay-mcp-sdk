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
export type DayLevel = "operational" | "degraded" | "partial" | "major" | "none";
export type Overall = "operational" | "degraded" | "partial" | "major" | "unknown";

export const HISTORY_DAYS = 90;
export const SLOW_MS = 3_000;
export const TIMEOUT_MS = 10_000;
/** A check older than this means the prober itself stopped. */
export const STALE_MS = 20 * 60_000;

export type DayCounts = { total: number; up: number; degraded: number; down: number };

export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Up time counts slow-but-working checks as up, the way public status pages do. */
export function uptimeRatio(days: readonly DayCounts[]): number | null {
  const total = days.reduce((sum, d) => sum + d.total, 0);
  if (total === 0) return null;
  const up = days.reduce((sum, d) => sum + d.up + d.degraded, 0);
  return up / total;
}

export function dayLevel(day: DayCounts | undefined): DayLevel {
  if (!day || day.total === 0) return "none";
  const downShare = day.down / day.total;
  if (downShare >= 0.05) return "major";
  if (day.down > 0) return "partial";
  if (day.degraded > 0) return "degraded";
  return "operational";
}

export function overallState(current: readonly { state: CheckState | null; at: number | null }[], now: number): Overall {
  if (current.length === 0 || current.some((c) => c.state === null || c.at === null || now - c.at > STALE_MS)) return "unknown";
  const down = current.filter((c) => c.state === "down").length;
  if (down >= 2) return "major";
  if (down === 1) return "partial";
  if (current.some((c) => c.state === "degraded")) return "degraded";
  return "operational";
}

/** Last `count` UTC day keys, oldest first, ending today. */
export function recentDays(now: number, count = HISTORY_DAYS): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: count }, (_, i) => dayKey(today - (count - 1 - i) * 86_400_000));
}
