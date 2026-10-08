import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { world as petWorld, actionResult as petResult } from "./petValidators";

// Record JSON is deliberately opaque: JavaScript must never round u64 values,
// nested x402 proof numbers, or signed statements while persisting them.
export const kind = v.union(v.literal("payments"), v.literal("transactions"), v.literal("x402_payments"), v.literal("managed_signer_challenges"), v.literal("managed_signers"), v.literal("delivery_attestations"), v.literal("receipt_requests"), v.literal("observed_policies"), v.literal("mandate_requests"), v.literal("cards"), v.literal("card_events"), v.literal("card_statements"), v.literal("card_recovery"));
const statusComponent = v.union(v.literal("web"), v.literal("relay"), v.literal("mcp"), v.literal("solana"), v.literal("program"));
export default defineSchema({
  // Public status page: raw checks kept 7 days, daily rollups ~95 days, incidents written by hand.
  status_checks: defineTable({ component: statusComponent, state: v.union(v.literal("up"), v.literal("degraded"), v.literal("down")), latencyMs: v.number(), detail: v.optional(v.string()), at: v.number() })
    .index("by_component_at", ["component", "at"]).index("by_at", ["at"]),
  status_days: defineTable({ component: statusComponent, day: v.string(), total: v.number(), up: v.number(), degraded: v.number(), down: v.number() })
    .index("by_component_day", ["component", "day"]).index("by_day", ["day"]),
  status_incidents: defineTable({
    title: v.string(), impact: v.union(v.literal("minor"), v.literal("major")), components: v.array(statusComponent),
    updates: v.array(v.object({ at: v.number(), state: v.union(v.literal("investigating"), v.literal("identified"), v.literal("monitoring"), v.literal("resolved")), message: v.string() })),
    startedAt: v.number(), resolvedAt: v.union(v.number(), v.null()),
  }).index("by_started", ["startedAt"]).index("by_resolved", ["resolvedAt"]),
  pet_world: defineTable({ key: v.string(), world: petWorld }).index("by_key", ["key"]),
  pet_sessions: defineTable({tokenHash:v.string(),peerHash:v.string(),expiresAt:v.number(),cooldowns:v.record(v.string(),v.number())}).index("by_token",["tokenHash"]).index("by_expires",["expiresAt"]),
  pet_commands: defineTable({tokenHash:v.string(),commandId:v.string(),action:v.string(),result:petResult,expiresAt:v.number()}).index("by_token_command",["tokenHash","commandId"]).index("by_expires",["expiresAt"]),
  pet_contributions: defineTable({tokenHash:v.string(),activity:v.string(),day:v.number(),at:v.number()}).index("by_token_activity_day",["tokenHash","activity","day"]).index("by_at",["at"]),
  pet_activity_days: defineTable({day:v.number(),activity:v.string(),count:v.number()}).index("by_day_activity",["day","activity"]),
  pet_memories: defineTable({key:v.string(),at:v.number(),cursor:v.number(),kind:v.string(),text:v.string()}).index("by_key",["key"]).index("by_cursor",["cursor"]),
  pet_aggregates: defineTable({day:v.number(),counts:v.record(v.string(),v.number())}).index("by_day",["day"]),
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
  // Support page tracker: one row per contribution/payout found in a vault transaction.
  support_events: defineTable({ signature: v.string(), index: v.number(), slot: v.number(), blockTime: v.union(v.number(), v.null()), kind: v.union(v.literal("contribution"), v.literal("payout"), v.literal("funding"), v.literal("anomaly")), asset: v.union(v.literal("SOL"), v.literal("USDC")), amount: v.string(), donor: v.union(v.string(), v.null()), note: v.union(v.string(), v.null()), side: v.union(v.literal("A"), v.literal("B"), v.null()) }).index("by_signature", ["signature"]).index("by_slot", ["slot"]),
  support_cursors: defineTable({ account: v.string(), cursor: v.object({ newest: v.union(v.string(), v.null()), pending: v.union(v.object({ top: v.string(), before: v.string() }), v.null()) }) }).index("by_account", ["account"]),
  rate_limits: defineTable({ key: v.string(), count: v.number(), expires: v.number() }).index("by_key", ["key"]).index("by_expires", ["expires"]),
  // Live payment cards (mcp-server/src/payment-flows.ts): what the card shows, for 24 hours. No tokens or keys.
  payment_flows: defineTable({ flowId: v.string(), wallet: v.string(), record_json: v.string(), expires: v.number() }).index("by_flow", ["flowId"]).index("by_expires", ["expires"]),
  // Owner webhooks (convex/webhooks.ts). Secrets are AES-GCM envelopes sealed by Axum.
  webhook_subscriptions: defineTable({ subscription_id: v.string(), owner_wallet: v.string(), url: v.string(), description: v.union(v.string(), v.null()), status: v.union(v.literal("active"), v.literal("disabled")), secrets_json: v.string(), created_at_ms: v.number(), updated_at_ms: v.number() })
    .index("by_subscription_id", ["subscription_id"]).index("by_owner_created", ["owner_wallet", "created_at_ms"]),
  webhook_events: defineTable({ event_id: v.string(), owner_wallet: v.string(), event_type: v.string(), version: v.number(), receipt_address: v.string(), body: v.string(), occurred_at_ms: v.number(), created_at_ms: v.number() })
    .index("by_event_id", ["event_id"]).index("by_receipt_type_version", ["receipt_address", "event_type", "version"]),
  webhook_deliveries: defineTable({
    delivery_id: v.string(), event_id: v.string(), subscription_id: v.string(), owner_wallet: v.string(), event_type: v.string(), receipt_address: v.string(),
    state: v.union(v.literal("pending"), v.literal("delivering"), v.literal("delivered"), v.literal("retry_scheduled"), v.literal("exhausted")),
    attempts: v.number(), next_attempt_at_ms: v.number(), lease_token: v.union(v.string(), v.null()), lease_expires_at_ms: v.union(v.number(), v.null()),
    last_status: v.union(v.number(), v.null()), last_error: v.union(v.string(), v.null()), delivered_at_ms: v.union(v.number(), v.null()), created_at_ms: v.number(), updated_at_ms: v.number(),
  }).index("by_delivery_id", ["delivery_id"]).index("by_state_next", ["state", "next_attempt_at_ms"])
    .index("by_subscription_created", ["subscription_id", "created_at_ms"]).index("by_subscription_state", ["subscription_id", "state"]),
});
