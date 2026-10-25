-- Only applied by the isolated PayPal store to a chainpay_paypal_* database.
CREATE TABLE IF NOT EXISTS paypal_sessions (
    token_hash TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('buyer', 'merchant', 'agent')),
    expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS paypal_tasks (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    principal TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    record JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE (workspace, principal, request_id)
);
CREATE INDEX IF NOT EXISTS paypal_tasks_workspace_created ON paypal_tasks(workspace, created_at DESC, id);
CREATE TABLE IF NOT EXISTS paypal_webhook_inbox (
    id TEXT PRIMARY KEY,
    event JSONB NOT NULL,
    received_at BIGINT NOT NULL,
    processed_at BIGINT
);
CREATE TABLE IF NOT EXISTS paypal_rate_windows (
    identity TEXT NOT NULL,
    window_id BIGINT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (identity, window_id)
);

ALTER TABLE paypal_webhook_inbox ADD COLUMN IF NOT EXISTS attempted_at BIGINT;
