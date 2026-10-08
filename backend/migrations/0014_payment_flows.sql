-- Live payment cards for the MCP server (mcp-server/src/payment-flows.ts).
-- Each row holds only what the card shows, for 24 hours. No tokens or keys.
CREATE TABLE IF NOT EXISTS payment_flows (
    flow_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    record JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS payment_flows_expires_idx ON payment_flows (expires_at);
