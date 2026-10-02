-- The mandate request (purchase order or budget request) an owner accepted,
-- keyed by mandate PDA. One key and one JSON value, first write wins, never
-- updated, so it maps onto a generic records table as kind 'mandate_requests'.
-- The record holds the requester-signed request, its SHA-256, the owner wallet
-- the relay verified on chain, and whether the owner's limits differ from the
-- request. It is private: only the owner session can read it.
CREATE TABLE IF NOT EXISTS mandate_requests (
    mandate_pda TEXT PRIMARY KEY,
    record JSONB NOT NULL,
    created_at_ms BIGINT NOT NULL
);
