ALTER TABLE x402_payments
    ADD COLUMN IF NOT EXISTS proof JSONB,
    ADD COLUMN IF NOT EXISTS response_status INTEGER,
    ADD COLUMN IF NOT EXISTS error TEXT;

ALTER TABLE x402_payments
    DROP CONSTRAINT IF EXISTS x402_payments_status_check;

ALTER TABLE x402_payments
    ADD CONSTRAINT x402_payments_status_check
    CHECK (status IN ('prepared', 'submitted', 'confirmed', 'verified', 'failed'));
