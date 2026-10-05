-- Owner webhooks (docs/guides/owner-webhooks.md): ChainPay-to-owner
-- notifications about verified state. Nothing here can create, change or
-- fail a payment.
--
-- An owner's HTTPS endpoint. `secrets` holds AES-GCM envelopes sealed by the
-- relay (OWNER_WEBHOOKS_SECRET_KEY_<KID>); no plaintext secret is stored.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    subscription_id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    secrets JSONB NOT NULL,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_owner_idx
    ON webhook_subscriptions (owner_wallet, status, created_at_ms);

-- The outbox. Written in the same transaction that moves a payment (or batch
-- transaction) to 'confirmed'. One row per receipt, type and version; `body`
-- is the exact JSON every attempt sends and signs.
CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL,
    event_type TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    receipt_address TEXT NOT NULL,
    body TEXT NOT NULL,
    occurred_at_ms BIGINT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    UNIQUE (receipt_address, event_type, version)
);

-- One row per event and subscription. A dispatcher leases due rows
-- (`lease_token`, `lease_expires_at_ms`); a 'delivering' row whose lease ended
-- is due again at `next_attempt_at_ms`, so a crash never loses an event.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES webhook_events (event_id),
    subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions (subscription_id),
    owner_wallet TEXT NOT NULL,
    event_type TEXT NOT NULL,
    receipt_address TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'retry_scheduled', 'exhausted')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at_ms BIGINT NOT NULL,
    lease_token TEXT,
    lease_expires_at_ms BIGINT,
    last_status INTEGER CHECK (last_status IS NULL OR last_status BETWEEN 100 AND 599),
    last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 200),
    delivered_at_ms BIGINT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    UNIQUE (event_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
    ON webhook_deliveries (next_attempt_at_ms)
    WHERE state IN ('pending', 'retry_scheduled', 'delivering');

CREATE INDEX IF NOT EXISTS webhook_deliveries_history_idx
    ON webhook_deliveries (owner_wallet, subscription_id, created_at_ms DESC);

-- The reconcile pass pages confirmed rows by update time.
CREATE INDEX IF NOT EXISTS payments_confirmed_updated_idx
    ON payments (updated_at_ms) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS transactions_confirmed_updated_idx
    ON transactions (updated_at_ms) WHERE status = 'confirmed';
