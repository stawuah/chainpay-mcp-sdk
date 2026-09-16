-- Only hashes of opaque bearer credentials are persisted.
CREATE TABLE owner_auth (
    key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    expires_at_ms BIGINT NOT NULL
);
CREATE INDEX owner_auth_expiry ON owner_auth(expires_at_ms);
-- Pre-PR01 pending enrollments did not validate future-PDA owner/mint/nonce binding.
UPDATE managed_signer_challenges SET expires_at_ms = 0 WHERE consumed_at_ms IS NULL;
