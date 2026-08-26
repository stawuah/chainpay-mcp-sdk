ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS signing_mode TEXT NOT NULL DEFAULT 'human'
        CHECK (signing_mode IN ('human', 'delegated'));

CREATE TABLE IF NOT EXISTS managed_signer_challenges (
    challenge_id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL,
    mandate_pda TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL,
    consumed_at_ms BIGINT,
    created_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS managed_signer_challenges_owner_idx
    ON managed_signer_challenges (owner_wallet, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS managed_signers (
    signer_id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL,
    public_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL CHECK (provider IN ('privy')),
    provider_wallet_id TEXT NOT NULL,
    provider_policy_id TEXT NOT NULL,
    mandate_pda TEXT NOT NULL UNIQUE,
    signing_mode TEXT NOT NULL DEFAULT 'delegated'
        CHECK (signing_mode = 'delegated'),
    status TEXT NOT NULL
        CHECK (status IN ('provisioning', 'active', 'suspended', 'revoked')),
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    revoked_at_ms BIGINT,
    UNIQUE (provider, provider_wallet_id)
);

CREATE INDEX IF NOT EXISTS managed_signers_owner_idx
    ON managed_signers (owner_wallet, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS managed_signers_active_mandate_idx
    ON managed_signers (mandate_pda)
    WHERE status IN ('provisioning', 'active');
