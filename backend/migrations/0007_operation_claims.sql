-- Immutable reservation exists before signing, provisioning, or broadcasting.
CREATE TABLE operation_claims (
 operation_id TEXT PRIMARY KEY,
 owner_wallet TEXT NOT NULL,
 intent JSONB NOT NULL,
 initial_record JSONB NOT NULL
);
-- No historical owner backfill: pre-authentication idempotency keys are caller
-- controlled and cannot establish provenance. Legacy reads retain on-chain or
-- trusted transaction-owner authorization; legacy IDs cannot be re-executed.
