CREATE TABLE IF NOT EXISTS payments (
    payment_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    mandate TEXT NOT NULL,
    invoice_hash TEXT NOT NULL,
    receipt_address TEXT,
    agent TEXT,
    mint TEXT,
    recipient TEXT,
    amount NUMERIC(20, 0),
    token_program TEXT,
    signature TEXT,
    slot BIGINT,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'confirmed', 'failed')),
    simulation JSONB,
    error TEXT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_mandate_idx ON payments (mandate);
CREATE INDEX IF NOT EXISTS payments_receipt_address_idx ON payments (receipt_address);
CREATE INDEX IF NOT EXISTS payments_signature_idx ON payments (signature);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    signature TEXT,
    slot BIGINT,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'confirmed', 'failed')),
    simulation JSONB,
    error TEXT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transactions_signature_idx ON transactions (signature);

CREATE TABLE IF NOT EXISTS agent_connections (
    connection_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    scope TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_connections_wallet_idx ON agent_connections (wallet_address);

CREATE TABLE IF NOT EXISTS inbox_messages (
    message_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inbox_messages_wallet_created_idx
    ON inbox_messages (wallet_address, created_at DESC);

CREATE TABLE IF NOT EXISTS x402_payments (
    x402_payment_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    resource TEXT NOT NULL,
    payment_id TEXT REFERENCES payments(payment_id) ON DELETE SET NULL,
    receipt_address TEXT,
    transaction_signature TEXT,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'confirmed', 'failed')),
    challenge JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x402_payments_receipt_idx ON x402_payments (receipt_address);
