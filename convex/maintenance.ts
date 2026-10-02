import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { fail, json, metadata } from "./records";

// Run on an existing Convex database before enabling the combined release.
// Fresh imports already populate the new connector indexes.
export const backfillConnectorIndexes = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    if (process.env.CHAINPAY_MAINTENANCE !== "true") return fail("maintenance", "Backfill requires paused writes");
    const page = await ctx.db.query("records").withIndex("by_kind_key", q => q.eq("kind", "x402_payments")).paginate({ cursor, numItems: 100, maximumBytesRead: 2_000_000 });
    for (const row of page.page) await ctx.db.patch(row._id, metadata("x402_payments", json(row.record_json)));
    return { cursor: page.continueCursor, done: page.isDone };
  },
});
