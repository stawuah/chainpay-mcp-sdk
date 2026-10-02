-- Connector jobs share the x402 job table: a row is one external payment
-- obligation, its settled proof, and the response the external side gave.
-- Existing rows predate connector naming and are x402 jobs, so the column
-- defaults to 'x402' and no backfill is required.
ALTER TABLE x402_payments
    ADD COLUMN IF NOT EXISTS connector TEXT NOT NULL DEFAULT 'x402',
    ADD COLUMN IF NOT EXISTS connector_reference TEXT;

ALTER TABLE x402_payments
    DROP CONSTRAINT IF EXISTS x402_payments_connector_check;

ALTER TABLE x402_payments
    ADD CONSTRAINT x402_payments_connector_check
    CHECK (connector IN ('x402', 'crossmint'));

CREATE INDEX IF NOT EXISTS x402_payments_connector_idx ON x402_payments (connector);

-- One Crossmint order can be looked up without scanning: the guard against
-- paying the same order twice reads this row before preparing a payment.
CREATE INDEX IF NOT EXISTS x402_payments_connector_reference_idx
    ON x402_payments (connector, connector_reference);
