import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { sorted } from "./records";

export const expiredCredentials = internalMutation({
  args: {}, returns: v.number(),
  handler: async (ctx) => {
    // Keep the source frozen throughout migration verification and rollback.
    if (process.env.CHAINPAY_MAINTENANCE === "true") return 0;
    const now = Date.now();
    const auth = await ctx.db.query("owner_auth").withIndex("by_expires", q => q.lte("expires", sorted(now))).take(500);
    const rates = await ctx.db.query("rate_limits").withIndex("by_expires", q => q.lte("expires", now)).take(500);
    for (const row of [...auth, ...rates]) await ctx.db.delete(row._id);
    return auth.length + rates.length;
  },
});
