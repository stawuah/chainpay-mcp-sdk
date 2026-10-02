import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Record JSON is deliberately opaque: JavaScript must never round u64 values,
// nested x402 proof numbers, or signed statements while persisting them.
export const kind = v.union(v.literal("payments"), v.literal("transactions"), v.literal("x402_payments"), v.literal("managed_signer_challenges"), v.literal("managed_signers"), v.literal("delivery_attestations"), v.literal("receipt_requests"), v.literal("observed_policies"), v.literal("mandate_requests"));
export default defineSchema({
  records: defineTable({
    kind, key: v.string(), record_json: v.string(), source_json: v.optional(v.string()),
    idempotency: v.optional(v.string()), receipt: v.optional(v.string()),
    connector: v.optional(v.string()), reference: v.optional(v.string()),
    owner: v.optional(v.string()), mandate: v.optional(v.string()),
    public_key: v.optional(v.string()), provider_wallet: v.optional(v.string()),
    // Zero-padded decimal strings sort full u64 timestamps without floating point.
    updated: v.string(),
  }).index("by_kind_key", ["kind", "key"])
    .index("by_kind_idempotency", ["kind", "idempotency"])
    .index("by_kind_receipt_updated", ["kind", "receipt", "updated"])
    .index("by_kind_owner_updated", ["kind", "owner", "updated"])
    .index("by_kind_owner_mandate_updated", ["kind", "owner", "mandate", "updated"])
    .index("by_kind_owner_connector_updated", ["kind", "owner", "connector", "updated"])
    .index("by_kind_owner_connector_reference", ["kind", "owner", "connector", "reference", "updated"])
    .index("by_kind_public_key", ["kind", "public_key"])
    .index("by_kind_mandate", ["kind", "mandate"])
    .index("by_kind_provider_wallet", ["kind", "provider_wallet"]),
  operation_claims: defineTable({ key: v.string(), owner: v.string(), intent_json: v.string(), initial_json: v.string(), source_json: v.optional(v.string()) }).index("by_key", ["key"]),
  owner_auth: defineTable({ key: v.string(), value_json: v.string(), expires: v.string(), source_json: v.optional(v.string()) }).index("by_key", ["key"]).index("by_expires", ["expires"]),
  agent_connections: defineTable({
    id: v.string(), tokenHash: v.string(), wallet: v.string(), agentName: v.string(), scope: v.string(), connectedAt: v.string(), lastSeenAt: v.union(v.string(), v.null()), totalCalls: v.number(),
    toolsCalled: v.array(v.object({ name: v.string(), count: v.number(), lastCalledAt: v.string() })), revokedAt: v.union(v.string(), v.null()), source_json: v.optional(v.string()),
  }).index("by_external_id", ["id"]).index("by_token", ["tokenHash"]).index("by_wallet_revoked_created", ["wallet", "revokedAt", "connectedAt"]),
  inbox_messages: defineTable({ id: v.string(), wallet: v.string(), role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool")), content_json: v.string(), createdAt: v.string(), source_json: v.optional(v.string()) }).index("by_external_id", ["id"]).index("by_wallet_created", ["wallet", "createdAt"]),
  rate_limits: defineTable({ key: v.string(), count: v.number(), expires: v.number() }).index("by_key", ["key"]).index("by_expires", ["expires"]),
});
