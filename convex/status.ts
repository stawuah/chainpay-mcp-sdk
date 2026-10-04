import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { HISTORY_DAYS, SLOW_MS, STATUS_COMPONENTS, TIMEOUT_MS, dayKey, recentDays, type CheckState, type ComponentId } from "../shared/status";

const DAY_MS = 86_400_000;
const RAW_KEEP_MS = 7 * DAY_MS;
const PROGRAM_ID = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";

const componentId = v.union(...STATUS_COMPONENTS.map((c) => v.literal(c.id)));
const checkState = v.union(v.literal("up"), v.literal("degraded"), v.literal("down"));
const incidentState = v.union(v.literal("investigating"), v.literal("identified"), v.literal("monitoring"), v.literal("resolved"));

function urls() {
  return {
    web: process.env.STATUS_WEB_URL ?? "https://chainpay-web-kappa.vercel.app",
    relay: process.env.STATUS_RELAY_URL ?? "https://chainpay-relay.vercel.app",
    mcp: process.env.STATUS_MCP_URL ?? "https://chainpay-mcp.vercel.app",
    rpc: process.env.STATUS_SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    program: process.env.STATUS_PROGRAM_ID ?? PROGRAM_ID,
  };
}

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

async function healthz(base: string) {
  const response = await fetch(`${base.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { status?: string };
  if (body.status !== "ok") throw new Error(`status ${String(body.status)}`);
}

/** The check could not get an answer, so it says nothing about the component itself. */
class NoAnswer extends Error {}

// Each check throws on failure; timing and retry live in `measure`.
const CHECKS: Record<ComponentId, (u: ReturnType<typeof urls>) => Promise<void>> = {
  web: async (u) => {
    const response = await fetch(u.web, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  },
  relay: (u) => healthz(u.relay),
  mcp: (u) => healthz(u.mcp),
  solana: async (u) => {
    if (await rpc(u.rpc, "getHealth", []) !== "ok") throw new Error("node unhealthy");
  },
  // Shares the devnet RPC with `solana`: an RPC outage is solana's, not the program's.
  // Only an RPC answer saying the account is missing or not executable marks it down.
  program: async (u) => {
    let result: { value?: { executable?: boolean } | null };
    try {
      result = await rpc(u.rpc, "getAccountInfo", [u.program, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]) as typeof result;
    } catch (error) {
      throw new NoAnswer(error instanceof Error ? error.message : "RPC unreachable");
    }
    if (!result?.value?.executable) throw new Error("program account missing or not executable");
  },
};

type Result = { component: ComponentId; state: CheckState; latencyMs: number; detail?: string };

/** `null` when the check got no answer about this component: no row, so the page shows a gap, not up or down. */
async function measure(id: ComponentId, u: ReturnType<typeof urls>): Promise<Result | null> {
  let detail = "";
  let unanswered = false;
  // Latency includes a failed first attempt, so a timeout then a retry reads as slow, not fast.
  const started = Date.now();
  // One retry so a single dropped request or cold start doesn't paint a red bar.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await CHECKS[id](u);
      const latencyMs = Date.now() - started;
      return { component: id, state: latencyMs > SLOW_MS ? "degraded" : "up", latencyMs };
    } catch (error) {
      detail = error instanceof Error ? error.message.slice(0, 200) : "check failed";
      unanswered = error instanceof NoAnswer;
    }
  }
  return unanswered ? null : { component: id, state: "down", latencyMs: TIMEOUT_MS, detail };
}

export const probe = internalAction({
  args: {}, returns: v.null(),
  handler: async (ctx) => {
    if (process.env.CHAINPAY_MAINTENANCE === "true") return null;
    const u = urls();
    const results = (await Promise.all(STATUS_COMPONENTS.map((c) => measure(c.id, u)))).filter((r): r is Result => r !== null);
    await ctx.runMutation(internal.status.record, { at: Date.now(), results });
    return null;
  },
});

export const record = internalMutation({
  args: { at: v.number(), results: v.array(v.object({ component: componentId, state: checkState, latencyMs: v.number(), detail: v.optional(v.string()) })) },
  returns: v.null(),
  handler: async (ctx, { at, results }) => {
    const day = dayKey(at);
    for (const result of results) {
      await ctx.db.insert("status_checks", { ...result, at });
      const existing = await ctx.db.query("status_days").withIndex("by_component_day", (q) => q.eq("component", result.component).eq("day", day)).unique();
      const counts = existing ?? { total: 0, up: 0, degraded: 0, down: 0 };
      const next = { total: counts.total + 1, up: counts.up, degraded: counts.degraded, down: counts.down };
      next[result.state] += 1;
      if (existing) await ctx.db.patch(existing._id, next);
      else await ctx.db.insert("status_days", { component: result.component, day, ...next });
    }
    const oldChecks = await ctx.db.query("status_checks").withIndex("by_at", (q) => q.lt("at", at - RAW_KEEP_MS)).take(200);
    const oldDays = await ctx.db.query("status_days").withIndex("by_day", (q) => q.lt("day", dayKey(at - (HISTORY_DAYS + 5) * DAY_MS))).take(200);
    for (const row of [...oldChecks, ...oldDays]) await ctx.db.delete(row._id);
    return null;
  },
});

export const summary = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const days = recentDays(now);
    const components = await Promise.all(STATUS_COMPONENTS.map(async (c) => {
      const latest = await ctx.db.query("status_checks").withIndex("by_component_at", (q) => q.eq("component", c.id)).order("desc").first();
      const history = await ctx.db.query("status_days").withIndex("by_component_day", (q) => q.eq("component", c.id).gte("day", days[0])).collect();
      return {
        id: c.id,
        state: latest?.state ?? null,
        at: latest?.at ?? null,
        latencyMs: latest?.latencyMs ?? null,
        days: history.map(({ day, total, up, degraded, down }) => ({ day, total, up, degraded, down })),
      };
    }));
    // Open incidents are always shown, however many newer ones exist; resolved ones for 14 days.
    const open = await ctx.db.query("status_incidents").withIndex("by_resolved", (q) => q.eq("resolvedAt", null)).collect();
    const recent = await ctx.db.query("status_incidents").withIndex("by_resolved", (q) => q.gt("resolvedAt", now - 14 * DAY_MS)).order("desc").take(20);
    const incidents = [...open, ...recent].sort((a, b) => b.startedAt - a.startedAt)
      .map(({ _id, title, impact, components, updates, startedAt, resolvedAt }) => ({ id: _id, title, impact, components, updates, startedAt, resolvedAt }));
    return { generatedAt: now, components, incidents };
  },
});

// Incidents are written by a person: `npx convex run status:openIncident '{...}'`.
export const openIncident = internalMutation({
  args: { title: v.string(), impact: v.union(v.literal("minor"), v.literal("major")), components: v.array(componentId), message: v.string() },
  handler: async (ctx, { title, impact, components, message }) => {
    const at = Date.now();
    return ctx.db.insert("status_incidents", { title, impact, components, startedAt: at, resolvedAt: null, updates: [{ at, state: "investigating", message }] });
  },
});

export const updateIncident = internalMutation({
  args: { id: v.id("status_incidents"), state: incidentState, message: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, state, message }) => {
    const incident = await ctx.db.get(id);
    if (!incident) throw new Error("Incident not found");
    const at = Date.now();
    await ctx.db.patch(id, { updates: [...incident.updates, { at, state, message }], resolvedAt: state === "resolved" ? at : null });
    return null;
  },
});
