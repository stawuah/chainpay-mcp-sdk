ALTER TABLE agent_connections
    ADD COLUMN IF NOT EXISTS total_calls BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tools_called JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE agent_connections
    ALTER COLUMN last_seen_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS agent_connections_active_token_idx
    ON agent_connections (token_hash)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS inbox_messages_wallet_role_created_idx
    ON inbox_messages (wallet_address, role, created_at DESC);
